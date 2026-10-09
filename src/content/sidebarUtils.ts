import { BROWSER_SIDEBAR_DEFAULTS, browserSidebarGetDefaultStorageData } from '../lib/defaults';
import type { Pin, Settings } from '../lib/types';
import pageShiftStyles from './page-shift.module.scss?inline';

export function injectPageShiftStyles(): void {
  if (document.getElementById('browser-sidebar-page-shift-styles')) {
    return;
  }

  const style = document.createElement('style');
  style.id = 'browser-sidebar-page-shift-styles';
  style.textContent = pageShiftStyles;
  document.documentElement.appendChild(style);
}

export async function loadSidebarStorage(): Promise<{
  pins: Pin[];
  settings: Settings;
  activePinId: string | null;
  sidebarHidden: boolean;
  panelWidth: number;
  panelSession: { open: boolean; pinId: string | null };
}> {
  try {
    const stored = await chrome.storage.sync.get(['pins', 'settings', 'lastActivePinId', 'sidebarHidden']);
    const defaults = browserSidebarGetDefaultStorageData();
    const settings = { ...defaults.settings, ...(stored.settings ?? {}) };

    // Session-scoped panel state shared across tabs of this browser session
    // (content scripts need the access level the background grants at startup).
    let panelSession = { open: false, pinId: null as string | null };
    try {
      const session = await chrome.storage.session?.get(['browserSidebarPanelOpen', 'browserSidebarPanelPinId']);
      if (session) {
        panelSession = {
          open: Boolean(session.browserSidebarPanelOpen),
          pinId: typeof session.browserSidebarPanelPinId === 'string' ? session.browserSidebarPanelPinId : null
        };
      }
    } catch {
      // Access level not granted yet this session — panel starts closed.
    }

    return {
      pins: (stored.pins ?? defaults.pins).slice().sort((a: Pin, b: Pin) => a.order - b.order),
      settings,
      activePinId: stored.lastActivePinId ?? null,
      sidebarHidden: Boolean(stored.sidebarHidden),
      panelWidth: settings.panelWidth ?? BROWSER_SIDEBAR_DEFAULTS.DEFAULT_SETTINGS.panelWidth,
      panelSession
    };
  } catch {
    const defaults = browserSidebarGetDefaultStorageData();
    return {
      pins: defaults.pins,
      settings: defaults.settings,
      activePinId: null,
      sidebarHidden: false,
      panelWidth: BROWSER_SIDEBAR_DEFAULTS.DEFAULT_SETTINGS.panelWidth,
      panelSession: { open: false, pinId: null }
    };
  }
}

export function applyLayoutClasses(
  sidebarHidden: boolean,
  panelOpen: boolean,
  settingsOpen: boolean
): void {
  const html = document.documentElement;
  html.classList.remove('browser-sidebar-strip-visible', 'browser-sidebar-open', 'browser-sidebar-hidden');

  if (sidebarHidden) {
    html.classList.add('browser-sidebar-hidden');
    return;
  }

  if (panelOpen || settingsOpen) {
    html.classList.add('browser-sidebar-open');
  } else {
    html.classList.add('browser-sidebar-strip-visible');
  }
}

export function setCssVariables(panelWidth: number, rootEl: HTMLElement | null): void {
  document.documentElement.style.setProperty('--browser-sidebar-strip-width', `${BROWSER_SIDEBAR_DEFAULTS.STRIP_WIDTH}px`);
  document.documentElement.style.setProperty('--browser-sidebar-panel-width', `${panelWidth}px`);

  if (rootEl) {
    rootEl.style.setProperty('--browser-sidebar-strip-width', `${BROWSER_SIDEBAR_DEFAULTS.STRIP_WIDTH}px`);
    rootEl.style.setProperty('--browser-sidebar-panel-width', `${panelWidth}px`);
  }
}

/**
 * Live panel-width update used during drag/slider gestures: writes only the
 * CSS variable imperatively (no React state), so the sidebar tree — including
 * the embed iframe — does not re-render on every pointer event.
 */
export function setPanelWidthCss(panelWidth: number, rootEl: HTMLElement | null): void {
  const width = `${panelWidth}px`;
  document.documentElement.style.setProperty('--browser-sidebar-panel-width', width);

  if (rootEl) {
    rootEl.style.setProperty('--browser-sidebar-panel-width', width);
  }
}

/**
 * Toggles the page-level flag that disables the margin-left transition on the
 * host page while a live resize is in progress, so the shifted page tracks the
 * cursor exactly instead of rubber-banding behind a 0.2s transition.
 */
export function setPageResizeActive(active: boolean): void {
  document.documentElement.classList.toggle('browser-sidebar-resizing', active);
}
