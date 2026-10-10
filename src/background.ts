/**
 * Service worker: extension lifecycle, toolbar toggle, and message routing
 * between popup, content scripts, and the sidebar panel.
 */
import { browserSidebarSyncEmbedBypassRules } from './lib/embed-bypass';
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
  await browserSidebarSyncEmbedBypassRules(data.pins);
  await browserSidebarRelaxPinnedSiteCookies(data.pins);
});

chrome.runtime.onStartup.addListener(async () => {
  const data = await browserSidebarGetStorageData();
  await browserSidebarSyncEmbedBypassRules(data.pins);
  await browserSidebarRelaxPinnedSiteCookies(data.pins);
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
      .then(() => {
        const tasks: Promise<unknown>[] = [];
        if (nextPins) {
          tasks.push(browserSidebarSyncEmbedBypassRules(nextPins));
          tasks.push(browserSidebarRelaxPinnedSiteCookies(nextPins));
        }
        return Promise.all(tasks);
      })
      .then(() => sendResponse({ ok: true }));
    return true;
  }

  if (message.action === 'shouldGuardScroll') {
    // Sub-frame guard (frameScrollGuard.ts): the frame asks whether its
    // origin belongs to a pinned site — those embeds get scroll isolation
    // (overscroll-behavior: contain) so scrolling inside the panel never
    // chains to the host page.
    void (async () => {
      try {
        const frameUrl = sender.url ?? sender.origin;
        if (!frameUrl) {
          sendResponse({ ok: false });
          return;
        }
        const frameOrigin = new URL(frameUrl).origin;
        const stored = (await chrome.storage.sync.get('pins')) as { pins?: Pin[] };
        const isPinned = (stored.pins ?? []).some((pin) => {
          try {
            return new URL(pin.url).origin === frameOrigin;
          } catch {
            return false;
          }
        });
        sendResponse({ ok: isPinned });
      } catch {
        sendResponse({ ok: false });
      }
    })();
    return true;
  }

  if (message.action === 'getStorageData') {
    void browserSidebarGetStorageData().then((data) => sendResponse(data));
    return true;
  }

  if (message.action === 'resetStorage') {
    void browserSidebarResetStorageToDefaults()
      .then((data) =>
        broadcastToAllTabs({ action: 'pinsUpdated', pins: data.pins, settings: data.settings })
          .then(() => browserSidebarSyncEmbedBypassRules(data.pins))
          .then(() => browserSidebarRelaxPinnedSiteCookies(data.pins))
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
