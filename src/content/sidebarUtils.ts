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
  sidebarHidden: boolean;
  panelWidth: number;
}> {
  try {
    const stored = await chrome.storage.sync.get(['pins', 'settings', 'sidebarHidden']);
    const defaults = browserSidebarGetDefaultStorageData();
    const settings = { ...defaults.settings, ...(stored.settings ?? {}) };

    return {
      pins: (stored.pins ?? defaults.pins).slice().sort((a: Pin, b: Pin) => a.order - b.order),
      settings,
      sidebarHidden: Boolean(stored.sidebarHidden),
      panelWidth: settings.panelWidth ?? BROWSER_SIDEBAR_DEFAULTS.DEFAULT_SETTINGS.panelWidth
    };
  } catch {
    const defaults = browserSidebarGetDefaultStorageData();
    return {
      pins: defaults.pins,
      settings: defaults.settings,
      sidebarHidden: false,
      panelWidth: BROWSER_SIDEBAR_DEFAULTS.DEFAULT_SETTINGS.panelWidth
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

/**
 * Browser-zoom factor of this tab (1 = 100%). The sidebar is injected in-page,
 * so page zoom would scale it physically; we counteract it so the sidebar
 * always renders at the same physical size regardless of zoom.
 */
let sidebarZoomFactor = 1;

export function getSidebarZoomFactor(): number {
  return sidebarZoomFactor;
}

/**
 * Store the tab's zoom and apply compensation:
 * - `--browser-sidebar-strip-width` becomes STRIP_WIDTH / zoom in CSS px, so
 *   the page margin + fixed-element shift also stay at the same physical size.
 * - The sidebar root is counter-scaled by 1/zoom (height 100vh * zoom so it
 *   still fills the viewport), so every px inside the shadow tree renders at
 *   its nominal physical size — panel width, icons, fonts, and the embedded
 *   iframe (which nets out to an effective 100% zoom).
 */
export function setSidebarZoomFactor(z: number, rootEl: HTMLElement | null): void {
  const safe = Number.isFinite(z) && z > 0 ? z : 1;
  sidebarZoomFactor = safe;
  applyStripWidthVars(rootEl);
  if (rootEl) {
    if (safe === 1) {
      // Keep the 100% path DOM-identical to the pre-zoom-compensation build
      // (transform would also create a containing block for fixed children).
      rootEl.style.transform = '';
      rootEl.style.transformOrigin = '';
      rootEl.style.height = '';
    } else {
      rootEl.style.transformOrigin = '0 0';
      rootEl.style.transform = `scale(${1 / safe})`;
      rootEl.style.height = `calc(100vh * ${safe})`;
    }
  }
}

/**
 * The strip-width custom property is read on BOTH sides of the shadow
 * boundary and needs different values under zoom compensation:
 * - documentElement (page side: html margin-left + --browser-sidebar-shift):
 *   STRIP_WIDTH / zoom CSS px, so the physical shift stays 48 device px.
 * - sidebar root (inside the counter-scaled shadow tree): STRIP_WIDTH — the
 *   root's scale(1/zoom) cancels the page zoom, so CSS px inside the root
 *   already render 1:1 in physical px.
 */
function applyStripWidthVars(rootEl: HTMLElement | null): void {
  document.documentElement.style.setProperty(
    '--browser-sidebar-strip-width',
    `${BROWSER_SIDEBAR_DEFAULTS.STRIP_WIDTH / sidebarZoomFactor}px`
  );
  if (rootEl) {
    rootEl.style.setProperty(
      '--browser-sidebar-strip-width',
      `${BROWSER_SIDEBAR_DEFAULTS.STRIP_WIDTH}px`
    );
  }
}

export function setCssVariables(panelWidth: number, rootEl: HTMLElement | null): void {
  applyStripWidthVars(rootEl);
  document.documentElement.style.setProperty('--browser-sidebar-panel-width', `${panelWidth}px`);

  if (rootEl) {
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
