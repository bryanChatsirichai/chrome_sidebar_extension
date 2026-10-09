import { browserSidebarGetDefaultStorageData } from './defaults';
import type { Pin, Settings, StorageData } from './types';

/** Reads pins, settings, and UI state from sync storage with defaults applied. */
export async function browserSidebarGetStorageData(): Promise<StorageData> {
  const defaults = browserSidebarGetDefaultStorageData();
  const stored = await chrome.storage.sync.get(['pins', 'settings', 'lastActivePinId', 'sidebarHidden']);

  return {
    pins: stored.pins ?? defaults.pins,
    settings: { ...defaults.settings, ...(stored.settings ?? {}) },
    lastActivePinId: stored.lastActivePinId ?? defaults.lastActivePinId,
    sidebarHidden: stored.sidebarHidden ?? defaults.sidebarHidden
  };
}

/** Persists the pin list to sync storage. */
export async function browserSidebarSavePins(pins: Pin[]): Promise<void> {
  await chrome.storage.sync.set({ pins });
}

/** Persists settings to sync storage. */
export async function browserSidebarSaveSettings(settings: Settings): Promise<void> {
  await chrome.storage.sync.set({ settings });
}

/** Remembers which pin was last active across tabs and sessions. */
export async function browserSidebarSaveLastActivePinId(lastActivePinId: string): Promise<void> {
  await chrome.storage.sync.set({ lastActivePinId });
}

/** Persists whether the sidebar strip is hidden on all pages. */
export async function browserSidebarSaveSidebarHidden(sidebarHidden: boolean): Promise<void> {
  await chrome.storage.sync.set({ sidebarHidden });
}

/** Seeds sync storage with defaults on first install when no pins exist yet. */
export async function browserSidebarInitializeStorage(): Promise<void> {
  const stored = await chrome.storage.sync.get(['pins', 'settings']);
  const defaults = browserSidebarGetDefaultStorageData();

  if (!stored.pins) {
    await chrome.storage.sync.set({
      pins: defaults.pins,
      settings: defaults.settings,
      lastActivePinId: defaults.lastActivePinId,
      sidebarHidden: defaults.sidebarHidden
    });
  }
}

/** Replaces all sync storage with factory defaults and returns the new state. */
export async function browserSidebarResetStorageToDefaults(): Promise<StorageData> {
  const defaults = browserSidebarGetDefaultStorageData();
  await chrome.storage.sync.set(defaults);
  return defaults;
}
