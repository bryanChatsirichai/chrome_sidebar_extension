import { useCallback, useEffect, useRef, useState } from 'react';
import { GX_DEFAULTS, gxClamp } from '../lib/defaults';
import { parsePinUrl, reindexPins, resolveIconUrl, getCurrentPagePinDefaults } from '../lib/pin-utils';
import type { Pin, Settings } from '../lib/types';
import { IconStrip } from './components/IconStrip';
import { AppPanel } from './components/AppPanel';
import { SettingsPanel } from './components/SettingsPanel';
import { applyLayoutClasses, setCssVariables } from './sidebarUtils';

const EMBED_BLOCKED_PATTERN =
  /refused to connect|content is blocked|contact the site owner|can't be embedded|cannot be displayed|x-frame-options|frame-ancestors|failed to load|err_blocked_by|err_name_not_resolved|err_connection_refused|err_address_unreachable|err_cert_|err_timed_out/i;

const IFRAME_VERIFY_MAX_ATTEMPTS = 1;
const IFRAME_VERIFY_RETRY_MS = 100;
/**
 * Poll interval for frames whose load event fired while still on about:blank.
 * The navigation is either mid-commit (heavy sites such as chatgpt.com can
 * take seconds to commit) or permanently blocked. The poll never fails on its
 * own: a real commit flips the href, a pin change cancels via a generation
 * bump, and the IFRAME_LOAD_TIMEOUT_MS net declares failure — failing from
 * here used to misclassify slow-but-healthy embeds as blocked.
 */
const IFRAME_STALL_RETRY_MS = 250;
/** Post-success watchdog window that catches late-committed error pages. */
const IFRAME_WATCHDOG_DURATION_MS = 4000;
const IFRAME_WATCHDOG_INTERVAL_MS = 500;
/**
 * Chrome/site error pages have a tiny body; real site content is longer.
 * Error checks only fire for near-empty frames so live page content (or
 * inline scripts) mentioning phrases like "failed to load" never triggers a
 * false embed failure.
 */
const IFRAME_ERROR_PAGE_MAX_TEXT_LENGTH = 250;

export type PanelView = 'idle' | 'loading' | 'iframe' | 'fallback';

interface SidebarAppProps {
  initialPins: Pin[];
  initialSettings: Settings;
  initialActivePinId: string | null;
  initialSidebarHidden: boolean;
  initialPanelWidth: number;
  /** Session-global panel state: the panel reopens on new tabs/navigations. */
  initialPanelOpen: boolean;
}

export function SidebarApp({
  initialPins,
  initialSettings,
  initialActivePinId,
  initialSidebarHidden,
  initialPanelWidth,
  initialPanelOpen
}: SidebarAppProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const iframeLoadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const iframeVerifyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const iframeWatchdogTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const iframeVerifyGenerationRef = useRef(0);
  const embedFailureHandledRef = useRef(false);
  const draggedIndexRef = useRef<number | null>(null);

  const [pins, setPins] = useState(initialPins);
  const [settings, setSettings] = useState(initialSettings);
  const [activePinId, setActivePinId] = useState(initialActivePinId);
  const [panelOpen, setPanelOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sidebarHidden, setSidebarHidden] = useState(initialSidebarHidden);
  const [panelWidth, setPanelWidth] = useState(initialPanelWidth);
  const [panelView, setPanelView] = useState<PanelView>('idle');
  const [frameEpoch, setFrameEpoch] = useState(0);
  const [frameSrc, setFrameSrc] = useState('');
  const [fallbackPin, setFallbackPin] = useState<Pin | null>(null);
  const [editingPinId, setEditingPinId] = useState<string | null>(null);
  const [pinForm, setPinForm] = useState({ name: '', url: '', iconUrl: '' });
  const [resizeDragging, setResizeDragging] = useState(false);

  const panelOpenRef = useRef(panelOpen);
  const activePinIdRef = useRef(activePinId);
  const pinsRef = useRef(pins);
  const handlePinClickRef = useRef<(pin: Pin) => void>(() => {});

  panelOpenRef.current = panelOpen;
  activePinIdRef.current = activePinId;
  pinsRef.current = pins;

  /**
   * Persists the panel session to chrome.storage.session (shared by every tab
   * of this browser session). The background watches it and broadcasts
   * `panelStateSynced`, so the open/closed panel state follows the user
   * across tabs and survives same-tab navigations without reopening after a
   * browser restart.
   */
  const persistPanelSession = useCallback((open: boolean, pinId: string | null) => {
    try {
      void chrome.storage.session
        ?.set({ gxPanelOpen: open, gxPanelPinId: open ? pinId : null })
        .catch(() => {});
    } catch {
      // Session storage is unavailable until the background grants access.
    }
  }, []);

  const getActivePin = useCallback(
    (): Pin | null => pins.find((p) => p.id === activePinId) ?? null,
    [activePinId, pins]
  );

  const clearIframeTimer = useCallback(() => {
    if (iframeLoadTimerRef.current) {
      clearTimeout(iframeLoadTimerRef.current);
      iframeLoadTimerRef.current = null;
    }
  }, []);

  const clearIframeVerifyTimer = useCallback(() => {
    if (iframeVerifyTimerRef.current) {
      clearTimeout(iframeVerifyTimerRef.current);
      iframeVerifyTimerRef.current = null;
    }
  }, []);

  const clearIframeWatchdog = useCallback(() => {
    if (iframeWatchdogTimerRef.current) {
      clearTimeout(iframeWatchdogTimerRef.current);
      iframeWatchdogTimerRef.current = null;
    }
  }, []);

  const getIframeLocationHref = useCallback((): string | null => {
    try {
      return iframeRef.current?.contentWindow?.location?.href ?? '';
    } catch {
      return null;
    }
  }, []);

  /**
   * Strict error-page check. Unlike a broad text scan, it requires either a
   * chrome-error: location or a near-empty body, so live site content (or
   * inline scripts) mentioning phrases like "failed to load" never triggers a
   * false embed failure — e.g. when the panel shows the same site the user
   * is browsing and its DOM is readable.
   */
  const isIframeEmbedBlocked = useCallback((): boolean => {
    const href = getIframeLocationHref();
    if (typeof href === 'string' && href.startsWith('chrome-error:')) {
      return true;
    }

    try {
      const doc = iframeRef.current?.contentDocument;
      if (!doc) {
        return false;
      }
      const text = (doc.body?.innerText ?? '').trim();
      return (
        text.length > 0 &&
        text.length <= IFRAME_ERROR_PAGE_MAX_TEXT_LENGTH &&
        EMBED_BLOCKED_PATTERN.test(text)
      );
    } catch {
      return false;
    }
  }, [getIframeLocationHref]);

  const saveAndBroadcast = useCallback(
    async (nextPins: Pin[], nextSettings: Settings, width: number) => {
      const merged = { ...nextSettings, panelWidth: width };
      await chrome.storage.sync.set({ pins: nextPins, settings: merged });
      await chrome.runtime.sendMessage({
        action: 'broadcastPinsUpdated',
        pins: nextPins,
        settings: merged
      });
    },
    []
  );

  const openCompanionForPin = useCallback(
    async (pin: Pin) => {
      try {
        const response = await chrome.runtime.sendMessage({
          action: 'openCompanion',
          url: pin.url,
          pinId: pin.id,
          companionSettings: settings
        });

        if (!response?.ok) {
          console.error('[GX Sidebar] Companion panel failed:', response?.error ?? 'Unknown error');
          return response;
        }

        if (response.open) {
          setActivePinId(pin.id);
          activePinIdRef.current = pin.id;
        } else {
          setActivePinId(null);
          activePinIdRef.current = null;
        }

        return response;
      } catch (error) {
        console.error('[GX Sidebar] Companion panel failed:', error);
        return { ok: false, error: String(error) };
      }
    },
    [settings]
  );

  const showIframeLoaded = useCallback(() => {
    clearIframeTimer();
    clearIframeVerifyTimer();
    setPanelView('iframe');
    void chrome.runtime.sendMessage({ action: 'closeCompanion' }).catch(() => {});
  }, [clearIframeTimer, clearIframeVerifyTimer]);

  const showFallbackUI = useCallback(
    (pin: Pin) => {
      clearIframeTimer();
      clearIframeWatchdog();
      setFrameSrc('');
      setFallbackPin(pin);
      setPanelView('fallback');
    },
    [clearIframeTimer, clearIframeWatchdog]
  );

  /**
   * Embed failure now stays in the panel: the companion window is manual-only
   * (header button), never an automatic fallback.
   */
  const handleEmbedFailure = useCallback(
    (pin: Pin) => {
      if (embedFailureHandledRef.current) {
        return;
      }

      embedFailureHandledRef.current = true;
      iframeVerifyGenerationRef.current += 1;
      clearIframeTimer();
      clearIframeVerifyTimer();
      clearIframeWatchdog();
      showFallbackUI(pin);
    },
    [clearIframeTimer, clearIframeVerifyTimer, clearIframeWatchdog, showFallbackUI]
  );

  const openCompanionDirectly = useCallback(
    async (pin: Pin) => {
      if (panelOpenRef.current) {
        clearIframeTimer();
        clearIframeVerifyTimer();
        clearIframeWatchdog();
        iframeVerifyGenerationRef.current += 1;
        embedFailureHandledRef.current = true;
        setFrameSrc('');
        persistPanelSession(false, null);
        setPanelOpen(false);
        panelOpenRef.current = false;
        setPanelView('idle');
      }

      const response = await openCompanionForPin(pin);
      if (!response?.ok || !response.open) {
        persistPanelSession(true, pin.id);
        setPanelOpen(true);
        panelOpenRef.current = true;
        showFallbackUI(pin);
      }
      return response;
    },
    [clearIframeTimer, clearIframeVerifyTimer, clearIframeWatchdog, openCompanionForPin, persistPanelSession, showFallbackUI]
  );

  /**
   * Watches a successfully loaded frame for a short window afterwards.
   * Some blocked embeds commit an error page late (after the load event was
   * already treated as success); the watchdog detects that and shows the
   * in-panel fallback view instead of leaving a dead frame on screen.
   */
  const startIframeWatchdog = useCallback(
    (pin: Pin, generation: number) => {
      clearIframeWatchdog();
      const startedAt = Date.now();

      const poll = () => {
        iframeWatchdogTimerRef.current = null;

        if (
          generation !== iframeVerifyGenerationRef.current ||
          embedFailureHandledRef.current ||
          !panelOpenRef.current ||
          pin.id !== activePinIdRef.current
        ) {
          return;
        }

        if (Date.now() - startedAt >= IFRAME_WATCHDOG_DURATION_MS) {
          return;
        }

        if (isIframeEmbedBlocked()) {
          void handleEmbedFailure(pin);
          return;
        }

        iframeWatchdogTimerRef.current = setTimeout(poll, IFRAME_WATCHDOG_INTERVAL_MS);
      };

      iframeWatchdogTimerRef.current = setTimeout(poll, IFRAME_WATCHDOG_INTERVAL_MS);
    },
    [clearIframeWatchdog, handleEmbedFailure, isIframeEmbedBlocked]
  );

  const finalizeIframeSuccess = useCallback(
    (pin: Pin, generation: number) => {
      if (generation !== iframeVerifyGenerationRef.current) {
        return;
      }

      if (
        embedFailureHandledRef.current ||
        !panelOpenRef.current ||
        pin.id !== activePinIdRef.current
      ) {
        return;
      }

      showIframeLoaded();
      startIframeWatchdog(pin, generation);
    },
    [showIframeLoaded, startIframeWatchdog]
  );

  const verifyIframeEmbed = useCallback(
    (pin: Pin, attempt = 0, generation = iframeVerifyGenerationRef.current) => {
      if (generation !== iframeVerifyGenerationRef.current) {
        return;
      }

      const activePin = pins.find((p) => p.id === activePinId);
      if (!panelOpen || activePin?.id !== pin.id || embedFailureHandledRef.current) {
        return;
      }

      if (isIframeEmbedBlocked()) {
        handleEmbedFailure(pin);
        return;
      }

      const href = getIframeLocationHref();

      if (href === 'about:blank' || href === '') {
        // A load event fired while the frame is still on about:blank: either
        // the navigation is mid-commit (heavy sites can take several seconds
        // to commit) or the embed was blocked and never will. Keep polling —
        // a real commit flips the href, a pin change cancels via a generation
        // bump, and the load-timeout net declares failure for genuinely dead
        // embeds. Failing fast from here used to misclassify slow-but-healthy
        // embeds (e.g. chatgpt.com) as blocked.
        iframeVerifyTimerRef.current = setTimeout(
          () => verifyIframeEmbed(pin, attempt + 1, generation),
          IFRAME_STALL_RETRY_MS
        );
        return;
      }

      if (href === null) {
        if (attempt < IFRAME_VERIFY_MAX_ATTEMPTS) {
          iframeVerifyTimerRef.current = setTimeout(
            () => verifyIframeEmbed(pin, attempt + 1, generation),
            IFRAME_VERIFY_RETRY_MS
          );
          return;
        }
        finalizeIframeSuccess(pin, generation);
        return;
      }

      if (isIframeEmbedBlocked()) {
        handleEmbedFailure(pin);
        return;
      }

      finalizeIframeSuccess(pin, generation);
    },
    [
      activePinId,
      finalizeIframeSuccess,
      getIframeLocationHref,
      handleEmbedFailure,
      isIframeEmbedBlocked,
      panelOpen,
      pins
    ]
  );

  const startIframeVerification = useCallback(
    (pin: Pin) => {
      iframeVerifyGenerationRef.current += 1;
      const generation = iframeVerifyGenerationRef.current;
      clearIframeVerifyTimer();
      verifyIframeEmbed(pin, 0, generation);
    },
    [clearIframeVerifyTimer, verifyIframeEmbed]
  );

  /**
   * Opens the panel for a pin by remounting a pristine iframe. Reusing one
   * frame across cross-origin pins (even via an about:blank reset) made pin
   * switching flaky; a fresh frame per navigation is deterministic and skips
   * the reset round-trip entirely.
   */
  const openPanelForPin = useCallback(
    (pin: Pin) => {
      persistPanelSession(true, pin.id);
      embedFailureHandledRef.current = false;
      iframeVerifyGenerationRef.current += 1;
      setFallbackPin(null);
      setPanelView('loading');

      clearIframeTimer();
      clearIframeVerifyTimer();
      clearIframeWatchdog();

      void chrome.runtime.sendMessage({ action: 'closeCompanion' }).catch(() => {});

      setFrameSrc(pin.url);
      setFrameEpoch((epoch) => epoch + 1);

      iframeLoadTimerRef.current = setTimeout(() => {
        if (
          !embedFailureHandledRef.current &&
          panelOpenRef.current &&
          pin.id === activePinIdRef.current
        ) {
          handleEmbedFailure(pin);
        }
      }, GX_DEFAULTS.IFRAME_LOAD_TIMEOUT_MS);
    },
    [clearIframeTimer, clearIframeVerifyTimer, clearIframeWatchdog, handleEmbedFailure, persistPanelSession]
  );

  const closePanel = useCallback(() => {
    persistPanelSession(false, null);
    setPanelOpen(false);
    setPanelView('idle');
    embedFailureHandledRef.current = false;
    iframeVerifyGenerationRef.current += 1;
    clearIframeTimer();
    clearIframeVerifyTimer();
    clearIframeWatchdog();
    setFrameSrc('');
  }, [clearIframeTimer, clearIframeVerifyTimer, clearIframeWatchdog, persistPanelSession]);

  const handlePinClick = useCallback(
    (pin: Pin) => {
      if (settingsOpen) {
        setSettingsOpen(false);
      }

      if (activePinId === pin.id && panelOpen) {
        closePanel();
        return;
      }

      if (activePinId === pin.id && !panelOpen) {
        void chrome.runtime.sendMessage({ action: 'closeCompanion' }).then(() => {
          setActivePinId(null);
          activePinIdRef.current = null;
        });
        return;
      }

      setActivePinId(pin.id);
      activePinIdRef.current = pin.id;
      void chrome.runtime.sendMessage({ action: 'saveLastActivePin', pinId: pin.id });

      // Always try the in-page panel first — the background worker strips
      // iframe-blocking response headers for pinned domains (embed-bypass.ts).
      // Sites that still fail show the in-panel fallback view; the companion
      // window is manual-only (header button).
      setPanelOpen(true);
      panelOpenRef.current = true;
      openPanelForPin(pin);
    },
    [activePinId, closePanel, openPanelForPin, panelOpen, settingsOpen]
  );

  handlePinClickRef.current = handlePinClick;

  const handleIframeLoad = useCallback(() => {
    const pin = getActivePin();
    if (!pin || !panelOpen || embedFailureHandledRef.current) {
      return;
    }
    startIframeVerification(pin);
  }, [getActivePin, panelOpen, startIframeVerification]);

  const handleIframeError = useCallback(() => {
    const pin = getActivePin();
    if (pin && panelOpen && !embedFailureHandledRef.current) {
      handleEmbedFailure(pin);
    }
  }, [getActivePin, handleEmbedFailure, panelOpen]);

  const toggleSettings = useCallback(() => {
    if (settingsOpen) {
      setSettingsOpen(false);
      return;
    }
    closePanel();
    setSettingsOpen(true);
  }, [closePanel, settingsOpen]);

  const resetPinForm = useCallback(() => {
    setEditingPinId(null);
    setPinForm({ name: '', url: '', iconUrl: '' });
  }, []);

  const beginEditPin = useCallback((pin: Pin) => {
    setEditingPinId(pin.id);
    setPinForm({ name: pin.name, url: pin.url, iconUrl: pin.iconUrl });
  }, []);

  const pinCurrentPage = useCallback(() => {
    setEditingPinId(null);
    setPinForm(getCurrentPagePinDefaults());
  }, []);

  const isPinUrlDuplicate = useCallback(
    (url: string, excludePinId?: string | null): boolean => {
      const parsed = parsePinUrl(url);
      if (!parsed) {
        return false;
      }

      const normalized = parsed.href;
      return pins.some((pin) => {
        if (excludePinId && pin.id === excludePinId) {
          return false;
        }
        try {
          return new URL(pin.url).href === normalized;
        } catch {
          return false;
        }
      });
    },
    [pins]
  );

  const quickPinCurrentPage = useCallback(async () => {
    const defaults = getCurrentPagePinDefaults();
    const parsedUrl = parsePinUrl(defaults.url);

    if (!parsedUrl) {
      window.alert('This page cannot be pinned.');
      return;
    }

    if (isPinUrlDuplicate(parsedUrl.href)) {
      window.alert('This page is already pinned.');
      return;
    }

    const nextPins = [
      ...pins,
      {
        id: `custom-${Date.now()}`,
        name: defaults.name,
        url: parsedUrl.href,
        iconUrl: defaults.iconUrl,
        order: pins.length
      }
    ];

    resetPinForm();
    setPins(nextPins);
    await saveAndBroadcast(nextPins, settings, panelWidth);
  }, [isPinUrlDuplicate, panelWidth, pins, resetPinForm, saveAndBroadcast, settings]);

  const handleSavePin = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();
      const name = pinForm.name.trim();
      const url = pinForm.url.trim();
      const iconUrl = pinForm.iconUrl.trim();

      if (!name || !url) {
        return;
      }

      const parsedUrl = parsePinUrl(url);
      if (!parsedUrl) {
        window.alert('Please enter a valid URL (include https://).');
        return;
      }

      let nextPins: Pin[];
      let reloadActivePanel = false;

      if (editingPinId) {
        nextPins = pins.map((pin) =>
          pin.id === editingPinId
            ? { ...pin, name, url: parsedUrl.href, iconUrl }
            : pin
        );
        reloadActivePanel = activePinId === editingPinId && panelOpen;
      } else {
        nextPins = [
          ...pins,
          {
            id: `custom-${Date.now()}`,
            name,
            url: parsedUrl.href,
            iconUrl,
            order: pins.length
          }
        ];
      }

      resetPinForm();
      setPins(nextPins);
      await saveAndBroadcast(nextPins, settings, panelWidth);

      if (reloadActivePanel) {
        const updated = nextPins.find((p) => p.id === editingPinId);
        if (updated) {
          openPanelForPin(updated);
        }
      }
    },
    [
      activePinId,
      editingPinId,
      openPanelForPin,
      panelOpen,
      panelWidth,
      pinForm,
      pins,
      resetPinForm,
      saveAndBroadcast,
      settings
    ]
  );

  const handleDeletePin = useCallback(
    async (index: number) => {
      const pin = pins[index];
      if (editingPinId === pin.id) {
        resetPinForm();
      }
      if (activePinId === pin.id) {
        closePanel();
        setActivePinId(null);
      }
      const nextPins = reindexPins(pins.filter((_, i) => i !== index));
      setPins(nextPins);
      await saveAndBroadcast(nextPins, settings, panelWidth);
    },
    [activePinId, closePanel, editingPinId, panelWidth, pins, resetPinForm, saveAndBroadcast, settings]
  );

  const handleDropPin = useCallback(
    async (targetIndex: number) => {
      const fromIndex = draggedIndexRef.current;
      draggedIndexRef.current = null;
      if (fromIndex === null || fromIndex === targetIndex) {
        return;
      }
      const nextPins = pins.slice();
      const [moved] = nextPins.splice(fromIndex, 1);
      nextPins.splice(targetIndex, 0, moved);
      const reindexed = reindexPins(nextPins);
      setPins(reindexed);
      await saveAndBroadcast(reindexed, settings, panelWidth);
    },
    [panelWidth, pins, saveAndBroadcast, settings]
  );

  const handleReset = useCallback(async () => {
    if (!window.confirm('Reset all pins and settings to defaults?')) {
      return;
    }
    const response = await chrome.runtime.sendMessage({ action: 'resetStorage' });
    if (!response?.ok) {
      return;
    }
    setPins(response.data.pins);
    setSettings(response.data.settings);
    setPanelWidth(response.data.settings.panelWidth);
    setActivePinId(response.data.lastActivePinId ?? null);
    setSidebarHidden(Boolean(response.data.sidebarHidden));
    resetPinForm();
    closePanel();
    setSettingsOpen(false);
  }, [closePanel, resetPinForm]);

  const handleResizeStart = useCallback(
    (event: React.MouseEvent) => {
      event.preventDefault();
      const startX = event.clientX;
      const startWidth = panelWidth;
      let currentWidth = startWidth;
      setResizeDragging(true);

      const onMove = (moveEvent: MouseEvent) => {
        const delta = moveEvent.clientX - startX;
        currentWidth = gxClamp(
          startWidth + delta,
          GX_DEFAULTS.PANEL_MIN_WIDTH,
          GX_DEFAULTS.PANEL_MAX_WIDTH
        );
        setPanelWidth(currentWidth);
      };

      const onEnd = () => {
        setResizeDragging(false);
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onEnd);
        void chrome.storage.sync.set({
          settings: { ...settings, panelWidth: currentWidth }
        });
      };

      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onEnd);
    },
    [panelWidth, settings]
  );

  useEffect(() => {
    setCssVariables(panelWidth, rootRef.current);
  }, [panelWidth]);

  useEffect(() => {
    applyLayoutClasses(sidebarHidden, panelOpen, settingsOpen);
  }, [panelOpen, settingsOpen, sidebarHidden]);

  /**
   * Restores the session-global panel state on mount: when the panel was open
   * in another tab (or before a same-tab navigation), it reopens here with
   * the same pin so the sidebar feels persistent across tabs.
   */
  useEffect(() => {
    if (!initialPanelOpen) {
      return;
    }
    const pin =
      pinsRef.current.find((p) => p.id === activePinIdRef.current) ?? pinsRef.current[0];
    if (!pin) {
      return;
    }
    setActivePinId(pin.id);
    activePinIdRef.current = pin.id;
    void chrome.runtime.sendMessage({ action: 'saveLastActivePin', pinId: pin.id }).catch(() => {});
    setPanelOpen(true);
    panelOpenRef.current = true;
    openPanelForPin(pin);
    // Mount-only restore; re-running on dependency changes would remount the
    // panel iframe on every pin/settings update.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const listener = (message: { action?: string; hidden?: boolean; pins?: Pin[]; settings?: Settings; pinId?: string; open?: boolean }, _sender: chrome.runtime.MessageSender, sendResponse: (response?: unknown) => void) => {
      if (message.action === 'setSidebarHidden') {
        setSidebarHidden(Boolean(message.hidden));
        sendResponse({ ok: true, hidden: Boolean(message.hidden) });
      }

      if (message.action === 'togglePanel') {
        if (panelOpenRef.current) {
          closePanel();
        } else {
          setPins((currentPins) => {
            const pin =
              currentPins.find((p) => p.id === activePinIdRef.current) ?? currentPins[0];
            if (pin) {
              handlePinClickRef.current(pin);
            }
            return currentPins;
          });
        }
        sendResponse({ ok: true, panelOpen: panelOpenRef.current });
      }

      if (message.action === 'pinsUpdated') {
        const nextPins = (message.pins ?? [])
          .slice()
          .sort((a: Pin, b: Pin) => a.order - b.order);
        setPins(nextPins);

        if (message.settings) {
          setSettings((prev) => {
            const merged = { ...prev, ...message.settings! };
            setPanelWidth(merged.panelWidth ?? panelWidth);
            return merged;
          });
        }

        if (panelOpenRef.current) {
          const stillExists = nextPins.some((p: Pin) => p.id === activePinIdRef.current);
          if (!stillExists) {
            closePanel();
            setActivePinId(null);
          }
        }

        sendResponse({ ok: true });
      }

      if (message.action === 'panelStateSynced') {
        // Another tab opened/closed the panel: mirror it here. No-op when
        // already in the target state, which also breaks broadcast loops.
        if (message.open && typeof message.pinId === 'string') {
          const pin = pinsRef.current.find((p) => p.id === message.pinId);
          if (pin && (!panelOpenRef.current || activePinIdRef.current !== message.pinId)) {
            setActivePinId(pin.id);
            activePinIdRef.current = message.pinId;
            void chrome.runtime
              .sendMessage({ action: 'saveLastActivePin', pinId: message.pinId })
              .catch(() => {});
            setPanelOpen(true);
            panelOpenRef.current = true;
            openPanelForPin(pin);
          }
        } else if (!message.open && panelOpenRef.current) {
          closePanel();
        }
        sendResponse({ ok: true });
      }

      if (message.action === 'companionClosed') {
        // Ignore deselect signals while the in-page panel is open: pin switching
        // fires closeCompanion before loading the next pin, and the broadcast
        // can arrive after the new pin is already active.
        if (message.pinId === activePinIdRef.current && !panelOpenRef.current) {
          setActivePinId(null);
        }
        sendResponse({ ok: true });
      }

      if (message.action === 'getState') {
        sendResponse({
          panelOpen: panelOpenRef.current,
          activePinId: activePinIdRef.current,
          sidebarHidden,
          panelWidth
        });
      }

      return false;
    };

    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, [closePanel, openPanelForPin, panelWidth, sidebarHidden]);

  const activePin = getActivePin();
  const companionHeightMode =
    settings.companionHeightMode ?? GX_DEFAULTS.DEFAULT_SETTINGS.companionHeightMode;

  return (
    <div ref={rootRef} className={`sidebar-root${sidebarHidden ? ' hidden' : ''}`}>
      <IconStrip
        pins={pins}
        activePinId={activePinId}
        settingsOpen={settingsOpen}
        onPinClick={handlePinClick}
        onToggleSettings={toggleSettings}
      />

      <AppPanel
        open={panelOpen}
        pin={activePin}
        panelView={panelView}
        fallbackPin={fallbackPin}
        frameEpoch={frameEpoch}
        frameSrc={frameSrc}
        iframeRef={iframeRef}
        resizeDragging={resizeDragging}
        onClose={closePanel}
        onRefresh={() => activePin && openPanelForPin(activePin)}
        onOpenCompanion={() => activePin && void openCompanionDirectly(activePin)}
        onIframeLoad={handleIframeLoad}
        onIframeError={handleIframeError}
        onResizeStart={handleResizeStart}
      />

      <SettingsPanel
        open={settingsOpen}
        pins={pins}
        settings={settings}
        panelWidth={panelWidth}
        editingPinId={editingPinId}
        pinForm={pinForm}
        companionHeightMode={companionHeightMode}
        onClose={() => setSettingsOpen(false)}
        onPinFormChange={setPinForm}
        onSavePin={(e) => void handleSavePin(e)}
        onPinCurrentPage={pinCurrentPage}
        onQuickPinCurrentPage={() => void quickPinCurrentPage()}
        onCancelEdit={resetPinForm}
        onEditPin={beginEditPin}
        onDeletePin={(index) => void handleDeletePin(index)}
        onDragStart={(index) => {
          draggedIndexRef.current = index;
        }}
        onDragEnd={() => {
          draggedIndexRef.current = null;
        }}
        onDropPin={(index) => void handleDropPin(index)}
        onPanelWidthChange={(width) => {
          setPanelWidth(width);
          setSettings((prev) => ({ ...prev, panelWidth: width }));
        }}
        onPanelWidthCommit={() => void saveAndBroadcast(pins, { ...settings, panelWidth }, panelWidth)}
        onSettingsPatch={(patch) => setSettings((prev) => ({ ...prev, ...patch }))}
        onSettingsCommit={() => void saveAndBroadcast(pins, settings, panelWidth)}
        onSettingsPatchAndCommit={(patch) => {
          const next = { ...settings, ...patch };
          setSettings(next);
          void saveAndBroadcast(pins, next, panelWidth);
        }}
        onReset={() => void handleReset()}
      />
    </div>
  );
}
