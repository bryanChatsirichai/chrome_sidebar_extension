import { useCallback, useEffect, useRef, useState } from 'react';
import { BROWSER_SIDEBAR_DEFAULTS, browserSidebarClamp } from '../lib/defaults';
import { parsePinUrl, reindexPins, resolveIconUrl, getCurrentPagePinDefaults } from '../lib/pin-utils';
import { browserSidebarRuntimeAlive, browserSidebarSafeSendMessage } from './runtimeGuard';
import type { Pin, Settings } from '../lib/types';
import { IconStrip } from './components/IconStrip';
import { AppPanel } from './components/AppPanel';
import { SettingsPanel } from './components/SettingsPanel';
import {
  applyLayoutClasses,
  setCssVariables,
  setPageResizeActive,
  setPanelWidthCss,
  setSidebarZoomFactor
} from './sidebarUtils';
import { refreshFixedElementShift } from './fixedShift';

const EMBED_BLOCKED_PATTERN =
  /refused to connect|content is blocked|contact the site owner|can't be embedded|cannot be displayed|x-frame-options|frame-ancestors|failed to load|err_blocked_by|err_name_not_resolved|err_connection_refused|err_address_unreachable|err_cert_|err_timed_out/i;

const IFRAME_VERIFY_MAX_ATTEMPTS = 1;
const IFRAME_VERIFY_RETRY_MS = 100;
/**
 * How long verification waits for the frame's boot signal (frameDiagnostics
 * 'panelFrameBooted' via the background) before declaring a cross-origin
 * commit blocked. The signal fires at the frame's document_start — normally
 * before the parent even sees onLoad — so anything that hasn't arrived by
 * the end of this window is a frame that never ran scripts: an XFO or
 * partitioned-SW error page.
 */
const IFRAME_BOOT_GRACE_MS = 2000;
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

/**
 * DNR session rules persist for the whole browser session, so a successful
 * assert only needs re-checking after this window. Skipping the background
 * roundtrip saves latency and cold service-worker wakes on every open.
 */
const EMBED_RULES_CACHE_TTL_MS = 60_000;

/** Hover dwell before a speculative preload mounts the hidden frame. */
const PIN_PRELOAD_HOVER_DELAY_MS = 150;

/** Persists panel state across opens — warm frames stay mounted while hidden. */
export interface WarmFrameEntry {
  pinId: string;
  src: string;
  /** Bumped on every fresh navigation so React remounts the iframe. */
  nav: number;
  status: 'loading' | 'ready';
  /**
   * Timestamp of the last open/switch — drives LRU eviction. Deliberately
   * NOT array order: moving an iframe node in the DOM destroys its browsing
   * context and forces a full reload, so warmFrames keeps stable insertion
   * order and React never reorders the mounted iframes.
   */
  lastUsed: number;
}

/**
 * How many panel iframes stay mounted (hidden) for instant pin switching.
 * Each warm cross-origin frame is a live renderer process, so this is
 * capped deliberately.
 */
const WARM_FRAME_LIMIT = 4;

/**
 * Minimum spacing between automatic partition repairs. The repair wipes ALL
 * sites' service workers (the only code path that removes third-party
 * storage-partitioned SWs), so it must never loop: one auto attempt per
 * panel-open, and no second auto attempt within this window.
 */
const AUTO_REPAIR_COOLDOWN_MS = 30_000;

export type PanelView = 'idle' | 'loading' | 'iframe' | 'fallback';

interface SidebarAppProps {
  initialPins: Pin[];
  initialSettings: Settings;
  initialSidebarHidden: boolean;
  initialPanelWidth: number;
}

export function SidebarApp({
  initialPins,
  initialSettings,
  initialSidebarHidden,
  initialPanelWidth
}: SidebarAppProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const iframeLoadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const iframeVerifyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const iframeWatchdogTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const preloadHoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const iframeVerifyGenerationRef = useRef(0);
  const embedFailureHandledRef = useRef(false);
  const draggedIndexRef = useRef<number | null>(null);
  const sliderFrameRef = useRef<number | null>(null);
  const sliderWidthRef = useRef(0);

  const [pins, setPins] = useState(initialPins);
  const [settings, setSettings] = useState(initialSettings);
  const [activePinId, setActivePinId] = useState<string | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sidebarHidden, setSidebarHidden] = useState(initialSidebarHidden);
  const [panelWidth, setPanelWidth] = useState(initialPanelWidth);
  const [panelView, setPanelView] = useState<PanelView>('idle');
  const [warmFrames, setWarmFrames] = useState<WarmFrameEntry[]>([]);
  const [fallbackPin, setFallbackPin] = useState<Pin | null>(null);
  const [repairInProgress, setRepairInProgress] = useState(false);
  // True once this content script's extension context was invalidated
  // (extension reloaded/updated while the tab stayed open) — the sidebar
  // keeps rendering but its messaging is dead; the user should refresh.
  const [runtimeDead, setRuntimeDead] = useState(false);
  const [editingPinId, setEditingPinId] = useState<string | null>(null);
  const [pinForm, setPinForm] = useState({ name: '', url: '', iconUrl: '' });
  const [resizeDragging, setResizeDragging] = useState(false);
  const [sliderResizing, setSliderResizing] = useState(false);
  // Browser zoom of this tab (1 = 100%): the sidebar counter-scales so it
  // renders at the same physical size regardless of page zoom.
  const [zoomFactor, setZoomFactor] = useState(1);
  const zoomFactorRef = useRef(1);
  // Mirrors panelWidth synchronously: the storage.onChanged listener must
  // compare against the latest committed width even before React re-renders.
  const panelWidthRef = useRef(panelWidth);
  // True while a drag/slider width gesture is live in THIS tab: external
  // width changes (storage.onChanged from other tabs) are ignored so they
  // can't fight an in-progress gesture.
  const widthGestureActiveRef = useRef(false);

  const panelOpenRef = useRef(panelOpen);
  const activePinIdRef = useRef(activePinId);
  const pinsRef = useRef(pins);
  const handlePinClickRef = useRef<(pin: Pin) => void>(() => {});
  // Ref indirection so the runtime-message listener can trigger embed
  // failure without re-registering on every callback identity change.
  const handleEmbedFailureRef = useRef<(pin: Pin, reason: string) => void>(() => {});
  // Same for the auto-repair loop: handleEmbedFailure is declared BEFORE
  // openPanelForPin, but the repair needs openPanelForPin — a plain
  // useCallback dependency would be a TDZ / circular-dependency trap.
  const repairAndRetryRef = useRef<(pin: Pin) => Promise<boolean>>(async () => false);
  // One automatic repair per panel-open attempt (reset in openPanelForPin).
  const autoRepairAttemptedRef = useRef(false);
  // Global cooldown so repeated failures can never trigger a SW-wipe storm.
  const lastAutoRepairAtRef = useRef(0);
  // Survives panel close (unlike activePinId): the toolbar toggle reopens
  // the last-opened pin instead of falling back to the first pin.
  const lastOpenedPinIdRef = useRef<string | null>(null);
  // Origins whose panel frame has PROVEN it runs scripts (frameDiagnostics
  // boot signal). The only reliable committed-vs-blocked discriminator for
  // cross-origin frames — cleared for a pin's origin right before a fresh
  // navigation so a blocked retry can't inherit a stale success signal.
  const bootedOriginsRef = useRef<Set<string>>(new Set());
  // Last successful DNR embed-rules assert: signature + timestamp of the
  // pinned-url set it was asserted for. Lets ensureEmbedRulesReady skip the
  // background roundtrip within EMBED_RULES_CACHE_TTL_MS (rules persist for
  // the whole browser session).
  const embedRulesAssertedAtRef = useRef(0);
  const embedRulesSignatureRef = useRef('');
  // When the current verification cycle started (boot-grace window anchor).
  const verifyStartedAtRef = useRef(0);
  /** Live iframe elements by pinId — warm frames stay mounted while hidden. */
  const frameElementsRef = useRef<Map<string, HTMLIFrameElement>>(new Map());
  /** Mirrors the warmFrames state for synchronous reads inside callbacks. */
  const warmFramesRef = useRef<WarmFrameEntry[]>([]);
  /** Monotonic per-pin navigation counter — guarantees iframe remounts. */
  const navCounterRef = useRef<Map<string, number>>(new Map());

  panelOpenRef.current = panelOpen;
  activePinIdRef.current = activePinId;
  pinsRef.current = pins;

  /** Commits the next warm-frame list (ref + state stay in lockstep). */
  const updateWarmFrames = useCallback((next: WarmFrameEntry[]) => {
    warmFramesRef.current = next;
    setWarmFrames(next);
  }, []);

  /**
   * Touches a pin's frame (adds if new, refreshes its fields + recency if
   * existing) WITHOUT reordering the list. DOM order stays insertion-stable:
   * moving an iframe in the DOM reloads it, which is exactly what warm
   * frames exist to avoid. LRU recency lives in `lastUsed`.
   */
  const touchWarmFrame = useCallback(
    (entry: Omit<WarmFrameEntry, 'lastUsed'>) => {
      const now = Date.now();
      const current = warmFramesRef.current;
      const exists = current.some((f) => f.pinId === entry.pinId);

      if (exists) {
        // In-place update: same array position, so no other frame's DOM node
        // moves. A changed src/nav still remounts THIS pin's iframe (new
        // React key), but that is the intended fresh navigation.
        updateWarmFrames(current.map((f) => (f.pinId === entry.pinId ? { ...entry, lastUsed: now } : f)));
        return;
      }

      // New frame: append at the end (never reorder the others).
      const next = [...current, { ...entry, lastUsed: now }];

      // Over the limit: evict the least-recently-used frame — never the
      // currently active pin's.
      if (next.length > WARM_FRAME_LIMIT) {
        const activeId = activePinIdRef.current;
        const lru = next
          .filter((f) => f.pinId !== activeId)
          .sort((a, b) => a.lastUsed - b.lastUsed)[0];
        if (lru) {
          updateWarmFrames(next.filter((f) => f.pinId !== lru.pinId));
          frameElementsRef.current.delete(lru.pinId);
          return;
        }
      }

      updateWarmFrames(next);
    },
    [updateWarmFrames]
  );

  /** Marks a frame as successfully loaded (also used for background loads). */
  const markFrameReady = useCallback(
    (pinId: string) => {
      if (!warmFramesRef.current.some((f) => f.pinId === pinId && f.status !== 'ready')) {
        return;
      }
      updateWarmFrames(warmFramesRef.current.map((f) => (f.pinId === pinId ? { ...f, status: 'ready' as const } : f)));
    },
    [updateWarmFrames]
  );

  /** Drops a frame entirely — the iframe unmounts and frees its renderer. */
  const evictWarmFrame = useCallback(
    (pinId: string) => {
      if (!warmFramesRef.current.some((f) => f.pinId === pinId)) {
        return;
      }
      updateWarmFrames(warmFramesRef.current.filter((f) => f.pinId !== pinId));
      frameElementsRef.current.delete(pinId);
    },
    [updateWarmFrames]
  );

  /** Callback-ref registrar for the per-pin panel iframes. */
  const registerFrameElement = useCallback((pinId: string, element: HTMLIFrameElement | null) => {
    if (element) {
      frameElementsRef.current.set(pinId, element);
    } else {
      frameElementsRef.current.delete(pinId);
    }
    if (pinId === activePinIdRef.current) {
      iframeRef.current = element;
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

  const clearPreloadHoverTimer = useCallback(() => {
    if (preloadHoverTimerRef.current) {
      clearTimeout(preloadHoverTimerRef.current);
      preloadHoverTimerRef.current = null;
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
   * DEBUG: snapshot of everything observable about the panel iframe at the
   * moment of a failure. Cross-origin access throws — those exceptions are
   * captured too, since a SecurityError on location/document access is
   * itself diagnostic (the frame committed a real cross-origin document vs.
   * stayed on an error page).
   */
  const collectIframeDiagnostics = useCallback((): Record<string, unknown> => {
    const frame = iframeRef.current;
    if (!frame) {
      return { framePresent: false };
    }

    const diagnostics: Record<string, unknown> = {
      framePresent: true,
      frameSrc: frame.src || '(empty)'
    };

    try {
      diagnostics.href = frame.contentWindow?.location?.href ?? '(no location)';
    } catch (error) {
      diagnostics.href = '(SecurityError — cross-origin document committed)';
      diagnostics.hrefError = String(error);
    }

    try {
      const doc = frame.contentDocument;
      diagnostics.readyState = doc?.readyState ?? '(no document)';
      const text = (doc?.body?.innerText ?? '').trim();
      diagnostics.bodyTextLength = text.length;
      diagnostics.bodyTextSnippet = text.slice(0, 200);
    } catch (error) {
      diagnostics.documentError = String(error);
    }

    return diagnostics;
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
      // chrome.storage / chrome.runtime calls throw once the extension
      // context is invalidated (extension reloaded with the tab still open).
      // Failing soft keeps the React tree alive; the reload notice covers UX.
      try {
        await chrome.storage.sync.set({ pins: nextPins, settings: merged });
        await browserSidebarSafeSendMessage({
          action: 'broadcastPinsUpdated',
          pins: nextPins,
          settings: merged
        });
      } catch (error) {
        console.warn('[browser-sidebar] saveAndBroadcast skipped:', error);
      }
    },
    []
  );

  const showIframeLoaded = useCallback(() => {
    clearIframeTimer();
    clearIframeVerifyTimer();
    setPanelView('iframe');
  }, [clearIframeTimer, clearIframeVerifyTimer]);

  const showFallbackUI = useCallback(
    (pin: Pin) => {
      clearIframeTimer();
      clearIframeWatchdog();
      setFallbackPin(pin);
      setPanelView('fallback');
    },
    [clearIframeTimer, clearIframeWatchdog]
  );

  /**
   * Embed failure stays in the panel: the fallback view offers an in-panel
   * "Open in new tab" action; it never opens another window automatically.
   */
  const handleEmbedFailure = useCallback(
    (pin: Pin, reason: string) => {
      if (embedFailureHandledRef.current) {
        return;
      }

      // DEBUG: full trace of why the embed was declared failed.
      console.error('[browser-sidebar] Embed failure:', {
        pin,
        reason,
        activePinId: activePinIdRef.current,
        diagnostics: collectIframeDiagnostics()
      });

      embedFailureHandledRef.current = true;
      iframeVerifyGenerationRef.current += 1;
      // The frame is dead (error page / blocked) — drop it so the next open
      // starts a fresh navigation instead of reusing the corpse.
      evictWarmFrame(pin.id);
      clearIframeTimer();
      clearIframeVerifyTimer();
      clearIframeWatchdog();

      // Seamless recovery: automatically repair the partition (full SW +
      // cache clear — the only verified way to evict a third-party
      // storage-partitioned SW serving cached XFO responses) and retry
      // once. Guarded: one auto attempt per panel-open, and a global
      // cooldown so a persistently failing site can never loop into a
      // service-worker wipe storm. Beyond that, the fallback view's manual
      // Repair & retry button takes over.
      const canAutoRepair =
        !autoRepairAttemptedRef.current &&
        Date.now() - lastAutoRepairAtRef.current >= AUTO_REPAIR_COOLDOWN_MS;

      if (canAutoRepair) {
        autoRepairAttemptedRef.current = true;
        lastAutoRepairAtRef.current = Date.now();
        console.warn('[browser-sidebar] Auto-repairing embed partition for:', pin.name);
        void repairAndRetryRef.current(pin).then((healed) => {
          if (!healed) {
            showFallbackUI(pin);
          }
        });
        return; // keep the loading view while repairing + retrying
      }

      showFallbackUI(pin);
    },
    [clearIframeTimer, clearIframeVerifyTimer, clearIframeWatchdog, collectIframeDiagnostics, evictWarmFrame, showFallbackUI]
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
          void handleEmbedFailure(pin, 'watchdog: blocked after initial success');
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

      console.log('[browser-sidebar] Embed verified, showing panel:', {
        pin: pin.name,
        href: getIframeLocationHref()
      });
      markFrameReady(pin.id);
      showIframeLoaded();
      startIframeWatchdog(pin, generation);
    },
    [getIframeLocationHref, markFrameReady, showIframeLoaded, startIframeWatchdog]
  );

  const verifyIframeEmbed = useCallback(
    (pin: Pin, attempt = 0, generation = iframeVerifyGenerationRef.current) => {
      if (generation !== iframeVerifyGenerationRef.current) {
        console.log('[browser-sidebar] Verify skipped: stale generation', { generation });
        return;
      }

      const activePin = pins.find((p) => p.id === activePinId);
      if (!panelOpen || activePin?.id !== pin.id || embedFailureHandledRef.current) {
        console.log('[browser-sidebar] Verify skipped: state changed', {
          panelOpen,
          activePinId: activePin?.id,
          pinId: pin.id,
          failureHandled: embedFailureHandledRef.current
        });
        return;
      }

      if (isIframeEmbedBlocked()) {
        console.log('[browser-sidebar] Verify: embed blocked detected (attempt ' + attempt + ')');
        handleEmbedFailure(pin, 'verify: blocked on load');
        return;
      }

      const href = getIframeLocationHref();

      console.log('[browser-sidebar] Verify attempt', {
        attempt,
        generation,
        href,
        pin: pin.name,
        diagnostics: collectIframeDiagnostics()
      });

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
        // Cross-origin view: a committed document and a blocked error page
        // are indistinguishable from the parent (SecurityError either
        // way). The discriminator is the frame's own boot signal — a
        // committed document runs frameDiagnostics at document_start and
        // reports 'panelFrameBooted'; a blocked frame never runs scripts.
        const bootOrigin = (() => {
          try {
            return new URL(pin.url).origin;
          } catch {
            return null;
          }
        })();

        if (bootOrigin !== null && bootedOriginsRef.current.has(bootOrigin)) {
          finalizeIframeSuccess(pin, generation);
          return;
        }

        if (Date.now() - verifyStartedAtRef.current < IFRAME_BOOT_GRACE_MS) {
          iframeVerifyTimerRef.current = setTimeout(
            () => verifyIframeEmbed(pin, attempt + 1, generation),
            IFRAME_VERIFY_RETRY_MS
          );
          return;
        }

        console.error(
          '[browser-sidebar] Frame never ran scripts within boot grace — blocked at commit:',
          { pin: pin.name, url: pin.url }
        );
        handleEmbedFailure(pin, 'no frame boot signal — blocked at commit');
        return;
      }

      if (isIframeEmbedBlocked()) {
        handleEmbedFailure(pin, 'verify: blocked after retry');
        return;
      }

      finalizeIframeSuccess(pin, generation);
    },
    [
      activePinId,
      collectIframeDiagnostics,
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
      verifyStartedAtRef.current = Date.now();
      clearIframeVerifyTimer();
      verifyIframeEmbed(pin, 0, generation);
    },
    [clearIframeVerifyTimer, verifyIframeEmbed]
  );

  /**
   * Waits until the background worker confirms the embed-bypass DNR session
   * rules are committed. After a browser restart (especially a crash-restore,
   * which never fires onStartup) the just-woken worker may still be installing
   * them — navigating the panel iframe in that window gets the response served
   * with X-Frame-Options intact ("refused to connect"). Best-effort: on any
   * messaging failure we still navigate; the 15s load-timeout net guards it.
   */
  const ensureEmbedRulesReady = useCallback(async () => {
    // DNR session rules persist for the whole browser session. If we already
    // asserted them for this exact set of pinned URLs within the TTL window,
    // skip the background roundtrip (saves latency + cold worker wakes).
    const signature = pinsRef.current
      .map((p) => p.url)
      .sort()
      .join('|');
    if (
      signature === embedRulesSignatureRef.current &&
      Date.now() - embedRulesAssertedAtRef.current < EMBED_RULES_CACHE_TTL_MS
    ) {
      console.log('[browser-sidebar] ensureEmbedRules: cached');
      return;
    }
    try {
      const response = await browserSidebarSafeSendMessage<{ ok?: boolean }>({ action: 'ensureEmbedRules' });
      // DEBUG: the background's answer gates the iframe navigation — its
      // error payload is the first place a DNR/cookie failure shows up.
      if (!response?.ok) {
        console.error('[browser-sidebar] ensureEmbedRules error response:', response);
      } else {
        console.log('[browser-sidebar] ensureEmbedRules ok:', response);
        // Cache only on success — a failed assert must be retried.
        embedRulesAssertedAtRef.current = Date.now();
        embedRulesSignatureRef.current = signature;
      }
    } catch (error) {
      // Worker unreachable or extension context invalidated — proceed.
      console.warn('[browser-sidebar] ensureEmbedRules send failed:', error);
    }
  }, []);

  /**
   * Speculatively mounts a pin's hidden iframe (hover dwell / press) WITHOUT
   * opening the panel, so the click that follows is warm-instant. Mirrors
   * openPanelForPin's fresh-navigation guard.
   */
  const preloadPin = useCallback(
    async (pin: Pin) => {
      if (!browserSidebarRuntimeAlive()) return;
      // Already mounted (loading or ready) for this src, or it's the live
      // panel's own pin — nothing to warm.
      if (warmFramesRef.current.some((f) => f.pinId === pin.id && f.src === pin.url)) return;
      if (panelOpenRef.current && activePinIdRef.current === pin.id) return;
      // Never evict a ready warm frame for a speculative preload.
      if (warmFramesRef.current.length >= WARM_FRAME_LIMIT) return;

      await ensureEmbedRulesReady();
      if (!browserSidebarRuntimeAlive()) return; // re-check after the await

      const nextNav = (navCounterRef.current.get(pin.id) ?? 0) + 1;
      navCounterRef.current.set(pin.id, nextNav);
      // Same fresh-nav guard as openPanelForPin: drop any stale boot signal
      // for this origin so a blocked preload can't be verified by inheritance.
      try {
        bootedOriginsRef.current.delete(new URL(pin.url).origin);
      } catch {
        // Malformed pin URL — skip preloading entirely.
        return;
      }
      console.log('[browser-sidebar] Preloading pin frame:', pin.name);
      touchWarmFrame({ pinId: pin.id, src: pin.url, nav: nextNav, status: 'loading' });
    },
    [ensureEmbedRulesReady, touchWarmFrame]
  );

  /**
   * Opens the panel for a pin. Warm frames (mounted, hidden, already
   * verified) reopen instantly with no network or rule-gate round-trip.
   * Cold opens remount a pristine iframe per navigation — one dedicated
   * frame per pin avoids the cross-origin reuse flakiness that came from
   * reusing a single frame element across pins.
   */
  const openPanelForPin = useCallback(
    async (pin: Pin) => {
      console.log('[browser-sidebar] Opening panel for pin:', {
        pin,
        activePinId: activePinIdRef.current,
        panelOpen: panelOpenRef.current
      });

      lastOpenedPinIdRef.current = pin.id;
      embedFailureHandledRef.current = false;
      // Fresh open = fresh auto-repair budget (the global cooldown still
      // applies — this only re-arms the one-attempt-per-open guard).
      autoRepairAttemptedRef.current = false;
      iframeVerifyGenerationRef.current += 1;
      setFallbackPin(null);

      // Point diagnostics/verification at this pin's frame from now on
      // (the effect below re-points on later active-pin changes).
      iframeRef.current = frameElementsRef.current.get(pin.id) ?? null;

      const existing = warmFramesRef.current.find((f) => f.pinId === pin.id);

      if (existing && existing.src === pin.url && existing.status === 'ready') {
        // Instant reuse only with proof the frame's scripts are running: a frame
        // can reach 'ready' via onLoad alone, and blocked error pages fire onLoad
        // too. Cross-origin reuse without a boot signal gets re-verified instead.
        const bootOrigin = (() => {
          try {
            return new URL(pin.url).origin;
          } catch {
            return null;
          }
        })();
        const sameOrigin = bootOrigin !== null && bootOrigin === window.location.origin;
        if (sameOrigin || (bootOrigin !== null && bootedOriginsRef.current.has(bootOrigin))) {
          console.log('[browser-sidebar] Reusing warm frame:', pin.name);
          touchWarmFrame(existing);
          setPanelView('iframe');
          return;
        }
        console.warn('[browser-sidebar] Warm frame lacks boot proof — re-verifying:', pin.name);
        // fall through to the loading path below (no remount, just re-verify)
      }

      setPanelView('loading');
      clearIframeTimer();
      clearIframeVerifyTimer();
      clearIframeWatchdog();

      if (existing && existing.src === pin.url) {
        // A frame for this pin is already loading in the background: show
        // the spinner, re-arm verification, and re-arm the timeout net.
        touchWarmFrame(existing);
        startIframeVerification(pin);
        iframeLoadTimerRef.current = setTimeout(() => {
          if (
            !embedFailureHandledRef.current &&
            panelOpenRef.current &&
            pin.id === activePinIdRef.current
          ) {
            handleEmbedFailure(pin, `load timeout after ${BROWSER_SIDEBAR_DEFAULTS.IFRAME_LOAD_TIMEOUT_MS}ms`);
          }
        }, BROWSER_SIDEBAR_DEFAULTS.IFRAME_LOAD_TIMEOUT_MS);
        return;
      }

      // Gate the navigation on the DNR rules being active — never let the
      // sub_frame request beat rule installation out of a cold worker.
      await ensureEmbedRulesReady();

      console.log('[browser-sidebar] Navigating iframe to:', pin.url);
      const nextNav = (navCounterRef.current.get(pin.id) ?? 0) + 1;
      navCounterRef.current.set(pin.id, nextNav);
      // Fresh navigation: drop any stale boot signal for this origin so a
      // blocked commit can't inherit the previous document's liveness proof.
      try {
        bootedOriginsRef.current.delete(new URL(pin.url).origin);
      } catch {
        // Malformed pin URL — nothing to clear.
      }
      touchWarmFrame({
        pinId: pin.id,
        src: pin.url,
        nav: nextNav,
        status: 'loading'
      });

      iframeLoadTimerRef.current = setTimeout(() => {
        if (
          !embedFailureHandledRef.current &&
          panelOpenRef.current &&
          pin.id === activePinIdRef.current
        ) {
          handleEmbedFailure(pin, `load timeout after ${BROWSER_SIDEBAR_DEFAULTS.IFRAME_LOAD_TIMEOUT_MS}ms`);
        }
      }, BROWSER_SIDEBAR_DEFAULTS.IFRAME_LOAD_TIMEOUT_MS);
    },
    [
      clearIframeTimer,
      clearIframeVerifyTimer,
      clearIframeWatchdog,
      ensureEmbedRulesReady,
      handleEmbedFailure,
      startIframeVerification,
      touchWarmFrame
    ]
  );

  /**
   * Closes the panel but keeps warm frames mounted (hidden): reopening the
   * same pin is instant instead of a full reload.
   */
  const closePanel = useCallback(() => {
    setPanelOpen(false);
    setPanelView('idle');
    // Clear the active pin so the strip highlight drops with the panel —
    // a closed panel shows no selection; clicking any pin reopens it.
    // lastOpenedPinIdRef keeps the toolbar-toggle "reopen last pin" behavior.
    setActivePinId(null);
    activePinIdRef.current = null;
    embedFailureHandledRef.current = false;
    iframeVerifyGenerationRef.current += 1;
    clearIframeTimer();
    clearIframeVerifyTimer();
    clearIframeWatchdog();
  }, [clearIframeTimer, clearIframeVerifyTimer, clearIframeWatchdog]);

  const handlePinHover = useCallback(
    (pin: Pin) => {
      clearPreloadHoverTimer();
      preloadHoverTimerRef.current = setTimeout(() => {
        preloadHoverTimerRef.current = null;
        void preloadPin(pin);
      }, PIN_PRELOAD_HOVER_DELAY_MS);
    },
    [clearPreloadHoverTimer, preloadPin]
  );

  const handlePinLeave = useCallback(() => {
    clearPreloadHoverTimer();
  }, [clearPreloadHoverTimer]);

  const handlePinPress = useCallback(
    (pin: Pin) => {
      clearPreloadHoverTimer();
      void preloadPin(pin);
    },
    [clearPreloadHoverTimer, preloadPin]
  );

  const handlePinClick = useCallback(
    (pin: Pin) => {
      clearPreloadHoverTimer();
      // DEBUG: entry point trace — which pin was clicked and the full state
      // the click landed on.
      console.log('[browser-sidebar] Pin clicked:', {
        pin,
        activePinId,
        panelOpen,
        settingsOpen
      });

      if (settingsOpen) {
        setSettingsOpen(false);
      }

      if (activePinId === pin.id && panelOpen) {
        console.log('[browser-sidebar] Pin click → closing panel (same pin, already open)');
        closePanel();
        return;
      }

      // Note: closing the panel clears activePinId (closePanel), so a
      // click on a non-open pin always takes the open branch below —
      // there is no "deselect closed pin" state anymore.

      setActivePinId(pin.id);
      activePinIdRef.current = pin.id;
      void browserSidebarSafeSendMessage({ action: 'saveLastActivePin', pinId: pin.id });

      // Always try the in-page panel first — the background worker strips
      // iframe-blocking response headers for pinned domains (embed-bypass.ts).
      // Sites that still fail show the in-panel fallback view.
      setPanelOpen(true);
      panelOpenRef.current = true;
      openPanelForPin(pin);
    },
    [activePinId, clearPreloadHoverTimer, closePanel, openPanelForPin, panelOpen, settingsOpen]
  );

  handlePinClickRef.current = handlePinClick;
  handleEmbedFailureRef.current = handleEmbedFailure;

  const handleIframeLoad = useCallback(
    (pinId: string) => {
      const pin = pinsRef.current.find((p) => p.id === pinId) ?? null;
      console.log('[browser-sidebar] iframe onLoad fired:', {
        pin: pin?.name ?? '(unknown)',
        pinId,
        isActive: pinId === activePinIdRef.current,
        href: getIframeLocationHref()
      });
      if (!pin) {
        return;
      }
      if (pinId !== activePinIdRef.current || !panelOpenRef.current || embedFailureHandledRef.current) {
        // A background frame finished loading while inactive: mark it ready
        // so its next open is a warm, instant one.
        markFrameReady(pinId);
        return;
      }
      startIframeVerification(pin);
    },
    [getIframeLocationHref, markFrameReady, startIframeVerification]
  );

  const handleIframeError = useCallback(
    (pinId: string) => {
      const pin = pinsRef.current.find((p) => p.id === pinId) ?? null;
      console.error('[browser-sidebar] iframe onError fired:', {
        pin: pin?.name ?? '(unknown)',
        pinId,
        frameSrc: iframeRef.current?.src ?? '(none)',
        diagnostics: collectIframeDiagnostics()
      });
      if (pin && pinId === activePinIdRef.current && panelOpenRef.current && !embedFailureHandledRef.current) {
        handleEmbedFailure(pin, 'iframe error event');
      } else if (pin) {
        evictWarmFrame(pinId);
      }
    },
    [collectIframeDiagnostics, evictWarmFrame, handleEmbedFailure]
  );

  /**
   * Core repair: full browsingData.remove (no origins filter — the only
   * code path verified to remove third-party storage-partitioned service
   * workers), then retry the embed once with a fresh navigation. Returns
   * whether the retry was launched (the retry itself can still fail).
   */
  const repairAndRetry = useCallback(
    async (pin: Pin): Promise<boolean> => {
      setRepairInProgress(true);
      try {
        const response = await browserSidebarSafeSendMessage<{ ok?: boolean }>({ action: 'repairEmbedPartition' });
        if (!response?.ok) {
          console.error('[browser-sidebar] Repair failed:', response);
          return false;
        }
        console.log('[browser-sidebar] Repair complete, retrying embed:', pin.name);
        evictWarmFrame(pin.id);
        setActivePinId(pin.id);
        activePinIdRef.current = pin.id;
        setPanelOpen(true);
        panelOpenRef.current = true;
        void openPanelForPin(pin);
        return true;
      } finally {
        setRepairInProgress(false);
      }
    },
    [evictWarmFrame, openPanelForPin]
  );

  repairAndRetryRef.current = repairAndRetry;

  /**
   * Manual fallback-view button. The automatic path (handleEmbedFailure)
   * usually heals the embed before the user ever sees the fallback view;
   * this covers repeat failures beyond the auto attempt / cooldown.
   */
  const handleRepairEmbed = useCallback(async () => {
    // Note: activePin (the render-time const) is declared further down the
    // component — read the pin lazily here instead of closing over it,
    // or this useCallback's dependency array would hit the TDZ.
    const pin = getActivePin() ?? fallbackPin;
    if (!pin || repairInProgress) {
      return;
    }
    console.warn('[browser-sidebar] Manual repair requested for:', {
      pin: pin.name,
      url: pin.url
    });
    await repairAndRetry(pin);
  }, [fallbackPin, getActivePin, repairAndRetry, repairInProgress]);

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
    const response = await browserSidebarSafeSendMessage<{
      ok?: boolean;
      data?: {
        pins: Pin[];
        settings: Settings;
        lastActivePinId?: string | null;
        sidebarHidden?: boolean;
      };
    }>({ action: 'resetStorage' });
    if (!response?.ok || !response.data) {
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
    (event: React.PointerEvent<HTMLDivElement>) => {
      // Only primary (left/pointer) press initiates a drag resize.
      if (event.button !== 0) {
        return;
      }
      event.preventDefault();
      const handle = event.currentTarget;
      try {
        handle.setPointerCapture(event.pointerId);
      } catch {
        // Capture is best-effort; listeners still work without it.
      }
      const startX = event.clientX;
      const startWidth = panelWidth;
      let currentWidth = startWidth;
      let frame: number | null = null;
      widthGestureActiveRef.current = true;
      setResizeDragging(true);
      setPageResizeActive(true);

      // Freeze the iframe layout for the whole gesture: it stays at its
      // pre-gesture width (clipped by the panel's overflow:hidden) and
      // reflows exactly once when the gesture ends. Per-frame iframe
      // reflow is what made heavy embeds (chatgpt.com) jank and crash.
      if (iframeRef.current) {
        iframeRef.current.style.width = `${startWidth}px`;
      }

      // Live updates bypass React state entirely: the CSS variable is
      // written imperatively at most once per animation frame.
      const onMove = (moveEvent: PointerEvent) => {
        // Pointer deltas arrive in page CSS px (scaled by browser zoom);
        // panelWidth renders 1:1 in physical px (root counter-scale), so
        // multiply by the zoom factor to keep the edge tracking the cursor.
        const delta = (moveEvent.clientX - startX) * zoomFactorRef.current;
        currentWidth = browserSidebarClamp(
          Math.round(startWidth + delta),
          BROWSER_SIDEBAR_DEFAULTS.PANEL_MIN_WIDTH,
          BROWSER_SIDEBAR_DEFAULTS.PANEL_MAX_WIDTH
        );
        if (frame === null) {
          frame = requestAnimationFrame(() => {
            frame = null;
            setPanelWidthCss(currentWidth, rootRef.current);
          });
        }
      };

      const onEnd = () => {
        if (frame !== null) {
          cancelAnimationFrame(frame);
        }
        handle.removeEventListener('pointermove', onMove);
        handle.removeEventListener('pointerup', onEnd);
        handle.removeEventListener('pointercancel', onEnd);
        try {
          if (handle.hasPointerCapture(event.pointerId)) {
            handle.releasePointerCapture(event.pointerId);
          }
        } catch {
          // Element may already be detached; nothing to release.
        }
        setPageResizeActive(false);
        setResizeDragging(false);
        // One reflow for the iframe: restore fluid width so it snaps to
        // the committed panel size.
        if (iframeRef.current) {
          iframeRef.current.style.width = '';
        }
        // Single React state + storage commit at the end of the gesture.
        // Same commit path as the settings slider (saveAndBroadcast):
        // storage write + pinsUpdated broadcast, so every other open tab
        // converges on the new width. The old direct storage write left
        // already-loaded tabs on their old width — the "different sidebar
        // width on different sites" bug.
        widthGestureActiveRef.current = false;
        panelWidthRef.current = currentWidth;
        setPanelWidth(currentWidth);
        setSettings((prev) => ({ ...prev, panelWidth: currentWidth }));
        void saveAndBroadcast(pins, { ...settings, panelWidth: currentWidth }, currentWidth);
      };

      handle.addEventListener('pointermove', onMove);
      handle.addEventListener('pointerup', onEnd);
      handle.addEventListener('pointercancel', onEnd);
    },
    [panelWidth, pins, saveAndBroadcast, settings]
  );

  useEffect(() => {
    panelWidthRef.current = panelWidth;
    setCssVariables(panelWidth, rootRef.current);
    // A committed width change (drag/slider end) can newly intrude on fixed
    // elements that were previously clear of the sidebar.
    refreshFixedElementShift();
  }, [panelWidth]);

  // Fetch the tab's browser zoom once at mount (background chrome.tabs.getZoom
  // roundtrip — content scripts cannot call chrome.tabs.*).
  useEffect(() => {
    void browserSidebarSafeSendMessage<{ ok?: boolean; zoom?: number }>({
      action: 'getZoomFactor'
    }).then((response) => {
      if (typeof response?.zoom === 'number' && response.zoom > 0 && response.zoom !== 1) {
        setZoomFactor(response.zoom);
      }
    });
  }, []);

  // Apply zoom compensation: counter-scaled sidebar root + zoom-divided strip
  // width var (drives page margin + fixed-element shift). Page CSS-px layout
  // is unchanged by zoom, but the shift var change warrants a fresh sweep.
  useEffect(() => {
    zoomFactorRef.current = zoomFactor;
    setSidebarZoomFactor(zoomFactor, rootRef.current);
    refreshFixedElementShift();
  }, [zoomFactor]);

  // Convergence net for width changes made anywhere else: another tab's
  // resize (broadcast missed / message port dead), the popup, or cross-device
  // chrome.storage.sync. storage.onChanged fires in every extension context,
  // including the writer (caught by the equality check) — but NOT for changes
  // made before this tab loaded, whose width is already correct at mount.
  useEffect(() => {
    const onStorageChanged = (
      changes: Record<string, chrome.storage.StorageChange>,
      areaName: string
    ): void => {
      if (areaName !== 'sync') {
        return;
      }
      const nextWidth = (changes.settings?.newValue as { panelWidth?: number } | undefined)
        ?.panelWidth;
      if (typeof nextWidth !== 'number' || nextWidth === panelWidthRef.current) {
        return;
      }
      // Never let an external change fight a live drag/slider gesture here.
      if (widthGestureActiveRef.current) {
        return;
      }
      setPanelWidth(nextWidth);
      setSettings((prev) => ({ ...prev, panelWidth: nextWidth }));
    };

    chrome.storage.onChanged.addListener(onStorageChanged);
    return () => chrome.storage.onChanged.removeListener(onStorageChanged);
  }, []);

  useEffect(() => {
    applyLayoutClasses(sidebarHidden, panelOpen, settingsOpen);
    // Fixed elements depend on the page-shift classes applied above; re-sweep
    // after the class flip so they pick up the new shift variable.
    refreshFixedElementShift();
  }, [panelOpen, settingsOpen, sidebarHidden]);

  /**
   * Overlay mode: a click on the page outside the sidebar closes the open
   * panel. Clicks inside the closed shadow root (strip, panel, resize
   * handle) are retargeted to the host element, so any other target is
   * outside; clicks inside the cross-origin panel iframe never reach this
   * document, so interacting with the embed never dismisses it.
   */
  useEffect(() => {
    if (!panelOpen && !settingsOpen) {
      return;
    }
    const onOutsideClick = (event: MouseEvent) => {
      const target = event.target as Node | null;
      const host = document.getElementById('browser-sidebar-host');
      if (target && host && (target === host || host.contains(target))) {
        return;
      }
      if (panelOpen) {
        closePanel();
      } else if (settingsOpen) {
        setSettingsOpen(false);
      }
    };
    document.addEventListener('click', onOutsideClick, true);
    return () => document.removeEventListener('click', onOutsideClick, true);
  }, [panelOpen, settingsOpen, closePanel]);

  /**
   * Tab-switch teardown: leaving the tab closes any open panel — switching
   * back to the tab shows no panel (the user must click a pin again). Uses
   * document visibility (not a background tabs.onActivated roundtrip) so it
   * fires even while the service worker is suspended.
   */
  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.visibilityState !== 'hidden') {
        return;
      }
      if (panelOpen) {
        closePanel();
      } else if (settingsOpen) {
        setSettingsOpen(false);
      }
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => document.removeEventListener('visibilitychange', onVisibilityChange);
  }, [panelOpen, settingsOpen, closePanel]);

  /**
   * Scroll isolation for sidebar chrome: wheel events over non-scrollable
   * sidebar surfaces (panel header, fallback view, resize handle, strip
   * padding) must not scroll the host page underneath. Scrollable surfaces
   * (.icon-strip, .settings-body) contain their own overscroll via CSS;
   * wheel events inside the panel iframe never cross the frame boundary,
   * so the embed's scrolling is isolated by frameScrollGuard.ts instead.
   */
  useEffect(() => {
    const root = rootRef.current;
    if (!root) {
      return;
    }
    const onWheel = (event: WheelEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest?.('.icon-strip, .settings-body')) {
        return; // self-contained scrollers (overscroll-behavior: contain)
      }
      event.preventDefault();
    };
    root.addEventListener('wheel', onWheel, { passive: false });
    return () => root.removeEventListener('wheel', onWheel);
  }, []);

  useEffect(() => {
    const listener = (message: { action?: string; hidden?: boolean; pins?: Pin[]; settings?: Settings; level?: string; messageText?: string; payload?: unknown; url?: string; error?: string; frameId?: number; zoom?: number }, _sender: chrome.runtime.MessageSender, sendResponse: (response?: unknown) => void) => {
      if (message.action === 'netLog') {
        // DEBUG: mirror of background webRequest observations — see background.ts.
        const fn = message.level === 'error' ? console.error : console.log;
        fn('[browser-sidebar:net]', message.messageText, message.payload);
      }

      if (message.action === 'embedSubFrameFailed' && typeof message.url === 'string') {
        // The background saw the sub_frame navigation fail at the network
        // layer (e.g. net::ERR_BLOCKED_BY_RESPONSE). The in-page verification
        // cannot detect this on its own: a blocked frame and a committed
        // cross-origin document are indistinguishable from the parent
        // (SecurityError on location, no contentDocument either way).
        console.error('[browser-sidebar] Background reported sub_frame failure:', {
          url: message.url,
          error: message.error,
          frameId: message.frameId,
          activePinId: activePinIdRef.current,
          panelOpen: panelOpenRef.current
        });

        const failedOrigin = (() => {
          try {
            return new URL(message.url!).origin;
          } catch {
            return null;
          }
        })();

        const affectedPin = pinsRef.current.find((pin) => {
          try {
            return failedOrigin !== null && new URL(pin.url).origin === failedOrigin;
          } catch {
            return false;
          }
        });

        if (
          affectedPin &&
          affectedPin.id === activePinIdRef.current &&
          panelOpenRef.current &&
          !embedFailureHandledRef.current
        ) {
          handleEmbedFailureRef.current(
            affectedPin,
            `background net failure: ${message.error} (${message.url})`
          );
        }
      }

      if (message.action === 'panelFrameBooted' && typeof message.url === 'string') {
        // A panel frame's scripts are running — proof the frame committed a
        // real document. Cross-origin verification gates success on this.
        const origin = (() => {
          try {
            return new URL(message.url).origin;
          } catch {
            return null;
          }
        })();
        if (origin) {
          bootedOriginsRef.current.add(origin);
          console.log('[browser-sidebar] Frame booted (scripts running):', origin);
        }
      }

      if (message.action === 'setSidebarHidden') {
        setSidebarHidden(Boolean(message.hidden));
        sendResponse({ ok: true, hidden: Boolean(message.hidden) });
      }

      if (message.action === 'togglePanel') {
        if (panelOpenRef.current) {
          closePanel();
        } else {
          setPins((currentPins) => {
            // activePinId is cleared on close — fall back to the last
            // OPENED pin so the toolbar toggle reopens what you had, not
            // the first pin in the strip.
            const pin =
              currentPins.find((p) => p.id === lastOpenedPinIdRef.current) ?? currentPins[0];
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

        // Drop warm frames whose pin was deleted or whose URL changed —
        // the next open must be a fresh navigation.
        const validUrls = new Map(nextPins.map((p: Pin) => [p.id, p.url]));
        if (warmFramesRef.current.some((f) => validUrls.get(f.pinId) !== f.src)) {
          updateWarmFrames(warmFramesRef.current.filter((f) => validUrls.get(f.pinId) === f.src));
        }

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

      if (message.action === 'pageZoomChanged') {
        // Live zoom tracking (background tabs.onZoomChange): keep the
        // sidebar's counter-scale in sync while the user zooms the page.
        if (typeof message.zoom === 'number' && message.zoom > 0) {
          setZoomFactor(message.zoom);
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
  }, [closePanel, openPanelForPin, panelWidth, sidebarHidden, updateWarmFrames]);

  // Keep the single iframeRef pointed at the ACTIVE pin's frame element —
  // verification, diagnostics, and the resize lock all use it.
  useEffect(() => {
    iframeRef.current = frameElementsRef.current.get(activePinId ?? '') ?? null;
  }, [activePinId, warmFrames]);

  // Watch for extension-context invalidation (extension reloaded/updated
  // while this tab stayed open). Guarded calls already no-op, but the user
  // needs to know the sidebar's messaging is dead until a page refresh.
  useEffect(() => {
    const interval = setInterval(() => {
      if (!browserSidebarRuntimeAlive()) {
        setRuntimeDead(true);
      }
    }, 5000);
    return () => clearInterval(interval);
  }, []);

  // Mount-only: make sure a pending preload dwell timer never fires after
  // the sidebar unmounts (the callback would touch dead refs/state).
  useEffect(() => {
    return () => {
      clearPreloadHoverTimer();
    };
  }, [clearPreloadHoverTimer]);

  const activePin = getActivePin();

  return (
    <div
      ref={rootRef}
      className={`sidebar-root${sidebarHidden ? ' hidden' : ''}${resizeDragging || sliderResizing ? ' resizing' : ''}`}
    >
      {runtimeDead && (
        <div className="reload-notice" role="status">
          Extension reloaded — refresh this page
        </div>
      )}

      <IconStrip
        pins={pins}
        activePinId={activePinId}
        settingsOpen={settingsOpen}
        onPinClick={handlePinClick}
        onToggleSettings={toggleSettings}
        onPinHover={handlePinHover}
        onPinLeave={handlePinLeave}
        onPinPress={handlePinPress}
      />

      <AppPanel
        open={panelOpen}
        pin={activePin}
        panelView={panelView}
        fallbackPin={fallbackPin}
        warmFrames={warmFrames}
        activePinId={activePinId}
        registerFrame={registerFrameElement}
        resizing={resizeDragging || sliderResizing}
        onClose={closePanel}
        onRefresh={() => {
          if (!activePin) {
            return;
          }
          // Refresh is a forced reload: drop the warm frame so the open
          // below remounts a fresh iframe.
          evictWarmFrame(activePin.id);
          void openPanelForPin(activePin);
        }}
        onOpenInTab={() =>
          activePin && void browserSidebarSafeSendMessage({ action: 'openTab', url: activePin.url })
        }
        onIframeLoad={handleIframeLoad}
        onIframeError={handleIframeError}
        onResizeStart={handleResizeStart}
        onRepairEmbed={() => void handleRepairEmbed()}
        repairInProgress={repairInProgress}
      />

      <SettingsPanel
        open={settingsOpen}
        pins={pins}
        panelWidth={panelWidth}
        editingPinId={editingPinId}
        pinForm={pinForm}
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
          // Live slider updates: CSS variable only, no React state per input
          // event — the width label lives in SettingsPanel local state.
          widthGestureActiveRef.current = true;
          setSliderResizing(true);
          setPageResizeActive(true);
          // Lock the iframe at the pre-gesture width on the first change
          // event of the gesture; reflow happens once on commit.
          if (iframeRef.current && !iframeRef.current.style.width) {
            iframeRef.current.style.width = `${panelWidth}px`;
          }
          sliderWidthRef.current = width;
          if (sliderFrameRef.current === null) {
            sliderFrameRef.current = requestAnimationFrame(() => {
              sliderFrameRef.current = null;
              setPanelWidthCss(sliderWidthRef.current, rootRef.current);
            });
          }
        }}
        onPanelWidthCommit={(width) => {
          if (sliderFrameRef.current !== null) {
            cancelAnimationFrame(sliderFrameRef.current);
            sliderFrameRef.current = null;
          }
          // Unlock the iframe so it snaps to the committed panel size.
          if (iframeRef.current) {
            iframeRef.current.style.width = '';
          }
          setSliderResizing(false);
          setPageResizeActive(false);
          widthGestureActiveRef.current = false;
          panelWidthRef.current = width;
          setPanelWidth(width);
          setSettings((prev) => ({ ...prev, panelWidth: width }));
          void saveAndBroadcast(pins, { ...settings, panelWidth: width }, width);
        }}
        onReset={() => void handleReset()}
      />
    </div>
  );
}
