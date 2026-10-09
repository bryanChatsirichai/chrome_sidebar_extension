import { useCallback, useEffect, useRef, useState } from 'react';
import { BROWSER_SIDEBAR_DEFAULTS, browserSidebarGetDefaultStorageData } from '../lib/defaults';
import { parsePinUrl, reindexPins, resolveIconUrl } from '../lib/pin-utils';
import type { Pin, Settings } from '../lib/types';

async function loadStorageData(): Promise<{ pins: Pin[]; settings: Settings }> {
  const response = await chrome.runtime.sendMessage({ action: 'getStorageData' });
  return {
    pins: (response.pins ?? browserSidebarGetDefaultStorageData().pins)
      .slice()
      .sort((a: Pin, b: Pin) => a.order - b.order),
    settings: { ...BROWSER_SIDEBAR_DEFAULTS.DEFAULT_SETTINGS, ...(response.settings ?? {}) }
  };
}

async function saveAndBroadcast(pins: Pin[], settings: Settings): Promise<void> {
  await chrome.storage.sync.set({ pins, settings });
  await chrome.runtime.sendMessage({ action: 'broadcastPinsUpdated', pins, settings });
}

export function PopupApp() {
  const [pins, setPins] = useState<Pin[]>([]);
  const [settings, setSettings] = useState<Settings>({ ...BROWSER_SIDEBAR_DEFAULTS.DEFAULT_SETTINGS });
  const [editingPinId, setEditingPinId] = useState<string | null>(null);
  const [pinName, setPinName] = useState('');
  const [pinUrl, setPinUrl] = useState('');
  const [pinIconUrl, setPinIconUrl] = useState('');
  const draggedIndexRef = useRef<number | null>(null);

  useEffect(() => {
    void loadStorageData().then(({ pins: loadedPins, settings: loadedSettings }) => {
      setPins(loadedPins);
      setSettings(loadedSettings);
    });
  }, []);

  const persist = useCallback(
    async (nextPins: Pin[], nextSettings: Settings) => {
      setPins(nextPins);
      setSettings(nextSettings);
      await saveAndBroadcast(nextPins, nextSettings);
    },
    []
  );

  const resetPinForm = useCallback(() => {
    setEditingPinId(null);
    setPinName('');
    setPinUrl('');
    setPinIconUrl('');
  }, []);

  const beginEditPin = useCallback((pin: Pin) => {
    setEditingPinId(pin.id);
    setPinName(pin.name);
    setPinUrl(pin.url);
    setPinIconUrl(pin.iconUrl);
  }, []);

  const handleSavePin = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();
      const name = pinName.trim();
      const url = pinUrl.trim();
      const iconUrl = pinIconUrl.trim();

      if (!name || !url) {
        return;
      }

      const parsedUrl = parsePinUrl(url);
      if (!parsedUrl) {
        alert('Please enter a valid URL (include https://).');
        return;
      }

      let nextPins: Pin[];

      if (editingPinId) {
        nextPins = pins.map((pin) =>
          pin.id === editingPinId
            ? { ...pin, name, url: parsedUrl.href, iconUrl: iconUrl || '' }
            : pin
        );
      } else {
        nextPins = [
          ...pins,
          {
            id: `custom-${Date.now()}`,
            name,
            url: parsedUrl.href,
            iconUrl: iconUrl || '',
            order: pins.length
          }
        ];
      }

      resetPinForm();
      await persist(nextPins, settings);
    },
    [editingPinId, pinIconUrl, pinName, pinUrl, pins, persist, resetPinForm, settings]
  );

  const handleDeletePin = useCallback(
    async (index: number) => {
      const pin = pins[index];
      if (editingPinId === pin.id) {
        resetPinForm();
      }
      const nextPins = reindexPins(pins.filter((_, i) => i !== index));
      await persist(nextPins, settings);
    },
    [editingPinId, pins, persist, resetPinForm, settings]
  );

  const handleDropPin = useCallback(
    async (targetIndex: number) => {
      const fromIndex = draggedIndexRef.current;
      draggedIndexRef.current = null;
      if (fromIndex === null || fromIndex === targetIndex) {
        return;
      }

      const nextPins = pins.slice();
      const [moved] = nextPins.splice(fromIndex, 1);
      nextPins.splice(targetIndex, 0, moved);
      await persist(reindexPins(nextPins), settings);
    },
    [pins, persist, settings]
  );

  const handleReset = useCallback(async () => {
    if (!confirm('Reset all pins and settings to defaults?')) {
      return;
    }

    const response = await chrome.runtime.sendMessage({ action: 'resetStorage' });
    if (response.ok) {
      setPins(response.data.pins);
      setSettings(response.data.settings);
      resetPinForm();
    }
  }, [resetPinForm]);

  const updateSettings = useCallback(
    async (patch: Partial<Settings>) => {
      const nextSettings = { ...settings, ...patch };
      setSettings(nextSettings);
      await saveAndBroadcast(pins, nextSettings);
    },
    [pins, settings]
  );

  return (
    <div className="popup-container">
      <header className="popup-header">
        <h1>browser-sidebar</h1>
        <p className="subtitle">Manage pinned apps and panel settings</p>
      </header>

      <section className="section">
        <h2>Panel width</h2>
        <div className="width-control">
          <input
            type="range"
            id="panelWidth"
            min={300}
            max={1000}
            step={10}
            value={settings.panelWidth}
            onChange={(e) => setSettings({ ...settings, panelWidth: Number(e.target.value) })}
            onMouseUp={() => void updateSettings({ panelWidth: settings.panelWidth })}
            onTouchEnd={() => void updateSettings({ panelWidth: settings.panelWidth })}
          />
          <span id="panelWidthValue">{settings.panelWidth}px</span>
        </div>
      </section>

      <section className="section">
        <div className="section-header">
          <h2>Pinned apps</h2>
          <span className="hint">Drag to reorder</span>
        </div>
        <ul id="pinsList" className="pins-list">
          {pins.length === 0 ? (
            <li className="empty-state">No pinned apps yet. Add one below.</li>
          ) : (
            pins.map((pin, index) => (
              <li
                key={pin.id}
                className={`pin-item${editingPinId === pin.id ? ' editing' : ''}`}
                draggable
                onDragStart={() => {
                  draggedIndexRef.current = index;
                }}
                onDragEnd={() => {
                  draggedIndexRef.current = null;
                }}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  void handleDropPin(index);
                }}
              >
                <span className="pin-drag-handle">⠿</span>
                {pin.iconUrl ? (
                  <img className="pin-icon" src={resolveIconUrl(pin.iconUrl)} alt="" />
                ) : (
                  <span className="pin-icon-fallback">{pin.name.charAt(0)}</span>
                )}
                <div className="pin-info">
                  <div className="pin-name">{pin.name}</div>
                  <div className="pin-url">{pin.url}</div>
                </div>
                <div className="pin-actions">
                  <button
                    className="pin-edit"
                    type="button"
                    title="Edit pin"
                    onClick={() => beginEditPin(pin)}
                  >
                    ✎
                  </button>
                  <button
                    className="pin-delete"
                    type="button"
                    title="Remove pin"
                    onClick={() => void handleDeletePin(index)}
                  >
                    ✕
                  </button>
                </div>
              </li>
            ))
          )}
        </ul>
      </section>

      <section className="section">
        <h2 id="pinFormHeading">{editingPinId ? 'Edit app' : 'Add custom app'}</h2>
        <form id="addPinForm" className="add-form" onSubmit={(e) => void handleSavePin(e)}>
          <input
            type="text"
            id="pinName"
            placeholder="App name"
            required
            maxLength={32}
            value={pinName}
            onChange={(e) => setPinName(e.target.value)}
          />
          <input
            type="text"
            id="pinUrl"
            placeholder="https://example.com"
            required
            spellCheck={false}
            autoCapitalize="off"
            value={pinUrl}
            onChange={(e) => setPinUrl(e.target.value)}
          />
          <input
            type="text"
            id="pinIconUrl"
            placeholder="Icon URL (optional)"
            spellCheck={false}
            autoCapitalize="off"
            value={pinIconUrl}
            onChange={(e) => setPinIconUrl(e.target.value)}
          />
          <div className="form-actions">
            <button type="submit" id="pinFormSubmit" className="btn btn-primary">
              {editingPinId ? 'Save changes' : 'Add pin'}
            </button>
            {editingPinId && (
              <button
                type="button"
                id="pinFormCancel"
                className="btn btn-secondary"
                onClick={resetPinForm}
              >
                Cancel
              </button>
            )}
          </div>
        </form>
      </section>

      <footer className="popup-footer">
        <button id="resetBtn" type="button" className="btn btn-secondary" onClick={() => void handleReset()}>
          Reset to defaults
        </button>
      </footer>
    </div>
  );
}
