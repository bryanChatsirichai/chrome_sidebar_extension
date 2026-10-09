/**
 * Companion window lifecycle: create, reposition, navigate, and close
 * the popup used when sites cannot embed in the sidebar iframe.
 */
import { GX_DEFAULTS, gxClamp, gxGetCompanionLayoutFromSettings } from './defaults';
import type {
  CompanionLayout,
  CompanionOpenResult,
  CompanionState,
  DisplayWorkArea,
  Settings,
  WindowBounds
} from './types';

/** Live companion window state mirrored to chrome.storage.session. */
const companionState: CompanionState = {
  windowId: null,
  pinId: null,
  anchorWindowId: null,
  layout: gxGetCompanionLayoutFromSettings(GX_DEFAULTS.DEFAULT_SETTINGS)
};

let listenersRegistered = false;
let repositionTimer: ReturnType<typeof setTimeout> | null = null;
let companionOperation: Promise<CompanionOpenResult> | null = null;
let companionCreateInProgress = false;

/** Positions that follow the anchor browser window when it moves or resizes. */
function gxCompanionTracksAnchor(position: CompanionLayout['position']): boolean {
  return position === 'right' || position === 'left';
}

/** Restores companion state from session storage after a service worker restart. */
export async function gxRestoreCompanionState(): Promise<void> {
  const stored = await chrome.storage.session.get('companion');
  if (!stored.companion?.windowId) {
    return;
  }

  try {
    await chrome.windows.get(stored.companion.windowId);
    Object.assign(companionState, stored.companion);
    companionState.layout = gxGetCompanionLayoutFromSettings(
      stored.companion.layout ?? { companionWidth: stored.companion.width }
    );
  } catch {
    await gxClearCompanionState();
  }
}

/** Persists current companion state to session storage. */
async function gxSaveCompanionState(): Promise<void> {
  await chrome.storage.session.set({ companion: { ...companionState } });
}

/** Clears companion tracking and removes session storage entry. */
export async function gxClearCompanionState(): Promise<void> {
  companionState.windowId = null;
  companionState.pinId = null;
  companionState.anchorWindowId = null;
  companionState.layout = gxGetCompanionLayoutFromSettings(GX_DEFAULTS.DEFAULT_SETTINGS);
  await chrome.storage.session.remove('companion');
}

/** Synchronous check against in-memory companion window ID. */
export function gxIsCompanionWindow(windowId: number | undefined): boolean {
  return Boolean(windowId && companionState.windowId && windowId === companionState.windowId);
}

/** Checks in-memory state first, then session storage for companion window ID. */
export async function gxIsCompanionWindowAsync(windowId: number | undefined): Promise<boolean> {
  if (gxIsCompanionWindow(windowId)) {
    return true;
  }

  const stored = await chrome.storage.session.get('companion');
  return Boolean(stored.companion?.windowId && windowId === stored.companion.windowId);
}

/** Returns the primary display work area, or a sensible fallback when unavailable. */
async function gxGetDisplayWorkArea(): Promise<DisplayWorkArea> {
  if (!chrome.system?.display?.getInfo) {
    return { left: 0, top: 0, width: 1280, height: 800 };
  }

  const displays = await chrome.system.display.getInfo();
  const display = displays.find((entry) => entry.isPrimary) ?? displays[0];
  return display?.workArea ?? { left: 0, top: 0, width: 1280, height: 800 };
}

/** Ensures a Chrome window object has all four numeric bounds fields. */
function gxHasWindowBounds(window: chrome.windows.Window): window is chrome.windows.Window & WindowBounds {
  return (
    Number.isFinite(window.left) &&
    Number.isFinite(window.top) &&
    Number.isFinite(window.width) &&
    Number.isFinite(window.height)
  );
}

/** Resolves companion height from fixed setting, anchor window, or screen work area. */
function gxResolveCompanionHeight(
  layout: CompanionLayout,
  anchor: (chrome.windows.Window & WindowBounds) | null,
  workArea: DisplayWorkArea
): number {
  if (layout.heightMode === 'fixed') {
    return gxClamp(layout.height, GX_DEFAULTS.COMPANION_MIN_HEIGHT, GX_DEFAULTS.COMPANION_MAX_HEIGHT);
  }

  if (anchor && gxHasWindowBounds(anchor)) {
    return Math.max(GX_DEFAULTS.COMPANION_MIN_HEIGHT, Math.round(anchor.height));
  }

  return Math.max(GX_DEFAULTS.COMPANION_MIN_HEIGHT, Math.round(workArea.height));
}

/** Computes top-left origin for the companion based on position preference. */
function gxResolveCompanionPosition(
  layout: CompanionLayout,
  anchor: (chrome.windows.Window & WindowBounds) | null,
  workArea: DisplayWorkArea,
  width: number
): { left: number; top: number } {
  if (layout.position === 'left' && anchor && gxHasWindowBounds(anchor)) {
    return {
      left: Math.round(anchor.left - width),
      top: Math.round(anchor.top)
    };
  }

  if (layout.position === 'screen-left') {
    return {
      left: Math.round(workArea.left),
      top: Math.round(workArea.top)
    };
  }

  if (layout.position === 'screen-right') {
    return {
      left: Math.round(workArea.left + workArea.width - width),
      top: Math.round(workArea.top)
    };
  }

  if (anchor && gxHasWindowBounds(anchor)) {
    return {
      left: Math.round(anchor.left + anchor.width),
      top: Math.round(anchor.top)
    };
  }

  return {
    left: Math.round(workArea.left + workArea.width - width),
    top: Math.round(workArea.top)
  };
}

/** Keeps window bounds within the visible work area. */
function gxClampBoundsToWorkArea(bounds: WindowBounds, workArea: DisplayWorkArea): WindowBounds {
  const width = Math.min(bounds.width, workArea.width);
  const height = Math.min(bounds.height, workArea.height);
  const maxLeft = workArea.left + workArea.width - width;
  const maxTop = workArea.top + workArea.height - height;

  return {
    left: gxClamp(bounds.left, workArea.left, maxLeft),
    top: gxClamp(bounds.top, workArea.top, maxTop),
    width,
    height
  };
}

/** Calculates final pixel bounds for a new or repositioned companion window. */
async function gxGetCompanionBounds(
  anchorWindowId: number,
  layout: Partial<Settings & CompanionLayout>
): Promise<WindowBounds> {
  const normalizedLayout = gxGetCompanionLayoutFromSettings(layout);
  const workArea = await gxGetDisplayWorkArea();
  let anchor: chrome.windows.Window | null = null;

  try {
    anchor = await chrome.windows.get(anchorWindowId);
  } catch {
    anchor = null;
  }

  const boundedAnchor = anchor && gxHasWindowBounds(anchor) ? anchor : null;
  const width = normalizedLayout.width;
  const height = gxResolveCompanionHeight(normalizedLayout, boundedAnchor, workArea);
  const position = gxResolveCompanionPosition(normalizedLayout, boundedAnchor, workArea, width);

  return gxClampBoundsToWorkArea(
    {
      left: position.left,
      top: position.top,
      width,
      height
    },
    workArea
  );
}

/** Builds chrome.windows.create options, omitting position when coordinates are invalid. */
function buildWindowCreateOptions(bounds: WindowBounds, url: string): chrome.windows.CreateData {
  const options: chrome.windows.CreateData = {
    url,
    type: 'popup',
    focused: true,
    width: bounds.width,
    height: bounds.height
  };

  if (Number.isFinite(bounds.left) && Number.isFinite(bounds.top)) {
    options.left = bounds.left;
    options.top = bounds.top;
  }

  return options;
}

/** Opens a new companion popup, retrying without position if the OS rejects coordinates. */
async function gxCreateCompanionWindow(
  url: string,
  anchorWindowId: number,
  layout: Partial<Settings & CompanionLayout>
): Promise<chrome.windows.Window> {
  const bounds = await gxGetCompanionBounds(anchorWindowId, layout);

  try {
    return await chrome.windows.create(buildWindowCreateOptions(bounds, url));
  } catch (positionedError) {
    console.warn('[GX Sidebar] Positioned companion create failed, retrying:', positionedError);
    return chrome.windows.create({
      url,
      type: 'popup',
      focused: true,
      width: bounds.width,
      height: bounds.height
    });
  }
}

/** Applies current layout bounds to the existing companion window. */
async function gxApplyCompanionWindowBounds(): Promise<void> {
  if (!(await gxEnsureValidCompanionWindow())) {
    return;
  }

  try {
    const bounds = await gxGetCompanionBounds(companionState.anchorWindowId!, companionState.layout);
    await chrome.windows.update(companionState.windowId!, {
      left: bounds.left,
      top: bounds.top,
      width: bounds.width,
      height: bounds.height
    });
  } catch (error) {
    console.warn('[GX Sidebar] Failed to apply companion bounds:', error);
  }
}

/** Repositions companion when anchor-relative layout is active. */
async function gxRepositionCompanion(): Promise<void> {
  if (!companionState.windowId || !companionState.anchorWindowId) {
    return;
  }

  if (!gxCompanionTracksAnchor(companionState.layout.position)) {
    return;
  }

  await gxApplyCompanionWindowBounds();
}

/** Debounces rapid anchor window resize/move events before repositioning. */
function scheduleRepositionCompanion(): void {
  if (!gxCompanionTracksAnchor(companionState.layout.position)) {
    return;
  }

  if (repositionTimer) {
    clearTimeout(repositionTimer);
  }

  repositionTimer = setTimeout(() => {
    repositionTimer = null;
    void gxRepositionCompanion();
  }, 150);
}

/**
 * Fetches the companion tab, retrying briefly: right after window creation
 * (or during tab churn) `windows.get` can resolve before `tabs` is populated,
 * which previously surfaced as an intermittent 'Companion tab missing' error.
 */
async function gxGetCompanionTab(windowId: number): Promise<chrome.tabs.Tab | null> {
  const GET_TAB_ATTEMPTS = 4;
  const GET_TAB_RETRY_MS = 150;

  for (let attempt = 0; attempt < GET_TAB_ATTEMPTS; attempt++) {
    try {
      const win = await chrome.windows.get(windowId, { populate: true });
      const tab = win.tabs?.find((candidate) => typeof candidate.id === 'number');
      if (tab) {
        return tab;
      }
    } catch {
      return null;
    }

    await new Promise((resolve) => setTimeout(resolve, GET_TAB_RETRY_MS));
  }

  return null;
}

/** Navigates the companion tab to a new URL and updates tracked state. */
async function gxNavigateCompanionTab(
  url: string,
  pinId: string,
  anchorWindowId: number,
  layout: Partial<Settings & CompanionLayout>
): Promise<void> {
  const tab = await gxGetCompanionTab(companionState.windowId!);

  if (!tab?.id) {
    throw new Error('Companion tab missing');
  }

  await chrome.tabs.update(tab.id, { url, active: true });
  await chrome.windows.update(companionState.windowId!, { focused: true });

  companionState.pinId = pinId;
  companionState.anchorWindowId = anchorWindowId;
  companionState.layout = gxGetCompanionLayoutFromSettings(layout);
  await gxSaveCompanionState();
  await gxApplyCompanionWindowBounds();
}

/** Verifies the companion window still exists; clears stale state if not. */
async function gxEnsureValidCompanionWindow(): Promise<boolean> {
  if (!companionState.windowId) {
    return false;
  }

  try {
    await chrome.windows.get(companionState.windowId);
    return true;
  } catch {
    await gxClearCompanionState();
    return false;
  }
}

/**
 * Opens or reuses the companion window for a pin.
 * Serializes concurrent calls through a single in-flight promise.
 */
export async function gxOpenOrNavigateCompanion(params: {
  url: string;
  pinId: string;
  anchorWindowId: number;
  layout: Partial<Settings & CompanionLayout>;
}): Promise<CompanionOpenResult> {
  if (companionOperation) {
    return companionOperation;
  }

  companionOperation = gxOpenOrNavigateCompanionInternal(params).finally(() => {
    companionOperation = null;
  });

  return companionOperation;
}

async function gxOpenOrNavigateCompanionInternal(params: {
  url: string;
  pinId: string;
  anchorWindowId: number;
  layout: Partial<Settings & CompanionLayout>;
}): Promise<CompanionOpenResult> {
  const { url, pinId, anchorWindowId, layout } = params;
  const normalizedLayout = gxGetCompanionLayoutFromSettings(layout);
  gxRegisterCompanionListeners();

  if (await gxEnsureValidCompanionWindow()) {
    await gxNavigateCompanionTab(url, pinId, anchorWindowId, normalizedLayout);
    return { ok: true, open: true, pinId, reused: true };
  }

  while (companionCreateInProgress) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    if (await gxEnsureValidCompanionWindow()) {
      await gxNavigateCompanionTab(url, pinId, anchorWindowId, normalizedLayout);
      return { ok: true, open: true, pinId, reused: true };
    }
  }

  companionCreateInProgress = true;

  try {
    if (await gxEnsureValidCompanionWindow()) {
      await gxNavigateCompanionTab(url, pinId, anchorWindowId, normalizedLayout);
      return { ok: true, open: true, pinId, reused: true };
    }

    const created = await gxCreateCompanionWindow(url, anchorWindowId, normalizedLayout);

    companionState.windowId = created.id ?? null;
    companionState.pinId = pinId;
    companionState.anchorWindowId = anchorWindowId;
    companionState.layout = normalizedLayout;
    await gxSaveCompanionState();
    await gxApplyCompanionWindowBounds();

    return { ok: true, open: true, pinId, reused: false };
  } finally {
    companionCreateInProgress = false;
  }
}

/** Navigates within the companion window when the request originates from that window. */
export async function gxNavigateWithinCompanionWindow(
  tabId: number,
  url: string,
  pinId: string
): Promise<CompanionOpenResult> {
  if (!tabId) {
    throw new Error('Missing companion tab');
  }

  await chrome.tabs.update(tabId, { url, active: true });

  if (companionState.windowId) {
    companionState.pinId = pinId;
    await gxSaveCompanionState();
  }

  return { ok: true, open: true, pinId, navigatedInPlace: true };
}

/** Closes the companion window and notifies content scripts. */
export async function gxCloseCompanion(): Promise<CompanionOpenResult> {
  if (!(await gxEnsureValidCompanionWindow())) {
    return { ok: true, open: false };
  }

  const closedPinId = companionState.pinId;

  try {
    await chrome.windows.remove(companionState.windowId!);
  } catch {
    // Window may already be closed.
  }

  await gxClearCompanionState();
  await broadcastCompanionClosed(closedPinId);

  return { ok: true, open: false };
}

/** Applies updated layout settings to an open companion window. */
export async function gxUpdateCompanionLayout(layout: Partial<Settings & CompanionLayout>): Promise<void> {
  if (!(await gxEnsureValidCompanionWindow())) {
    return;
  }

  companionState.layout = gxGetCompanionLayoutFromSettings(layout);
  await gxSaveCompanionState();
  await gxApplyCompanionWindowBounds();
}

/** Registers one-time listeners for anchor moves and window close events. */
function gxRegisterCompanionListeners(): void {
  if (listenersRegistered) {
    return;
  }

  listenersRegistered = true;

  if (chrome.windows.onBoundsChanged) {
    chrome.windows.onBoundsChanged.addListener((window) => {
      if (window.id !== companionState.anchorWindowId) {
        return;
      }
      scheduleRepositionCompanion();
    });
  }

  chrome.windows.onRemoved.addListener((windowId) => {
    if (windowId === companionState.windowId) {
      const closedPinId = companionState.pinId;
      void gxClearCompanionState().then(() => {
        void broadcastCompanionClosed(closedPinId);
      });
      return;
    }

    if (windowId === companionState.anchorWindowId && companionState.windowId) {
      const closedPinId = companionState.pinId;
      chrome.windows.remove(companionState.windowId).catch(() => {});
      void gxClearCompanionState().then(() => broadcastCompanionClosed(closedPinId));
    }
  });
}

/** Notifies all tabs that the companion window closed so UI can deselect pins. */
async function broadcastCompanionClosed(pinId: string | null): Promise<void> {
  const tabs = await chrome.tabs.query({});
  await Promise.all(
    tabs.map(async (tab) => {
      if (!tab.id) {
        return;
      }

      try {
        await chrome.tabs.sendMessage(tab.id, { action: 'companionClosed', pinId });
      } catch {
        // Tab may not have content script loaded yet.
      }
    })
  );
}
