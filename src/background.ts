/**
 * Service worker: extension lifecycle, toolbar toggle, and message routing
 * between popup, content scripts, and the companion window manager.
 */
import {
  gxCloseCompanion,
  gxIsCompanionWindow,
  gxIsCompanionWindowAsync,
  gxNavigateWithinCompanionWindow,
  gxOpenOrNavigateCompanion,
  gxRestoreCompanionState,
  gxUpdateCompanionLayout
} from './lib/companion';
import { gxGetCompanionLayoutFromSettings } from './lib/defaults';
import { gxSyncEmbedBypassRules } from './lib/embed-bypass';
import { gxRelaxPinnedSiteCookies, gxWatchPinnedSiteCookies } from './lib/cookie-auth';
import {
  gxGetStorageData,
  gxInitializeStorage,
  gxResetStorageToDefaults,
  gxSaveLastActivePinId
} from './lib/storage';
import type { Pin, Settings } from './lib/types';

// --- Extension lifecycle ---

// Allow content scripts to read/write session storage (panel-open state).
// Re-asserted on every service-worker wake; values persist per browser session.
void chrome.storage.session
  ?.setAccessLevel?.({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' })
  .catch(() => {});

// Re-writes pinned-site cookies so panel iframes reuse existing sessions.
// Registered synchronously so it survives service-worker restarts.
gxWatchPinnedSiteCookies();

// Mirror session panel-state changes to every tab so the panel stays open
// (or closed) consistently across all tabs of the browser session.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'session' || !changes.gxPanelOpen) {
    return;
  }
  const open = Boolean(changes.gxPanelOpen.newValue);
  const pinId =
    typeof changes.gxPanelPinId?.newValue === 'string' ? changes.gxPanelPinId.newValue : null;
  void broadcastToAllTabs({ action: 'panelStateSynced', open, pinId });
});

chrome.runtime.onInstalled.addListener(async () => {
  await gxInitializeStorage();
  await gxRestoreCompanionState();
  const data = await gxGetStorageData();
  await gxSyncEmbedBypassRules(data.pins);
  await gxRelaxPinnedSiteCookies(data.pins);
});

chrome.runtime.onStartup.addListener(async () => {
  await gxRestoreCompanionState();
  const data = await gxGetStorageData();
  await gxSyncEmbedBypassRules(data.pins);
  await gxRelaxPinnedSiteCookies(data.pins);
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

  if (message.action === 'getSidebarContext') {
    void (async () => {
      let windowId = sender.tab?.windowId;
      if (!windowId && sender.tab?.id) {
        const tab = await chrome.tabs.get(sender.tab.id);
        windowId = tab.windowId;
      }
      sendResponse({ isCompanionWindow: await gxIsCompanionWindowAsync(windowId) });
    })();
    return true;
  }

  if (message.action === 'openCompanion' && message.url && message.pinId) {
    void (async () => {
      try {
        let anchorWindowId = sender.tab?.windowId;
        const tabId = sender.tab?.id;

        if (!anchorWindowId && tabId) {
          const tab = await chrome.tabs.get(tabId);
          anchorWindowId = tab.windowId;
        }

        if (!anchorWindowId) {
          sendResponse({ ok: false, error: 'No anchor window' });
          return;
        }

        let result;

        if (await gxIsCompanionWindowAsync(anchorWindowId)) {
          result = await gxNavigateWithinCompanionWindow(tabId!, message.url, message.pinId);
        } else {
          const data = await gxGetStorageData();
          const layout = gxGetCompanionLayoutFromSettings({
            ...data.settings,
            ...(message.companionSettings ?? message.companionLayout ?? {})
          });

          result = await gxOpenOrNavigateCompanion({
            url: message.url,
            pinId: message.pinId,
            anchorWindowId,
            layout
          });
        }

        if (result.open && result.pinId) {
          await gxSaveLastActivePinId(result.pinId);
        }

        sendResponse(result);
      } catch (error) {
        console.error('[GX Sidebar] openCompanion failed:', error);
        sendResponse({ ok: false, error: String(error) });
      }
    })();
    return true;
  }

  if (message.action === 'closeCompanion') {
    void (async () => {
      const senderWindowId = sender.tab?.windowId;
      if (gxIsCompanionWindow(senderWindowId)) {
        sendResponse({ ok: true, open: true, skipped: true });
        return;
      }
      sendResponse(await gxCloseCompanion());
    })();
    return true;
  }

  if (message.action === 'saveLastActivePin' && message.pinId) {
    void gxSaveLastActivePinId(message.pinId).then(() => sendResponse({ ok: true }));
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
        if (message.settings) {
          tasks.push(gxUpdateCompanionLayout(gxGetCompanionLayoutFromSettings(message.settings)));
        }
        if (nextPins) {
          tasks.push(gxSyncEmbedBypassRules(nextPins));
          tasks.push(gxRelaxPinnedSiteCookies(nextPins));
        }
        return Promise.all(tasks);
      })
      .then(() => sendResponse({ ok: true }));
    return true;
  }

  if (message.action === 'getStorageData') {
    void gxGetStorageData().then((data) => sendResponse(data));
    return true;
  }

  if (message.action === 'resetStorage') {
    void gxResetStorageToDefaults()
      .then((data) =>
        broadcastToAllTabs({ action: 'pinsUpdated', pins: data.pins, settings: data.settings })
          .then(() => gxSyncEmbedBypassRules(data.pins))
          .then(() => gxRelaxPinnedSiteCookies(data.pins))
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
