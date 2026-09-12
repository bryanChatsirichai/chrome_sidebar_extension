import { GX_DEFAULTS, gxGetDefaultStorageData } from '../lib/defaults';
import type { Pin, Settings } from '../lib/types';
import pageShiftStyles from './page-shift.module.scss?inline';

const COMPANION_CONTEXT_MAX_ATTEMPTS = 3;
const COMPANION_CONTEXT_RETRY_MS = 100;

export function injectPageShiftStyles(): void {
  if (document.getElementById('gx-page-shift-styles')) {
    return;
  }

  const style = document.createElement('style');
  style.id = 'gx-page-shift-styles';
  style.textContent = pageShiftStyles;
  document.documentElement.appendChild(style);
}

export async function isCompanionContext(): Promise<boolean> {
  for (let attempt = 0; attempt < COMPANION_CONTEXT_MAX_ATTEMPTS; attempt += 1) {
    try {
      const context = await chrome.runtime.sendMessage({ action: 'getSidebarContext' });
      if (context?.isCompanionWindow) {
        return true;
      }
    } catch {
      return false;
    }

    if (attempt < COMPANION_CONTEXT_MAX_ATTEMPTS - 1) {
      await new Promise((resolve) => setTimeout(resolve, COMPANION_CONTEXT_RETRY_MS));
    }
  }

  return false;
}

export async function loadSidebarStorage(): Promise<{
  pins: Pin[];
  settings: Settings;
  activePinId: string | null;
  sidebarHidden: boolean;
  panelWidth: number;
}> {
  try {
    const stored = await chrome.storage.sync.get(['pins', 'settings', 'lastActivePinId', 'sidebarHidden']);
    const defaults = gxGetDefaultStorageData();
    const settings = { ...defaults.settings, ...(stored.settings ?? {}) };

    return {
      pins: (stored.pins ?? defaults.pins).slice().sort((a: Pin, b: Pin) => a.order - b.order),
      settings,
      activePinId: stored.lastActivePinId ?? null,
      sidebarHidden: Boolean(stored.sidebarHidden),
      panelWidth: settings.panelWidth ?? GX_DEFAULTS.DEFAULT_SETTINGS.panelWidth
    };
  } catch {
    const defaults = gxGetDefaultStorageData();
    return {
      pins: defaults.pins,
      settings: defaults.settings,
      activePinId: null,
      sidebarHidden: false,
      panelWidth: GX_DEFAULTS.DEFAULT_SETTINGS.panelWidth
    };
  }
}

export function applyLayoutClasses(sidebarHidden: boolean, settingsOpen: boolean): void {
  const html = document.documentElement;
  html.classList.remove('gx-sidebar-strip-visible', 'gx-sidebar-open', 'gx-sidebar-hidden');

  if (sidebarHidden) {
    html.classList.add('gx-sidebar-hidden');
    return;
  }

  if (settingsOpen) {
    html.classList.add('gx-sidebar-open');
  } else {
    html.classList.add('gx-sidebar-strip-visible');
  }
}

export function setCssVariables(panelWidth: number, rootEl: HTMLElement | null): void {
  document.documentElement.style.setProperty('--gx-strip-width', `${GX_DEFAULTS.STRIP_WIDTH}px`);
  document.documentElement.style.setProperty('--gx-panel-width', `${panelWidth}px`);

  if (rootEl) {
    rootEl.style.setProperty('--gx-strip-width', `${GX_DEFAULTS.STRIP_WIDTH}px`);
    rootEl.style.setProperty('--gx-panel-width', `${panelWidth}px`);
  }
}
