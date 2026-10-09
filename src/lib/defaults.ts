import type { CompanionLayout, Pin, Settings, StorageData } from './types';

/** Central constants for layout limits, default pins, and embed detection. */
export const GX_DEFAULTS = {
  STRIP_WIDTH: 48,
  PANEL_WIDTH: 400,
  PANEL_MIN_WIDTH: 300,
  PANEL_MAX_WIDTH: 600,
  COMPANION_MIN_WIDTH: 300,
  COMPANION_MAX_WIDTH: 900,
  COMPANION_MIN_HEIGHT: 400,
  COMPANION_MAX_HEIGHT: 1200,
  COMPANION_POSITIONS: ['right', 'left', 'screen-right', 'screen-left'] as const,
  COMPANION_HEIGHT_MODES: ['match', 'fixed'] as const,
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
    panelWidth: 400,
    theme: 'dark',
    companionWidth: 400,
    companionHeightMode: 'match',
    companionHeight: 800,
    companionPosition: 'right'
  } satisfies Settings
} as const;

/** Clamps a numeric value to an inclusive [min, max] range. */
export function gxClamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Type guard for a layout object already in normalized companion form. */
function gxIsNormalizedCompanionLayout(value: unknown): value is CompanionLayout {
  return (
    typeof value === 'object' &&
    value !== null &&
    Number.isFinite(Number((value as CompanionLayout).width)) &&
    GX_DEFAULTS.COMPANION_HEIGHT_MODES.includes((value as CompanionLayout).heightMode) &&
    GX_DEFAULTS.COMPANION_POSITIONS.includes((value as CompanionLayout).position)
  );
}

/**
 * Converts partial settings or a raw layout into clamped companion window dimensions.
 * Accepts either Settings field names or normalized CompanionLayout keys.
 */
export function gxGetCompanionLayoutFromSettings(
  settings: Partial<Settings & CompanionLayout> = {}
): CompanionLayout {
  const defaults = GX_DEFAULTS.DEFAULT_SETTINGS;

  if (gxIsNormalizedCompanionLayout(settings)) {
    return {
      width: gxClamp(
        Math.round(Number(settings.width)),
        GX_DEFAULTS.COMPANION_MIN_WIDTH,
        GX_DEFAULTS.COMPANION_MAX_WIDTH
      ),
      heightMode: settings.heightMode,
      height: gxClamp(
        Math.round(Number(settings.height ?? defaults.companionHeight)),
        GX_DEFAULTS.COMPANION_MIN_HEIGHT,
        GX_DEFAULTS.COMPANION_MAX_HEIGHT
      ),
      position: settings.position
    };
  }

  const heightMode = GX_DEFAULTS.COMPANION_HEIGHT_MODES.includes(
    settings.companionHeightMode as (typeof GX_DEFAULTS.COMPANION_HEIGHT_MODES)[number]
  )
    ? (settings.companionHeightMode as (typeof GX_DEFAULTS.COMPANION_HEIGHT_MODES)[number])
    : defaults.companionHeightMode;

  const position = GX_DEFAULTS.COMPANION_POSITIONS.includes(
    settings.companionPosition as (typeof GX_DEFAULTS.COMPANION_POSITIONS)[number]
  )
    ? (settings.companionPosition as (typeof GX_DEFAULTS.COMPANION_POSITIONS)[number])
    : defaults.companionPosition;

  return {
    width: gxClamp(
      Math.round(Number(settings.companionWidth ?? defaults.companionWidth)),
      GX_DEFAULTS.COMPANION_MIN_WIDTH,
      GX_DEFAULTS.COMPANION_MAX_WIDTH
    ),
    heightMode,
    height: gxClamp(
      Math.round(Number(settings.companionHeight ?? defaults.companionHeight)),
      GX_DEFAULTS.COMPANION_MIN_HEIGHT,
      GX_DEFAULTS.COMPANION_MAX_HEIGHT
    ),
    position
  };
}

/** Returns a fresh copy of the factory-default storage snapshot. */
export function gxGetDefaultStorageData(): StorageData {
  return {
    pins: GX_DEFAULTS.DEFAULT_PINS.map((pin) => ({ ...pin })),
    settings: { ...GX_DEFAULTS.DEFAULT_SETTINGS },
    lastActivePinId: GX_DEFAULTS.DEFAULT_PINS[0].id,
    sidebarHidden: false
  };
}
