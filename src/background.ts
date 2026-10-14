/**
 * Service worker: extension lifecycle, toolbar toggle, and message routing
 * between popup, content scripts, and the sidebar panel.
 */
import { browserSidebarGetPinHostnames, browserSidebarSyncEmbedBypassRules } from './lib/embed-bypass';
import { browserSidebarRelaxPinnedSiteCookies, browserSidebarWatchPinnedSiteCookies } from './lib/cookie-auth';
import {
  browserSidebarGetStorageData,
  browserSidebarInitializeStorage,
  browserSidebarResetStorageToDefaults,
  browserSidebarSaveLastActivePinId
} from './lib/storage';
import type { Pin, Settings } from './lib/types';

// --- Extension lifecycle ---

// Allow content scripts to read/write session storage (panel-open state).
// Re-asserted on every service-worker wake; values persist per browser session.
void chrome.storage.session
  ?.setAccessLevel?.({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' })
  .catch(() => {});

// One-time cleanup of the stale pre-rename session keys (gxPanelOpen /
// gxPanelPinId); harmless no-op once they are gone.
void chrome.storage.session?.remove(['gxPanelOpen', 'gxPanelPinId']).catch(() => {});

// Re-writes pinned-site cookies so panel iframes reuse existing sessions.
// Registered synchronously so it survives service-worker restarts.
browserSidebarWatchPinnedSiteCookies();

// --- Embed-support sync with per-open fast path ---
//
// Session DNR rules live for the whole browser session and the cookie
// watcher covers re-issued cookies, so a full re-sync per panel open was
// pure latency (hundreds of ms of cookie getAll/set per click). The
// signature below marks what was last synced THIS worker lifetime; when it
// matches, ensureEmbedRules answers immediately.
let browserSidebarEmbedSyncSignature: string | null = null;

function browserSidebarComputeEmbedSyncSignature(pins: Pin[]): string {
  return pins.map((pin) => pin.url).sort().join('|');
}

/** Full embed-support sync: rules first (they gate panel navigations), cookies second. */
async function browserSidebarSyncEmbedSupport(pins: Pin[]): Promise<void> {
  await browserSidebarSyncEmbedBypassRules(pins);
  await browserSidebarRelaxPinnedSiteCookies(pins);
  browserSidebarEmbedSyncSignature = browserSidebarComputeEmbedSyncSignature(pins);
}

// Re-assert the embed-bypass DNR session rules on EVERY worker wake, not just
// onInstalled/onStartup. DNR session rules are cleared when the browser
// session ends, and Chrome does not fire onStartup on crash-restore sessions —
// leaving pinned sites un-embeddable ("refused to connect") until a pin
// change. The sync is idempotent (removeRuleIds + addRules), so re-running it
// on wake just re-writes the same two rules. Any event-driven wake (message,
// toolbar click, storage change, cookie change) re-triggers this and
// guarantees the rules exist before the panel needs them.
void browserSidebarGetStorageData()
  .then((data) => browserSidebarSyncEmbedSupport(data.pins))
  .catch((error) => {
    console.warn('[browser-sidebar] Wake-time embed bypass re-sync failed:', error);
  });

// Mirror session panel-state changes to every tab so the panel stays open
// (or closed) consistently across all tabs of the browser session.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'session' || !changes.browserSidebarPanelOpen) {
    return;
  }
  const open = Boolean(changes.browserSidebarPanelOpen.newValue);
  const pinId =
    typeof changes.browserSidebarPanelPinId?.newValue === 'string' ? changes.browserSidebarPanelPinId.newValue : null;
  void broadcastToAllTabs({ action: 'panelStateSynced', open, pinId });
});

chrome.runtime.onInstalled.addListener(async () => {
  await browserSidebarInitializeStorage();
  const data = await browserSidebarGetStorageData();
  await browserSidebarSyncEmbedSupport(data.pins);
});

chrome.runtime.onStartup.addListener(async () => {
  const data = await browserSidebarGetStorageData();
  await browserSidebarSyncEmbedSupport(data.pins);
});

// --- Toolbar icon: show/hide sidebar ---

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id || !isInjectableUrl(tab.url)) {
    return;
  }

  const stored = await chrome.storage.sync.get(['sidebarHidden']);
  const hidden = !Boolean(stored.sidebarHidden);
  await chrome.storage.sync.set({ sidebarHidden: hidden });

  try {
    await chrome.tabs.sendMessage(tab.id, { action: 'setSidebarHidden', hidden });
  } catch {
    // Content script not loaded yet — inject and retry on next toggle.
    try {
      const sidebarScript = chrome.runtime.getManifest().content_scripts?.[0]?.js?.[0];
      if (!sidebarScript) {
        return;
      }

      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: [sidebarScript]
      });
    } catch {
      // Tab may have navigated or become restricted before injection.
    }
  }

  await broadcastToAllTabs({ action: 'setSidebarHidden', hidden });
});

// --- DEBUG: network-level trace for panel embeds ---
//
// The parent-side checks cannot distinguish "cross-origin document committed"
// from "Chrome is showing an error page inside the frame" — both throw
// SecurityError on location access. These observers see the actual wire
// traffic: whether the sub_frame request fired, what headers came back
// (X-Frame-Options / CSP frame-ancestors), and whether Chrome killed it
// (ERR_BLOCKED_BY_CLIENT = host-page CSP frame-src; ERR_BLOCKED_BY_RESPONSE
// = XFO/CORP on the response).

function browserSidebarGetHeader(
  headers: chrome.webRequest.HttpHeader[] | undefined,
  name: string
): string | undefined {
  return headers?.find((header) => header.name.toLowerCase() === name)?.value;
}

/** Does the frame that sent this message have a pinned-site origin? */
async function browserSidebarSenderOriginIsPinned(
  sender: chrome.runtime.MessageSender
): Promise<boolean> {
  try {
    const frameUrl = sender.url ?? sender.origin;
    if (!frameUrl) {
      return false;
    }
    const frameOrigin = new URL(frameUrl).origin;
    const stored = (await chrome.storage.sync.get('pins')) as { pins?: Pin[] };
    return (stored.pins ?? []).some((pin) => {
      try {
        return new URL(pin.url).origin === frameOrigin;
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

/** DEBUG: log a network event in both the SW console and the tab it happened in. */
function browserSidebarNetLog(
  tabId: number | undefined,
  level: 'log' | 'error',
  message: string,
  payload: unknown
): void {
  const fn = level === 'error' ? console.error : console.log;
  fn('[browser-sidebar:net]', message, payload);
  if (typeof tabId === 'number' && tabId >= 0) {
    // Best-effort mirror into the page console — no listener = nothing to do.
    chrome.tabs
      .sendMessage(tabId, { action: 'netLog', level, messageText: message, payload })
      .catch(() => {});
  }
}

chrome.webRequest.onBeforeRequest.addListener((details) => {
  if (details.type !== 'sub_frame') {
    return;
  }
  browserSidebarNetLog(details.tabId, 'log', 'sub_frame request STARTED:', {
    url: details.url,
    initiator: details.initiator,
    documentUrl: (details as { documentUrl?: string }).documentUrl,
    frameId: details.frameId,
    parentFrameId: details.parentFrameId
  });
},
{ urls: ['<all_urls>'] });

chrome.webRequest.onBeforeSendHeaders.addListener((details) => {
  if (details.type !== 'sub_frame') {
    return;
  }
  // DEBUG: the Sec-Fetch-* headers the request actually carries. Rule 2 of
  // embed-bypass.ts should have rewritten them to look like a top-level
  // navigation — x.com serves its 'Your Request Couldn't be Processed' page
  // when Sec-Fetch-Dest: iframe survives the rewrite.
  const get = (name: string) =>
    details.requestHeaders?.find((header) => header.name.toLowerCase() === name)?.value ?? null;
  browserSidebarNetLog(details.tabId, 'log', 'sub_frame request HEADERS:', {
    url: details.url,
    secFetchDest: get('sec-fetch-dest'),
    secFetchMode: get('sec-fetch-mode'),
    secFetchSite: get('sec-fetch-site'),
    secFetchUser: get('sec-fetch-user'),
    referer: get('referer')
  });
},
{ urls: ['<all_urls>'] }, ['requestHeaders']);

chrome.webRequest.onBeforeRedirect.addListener((details) => {
  if (details.type !== 'sub_frame') {
    return;
  }
  browserSidebarNetLog(details.tabId, 'log', 'sub_frame REDIRECT:', {
    url: details.url,
    redirectUrl: details.redirectUrl,
    statusCode: details.statusCode,
    frameId: details.frameId
  });
},
{ urls: ['<all_urls>'] });

chrome.webRequest.onHeadersReceived.addListener((details) => {
  void (async () => {
    if (details.type === 'main_frame') {
      const csp = browserSidebarGetHeader(details.responseHeaders, 'content-security-policy') ?? '';
      const frameSrc = /frame-src[^;]*/i.exec(csp)?.[0];
      if (frameSrc) {
        browserSidebarNetLog(details.tabId, 'log', 'host page CSP:', {
          url: details.url,
          frameSrc
        });
      }
      return;
    }

    if (details.type !== 'sub_frame') {
      return;
    }

    // Log EVERY sub_frame response unconditionally — the filter is the thing
    // we are debugging; if x.com responses disappear, we must see it.
    const csp = browserSidebarGetHeader(details.responseHeaders, 'content-security-policy') ?? '';
    browserSidebarNetLog(details.tabId, 'log', 'sub_frame response:', {
      url: details.url,
      initiator: details.initiator,
      frameId: details.frameId,
      parentFrameId: details.parentFrameId,
      statusCode: details.statusCode,
      statusLine: (details as { statusLine?: string }).statusLine,
      // A partitioned service worker answering from its cache is the known
      // x.com failure mode — the XFO it serves is intact and DNR never sees
      // the response to strip it.
      fromCache: (details as { fromCache?: boolean }).fromCache ?? false,
      redirected: (details as { redirectUrl?: string }).redirectUrl !== details.url,
      redirectUrl: (details as { redirectUrl?: string }).redirectUrl,
      xFrameOptions: browserSidebarGetHeader(details.responseHeaders, 'x-frame-options'),
      cspFrameAncestors: /frame-ancestors[^;]*/i.exec(csp)?.[0] ?? null,
      crossOriginResourcePolicy: browserSidebarGetHeader(
        details.responseHeaders,
        'cross-origin-resource-policy'
      )
    });
  })();
},
{ urls: ['<all_urls>'] });

chrome.webRequest.onErrorOccurred.addListener((details) => {
  if (details.type !== 'sub_frame') {
    return;
  }
  browserSidebarNetLog(details.tabId, 'error', 'sub_frame FAILED:', {
    url: details.url,
    initiator: details.initiator,
    frameId: details.frameId,
    error: details.error
  });

  // Forward real net failures (ERR_BLOCKED_BY_RESPONSE, ERR_CONNECTION_*)
  // to the content script. A blocked frame is indistinguishable from a
  // committed cross-origin document to the in-page verification code
  // (SecurityError on location, no contentDocument either way) — this is
  // the only reliable blocked-frame signal.
  void (async () => {
    try {
      if (typeof details.tabId !== 'number' || details.tabId < 0) {
        return;
      }
      const hostname = new URL(details.url).hostname.replace(/^www\./, '');
      const { pins: pinned } = (await chrome.storage.sync.get('pins')) as { pins?: Pin[] };
      const isPinnedOrigin = (pinned ?? []).some((pin) => {
        try {
          return new URL(pin.url).hostname.replace(/^www\./, '') === hostname;
        } catch {
          return false;
        }
      });
      if (!isPinnedOrigin) {
        return;
      }
      await chrome.tabs.sendMessage(details.tabId, {
        action: 'embedSubFrameFailed',
        url: details.url,
        error: details.error,
        frameId: details.frameId
      });
    } catch {
      // No content script in that tab — nothing to notify.
    }
  })();
},
{ urls: ['<all_urls>'] });

// --- Runtime message handlers ---

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'openTab' && message.url) {
    chrome.tabs.create({ url: message.url });
    sendResponse({ ok: true });
    return false;
  }

  if (message.action === 'saveLastActivePin' && message.pinId) {
    void browserSidebarSaveLastActivePinId(message.pinId).then(() => sendResponse({ ok: true }));
    return true;
  }

  if (message.action === 'broadcastPinsUpdated') {
    const nextPins = message.pins as Pin[];
    void broadcastToAllTabs({
      action: 'pinsUpdated',
      pins: nextPins,
      settings: message.settings as Settings
    })
      .then(() => browserSidebarSyncEmbedSupport(nextPins))
      .then(() => sendResponse({ ok: true }));
    return true;
  }

  if (message.action === 'repairEmbedPartition') {
    // One-click repair for partitioned-service-worker embed poisoning
    // (x.com "refused to connect"): a pinned site's SW registered in the
    // (host-site, site) third-party storage partition serves panel
    // navigations from cache with X-Frame-Options intact — DNR and
    // webRequest never see those responses, so header stripping can't
    // reach them. VERIFIED on the real profile: only the FULL
    // browsingData.remove (no origins filter — a different code path than
    // the origins-scoped one, which leaves partitioned SWs in place)
    // heals the poisoned partition. Cost: clears every site's SWs, so
    // this must stay a user-invoked action, never automatic.
    void (async () => {
      try {
        console.warn('[browser-sidebar] Repair: clearing all service workers + cache...');
        await chrome.browsingData.remove({}, { serviceWorkers: true, cache: true });
        console.warn('[browser-sidebar] Repair: clear complete.');
        sendResponse({ ok: true });
      } catch (error) {
        console.error('[browser-sidebar] Repair failed:', error);
        sendResponse({ ok: false, error: String(error) });
      }
    })();
    return true;
  }

  if (message.action === 'ensureEmbedRules') {
    // Panel navigation gate: the content script awaits this response before
    // pointing the panel iframe at a pinned site, so the sub_frame request
    // can never beat the DNR session rules out of a just-woken worker.
    void (async () => {
      try {
        const data = await browserSidebarGetStorageData();
        const signature = browserSidebarComputeEmbedSyncSignature(data.pins);

        if (signature === browserSidebarEmbedSyncSignature) {
          // Fast path: rules live for the whole browser session, the cookie
          // watcher covers rotation — skip the redundant per-open re-sync.
          sendResponse({ ok: true });
          return;
        }

        console.log('[browser-sidebar] ensureEmbedRules: syncing rules for:', {
          pins: data.pins.map((pin) => pin.url)
        });
        await browserSidebarSyncEmbedSupport(data.pins);
        sendResponse({ ok: true });
      } catch (error) {
        console.error('[browser-sidebar] ensureEmbedRules failed:', error);
        sendResponse({ ok: false, error: String(error) });
      }
    })();
    return true;
  }

  if (message.action === 'shouldGuardScroll') {
    // Sub-frame guard (frameScrollGuard.ts): the frame asks whether its
    // origin belongs to a pinned site — those embeds get scroll isolation
    // (overscroll-behavior: contain) so scrolling inside the panel never
    // chains to the host page.
    void browserSidebarSenderOriginIsPinned(sender).then((isPinned) =>
      sendResponse({ ok: isPinned })
    );
    return true;
  }

  if (message.action === 'shouldManageServiceWorkers') {
    // Sub-frame SW management (frameDiagnostics.ts): pinned-origin frames
    // keep their (host-site, origin) third-party storage partition free of
    // service workers — a partitioned SW serves panel navigations from
    // cache with X-Frame-Options intact, which no other layer can strip.
    void browserSidebarSenderOriginIsPinned(sender).then((isPinned) =>
      sendResponse({ ok: isPinned })
    );
    return true;
  }

  if (message.action === 'panelFrameBooted' && typeof message.url === 'string') {
    // A pinned-origin sub-frame's scripts started running — proof that the
    // frame COMMITTED a real document (not an XFO/partition-SW error page,
    // which never executes scripts). Forwarded to the tab so the sidebar's
    // verification can use it: the parent-side view of a blocked frame and
    // a committed cross-origin document is identical otherwise.
    if (sender.tab && typeof sender.frameId === 'number' && sender.frameId > 0) {
      const tabId = sender.tab.id;
      if (typeof tabId === 'number') {
        void Promise.resolve(
          chrome.tabs.sendMessage(tabId, {
            action: 'panelFrameBooted',
            url: message.url,
            frameId: sender.frameId
          })
        ).catch(() => {});
      }
    }
    sendResponse({ ok: true });
    return false;
  }

  if (message.action === 'getStorageData') {
    void browserSidebarGetStorageData().then((data) => sendResponse(data));
    return true;
  }

  if (message.action === 'resetStorage') {
    void browserSidebarResetStorageToDefaults()
      .then((data) =>
        broadcastToAllTabs({ action: 'pinsUpdated', pins: data.pins, settings: data.settings })
          .then(() => browserSidebarSyncEmbedSupport(data.pins))
          .then(() => data)
      )
      .then((data) => sendResponse({ ok: true, data }))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  return false;
});

// --- Helpers ---

/** Returns true for standard web pages where content scripts can run. */
function isInjectableUrl(url: string | undefined): boolean {
  if (!url) {
    return false;
  }

  try {
    const { protocol } = new URL(url);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

/** Sends a message to every injectable tab, ignoring tabs without the content script. */
async function broadcastToAllTabs(message: Record<string, unknown>): Promise<void> {
  const tabs = await chrome.tabs.query({});
  await Promise.all(
    tabs.map(async (tab) => {
      if (!tab.id || !isInjectableUrl(tab.url)) {
        return;
      }

      try {
        await chrome.tabs.sendMessage(tab.id, message);
      } catch {
        // Tab may not have content script loaded yet.
      }
    })
  );
}
