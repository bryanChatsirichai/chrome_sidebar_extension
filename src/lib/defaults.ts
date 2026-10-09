import type { Pin, Settings, StorageData } from './types';

/** Central constants for layout limits, default pins, and embed detection. */
export const BROWSER_SIDEBAR_DEFAULTS = {
  STRIP_WIDTH: 48,
  PANEL_WIDTH: 600,
  PANEL_MIN_WIDTH: 300,
  PANEL_MAX_WIDTH: 1000,
  IFRAME_LOAD_TIMEOUT_MS: 15000,

  DEFAULT_PINS: [
    {
      id: 'messenger',
      name: 'Messenger',
      url: 'https://www.messenger.com',
      iconUrl: 'icons/apps/messenger.svg',
      order: 0
    },
    {
      id: 'instagram',
      name: 'Instagram',
      url: 'https://www.instagram.com',
      iconUrl: 'icons/apps/instagram.svg',
      order: 1
    },
    {
      id: 'x',
      name: 'X',
      url: 'https://x.com',
      iconUrl: 'icons/apps/x.svg',
      order: 2
    },
    {
      id: 'youtube',
      name: 'YouTube',
      url: 'https://www.youtube.com',
      iconUrl: 'icons/apps/youtube.svg',
      order: 3
    },
    {
      id: 'youtube-music',
      name: 'YouTube Music',
      url: 'https://music.youtube.com',
      iconUrl: 'icons/apps/youtube-music.svg',
      order: 4
    },
    {
      id: 'chatgpt',
      name: 'ChatGPT',
      url: 'https://chatgpt.com',
      iconUrl: 'icons/apps/chatgpt.svg',
      order: 5
    },
    {
      id: 'claude',
      name: 'Claude',
      url: 'https://claude.ai',
      iconUrl: 'icons/apps/claude.svg',
      order: 6
    }
  ] satisfies Pin[],

  DEFAULT_SETTINGS: {
    panelWidth: 600,
    theme: 'dark'
  } satisfies Settings
} as const;

/** Clamps a numeric value to an inclusive [min, max] range. */
export function browserSidebarClamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Returns a fresh copy of the factory-default storage snapshot. */
export function browserSidebarGetDefaultStorageData(): StorageData {
  return {
    pins: BROWSER_SIDEBAR_DEFAULTS.DEFAULT_PINS.map((pin) => ({ ...pin })),
    settings: { ...BROWSER_SIDEBAR_DEFAULTS.DEFAULT_SETTINGS },
    lastActivePinId: BROWSER_SIDEBAR_DEFAULTS.DEFAULT_PINS[0].id,
    sidebarHidden: false
  };
}
