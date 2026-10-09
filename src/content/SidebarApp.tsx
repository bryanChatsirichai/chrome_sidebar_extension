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
 * Patience for frames whose load event fired while still on about:blank.
 * A real navigation cancels these polls via a generation bump, so the budget
 * only expires for genuinely blocked/stalled embeds — fail fast to companion
 * instead of waiting for the full load timeout.
 */
const IFRAME_STALL_MAX_ATTEMPTS = 8;
const IFRAME_STALL_RETRY_MS = 250;
/** Post-success watchdog window that catches late-committed error pages. */
const IFRAME_WATCHDOG_DURATION_MS = 4000;
const IFRAME_WATCHDOG_INTERVAL_MS = 500;
/** Chrome error pages have a tiny body; real site content is longer. */
const IFRAME_ERROR_PAGE_MAX_TEXT_LENGTH = 250;

export type PanelView = 'idle' | 'loading' | 'iframe' | 'fallback';

interface SidebarAppProps {
  initialPins: Pin[];
  initialSettings: Settings;
  initialActivePinId: string | null;
  initialSidebarHidden: boolean;
  initialPanelWidth: number;
}

export function SidebarApp({
  initialPins,
  initialSettings,
  initialActivePinId,
  initialSidebarHidden,
  initialPanelWidth
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
  const handlePinClickRef = useRef<(pin: Pin) => void>(() => {});

  panelOpenRef.current = panelOpen;
  activePinIdRef.current = activePinId;

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

  const getIframeDocumentText = useCallback((): string => {
    try {
      const doc = iframeRef.current?.contentDocument;
      if (!doc) {
        return '';
      }
      return [doc.title, doc.body?.innerText, doc.body?.textContent, doc.documentElement?.textContent]
        .filter(Boolean)
        .join('\n');
    } catch {
      return '';
    }
  }, []);

  const isIframeEmbedBlocked = useCallback((): boolean => {
    const href = getIframeLocationHref();
    if (typeof href === 'string' && href.startsWith('chrome-error:')) {
      return true;
    }
    return EMBED_BLOCKED_PATTERN.test(getIframeDocumentText());
  }, [getIframeDocumentText, getIframeLocationHref]);

  /**
   * Strict error-page check for the post-success watchdog. Unlike the broad
   * load-time pattern, it requires a near-empty body so live site content
   * mentioning phrases like "failed to load" never triggers a false failure.
   */
  const isIframeErrorPage = useCallback((): boolean => {
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
        /refused to connect|err_[a-z_]+/i.test(text)
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
        setPanelOpen(false);
        panelOpenRef.current = false;
        setPanelView('idle');
      }

      const response = await openCompanionForPin(pin);
      if (!response?.ok || !response.open) {
        setPanelOpen(true);
        panelOpenRef.current = true;
        showFallbackUI(pin);
      }
      return response;
    },
    [clearIframeTimer, clearIframeVerifyTimer, clearIframeWatchdog, openCompanionForPin, showFallbackUI]
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

        if (isIframeErrorPage()) {
          void handleEmbedFailure(pin);
          return;
        }

        iframeWatchdogTimerRef.current = setTimeout(poll, IFRAME_WATCHDOG_INTERVAL_MS);
      };

      iframeWatchdogTimerRef.current = setTimeout(poll, IFRAME_WATCHDOG_INTERVAL_MS);
    },
    [clearIframeWatchdog, handleEmbedFailure, isIframeErrorPage]
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
        // the navigation is mid-commit (a real load cancels these polls via a
        // generation bump) or the embed was blocked and never committed. Give
        // it a short budget, then show the fallback view instead of staring
        // at the spinner until the full load timeout.
        if (attempt < IFRAME_STALL_MAX_ATTEMPTS) {
          iframeVerifyTimerRef.current = setTimeout(
            () => verifyIframeEmbed(pin, attempt + 1, generation),
            IFRAME_STALL_RETRY_MS
          );
          return;
        }
        handleEmbedFailure(pin);
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
    [clearIframeTimer, clearIframeVerifyTimer, clearIframeWatchdog, handleEmbedFailure]
  );

  const closePanel = useCallback(() => {
    setPanelOpen(false);
    setPanelView('idle');
    embedFailureHandledRef.current = false;
    iframeVerifyGenerationRef.current += 1;
    clearIframeTimer();
    clearIframeVerifyTimer();
    clearIframeWatchdog();
    setFrameSrc('');
  }, [clearIframeTimer, clearIframeVerifyTimer, clearIframeWatchdog]);

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

  useEffect(() => {
    const listener = (message: { action?: string; hidden?: boolean; pins?: Pin[]; settings?: Settings; pinId?: string }, _sender: chrome.runtime.MessageSender, sendResponse: (response?: unknown) => void) => {
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
  }, [closePanel, panelWidth, sidebarHidden]);

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
