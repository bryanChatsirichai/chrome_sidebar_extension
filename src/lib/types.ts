/** A pinned website shown as an icon in the sidebar strip. */
export interface Pin {
  id: string;
  name: string;
  url: string;
  iconUrl: string;
  order: number;
}

/** User-configurable sidebar preferences. */
export interface Settings {
  panelWidth: number;
  theme: string;
}

/** Full persisted extension state in chrome.storage.sync. */
export interface StorageData {
  pins: Pin[];
  settings: Settings;
  lastActivePinId: string | null;
  sidebarHidden: boolean;
}