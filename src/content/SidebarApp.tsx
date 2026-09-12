import { useCallback, useEffect, useRef, useState } from 'react';
import { GX_DEFAULTS } from '../lib/defaults';
import { parsePinUrl, reindexPins, getCurrentPagePinDefaults } from '../lib/pin-utils';
import type { CompanionOpenResult, Pin, Settings } from '../lib/types';
import { IconStrip } from './components/IconStrip';
import { SettingsPanel } from './components/SettingsPanel';
import { applyLayoutClasses, setCssVariables } from './sidebarUtils';

interface SidebarAppProps {
  initialPins: Pin[];
  initialSettings: Settings;
  initialActivePinId: string | null;
  initialSidebarHidden: boolean;
  initialPanelWidth: number;
}

export function SidebarApp({
  initialPins,
  initialSettings,
  initialActivePinId,
  initialSidebarHidden,
  initialPanelWidth
}: SidebarAppProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const draggedIndexRef = useRef<number | null>(null);

  const [pins, setPins] = useState(initialPins);
  const [settings, setSettings] = useState(initialSettings);
  const [activePinId, setActivePinId] = useState(initialActivePinId);
  const [companionOpen, setCompanionOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sidebarHidden, setSidebarHidden] = useState(initialSidebarHidden);
  const [panelWidth, setPanelWidth] = useState(initialPanelWidth);
  const [editingPinId, setEditingPinId] = useState<string | null>(null);
  const [pinForm, setPinForm] = useState({ name: '', url: '', iconUrl: '' });

  const companionOpenRef = useRef(companionOpen);
  const activePinIdRef = useRef(activePinId);
  const handlePinClickRef = useRef<(pin: Pin) => void>(() => {});

  companionOpenRef.current = companionOpen;
  activePinIdRef.current = activePinId;

  const saveAndBroadcast = useCallback(
    async (nextPins: Pin[], nextSettings: Settings, width: number) => {
      const merged = { ...nextSettings, panelWidth: width };
      await chrome.storage.sync.set({ pins: nextPins, settings: merged });
      await chrome.runtime.sendMessage({
        action: 'broadcastPinsUpdated',
        pins: nextPins,
        settings: merged
      });
    },
    []
  );

  const openCompanionForPin = useCallback(
    async (pin: Pin): Promise<CompanionOpenResult | undefined> => {
      try {
        const response = await chrome.runtime.sendMessage({
          action: 'openCompanion',
          url: pin.url,
          pinId: pin.id,
          companionSettings: settings
        });

        if (!response?.ok) {
          console.error('[GX Sidebar] Companion panel failed:', response?.error ?? 'Unknown error');
          return response;
        }

        if (response.open) {
          setActivePinId(pin.id);
          activePinIdRef.current = pin.id;
          setCompanionOpen(true);
          companionOpenRef.current = true;
        } else {
          setActivePinId(null);
          activePinIdRef.current = null;
          setCompanionOpen(false);
          companionOpenRef.current = false;
        }

        return response;
      } catch (error) {
        console.error('[GX Sidebar] Companion panel failed:', error);
        return { ok: false, error: String(error) };
      }
    },
    [settings]
  );

  const closeCompanion = useCallback(async () => {
    try {
      await chrome.runtime.sendMessage({ action: 'closeCompanion' });
    } catch {
      // Companion may already be closed.
    }
    setCompanionOpen(false);
    companionOpenRef.current = false;
  }, []);

  const handlePinClick = useCallback(
    (pin: Pin) => {
      if (settingsOpen) {
        setSettingsOpen(false);
      }

      if (activePinId === pin.id && companionOpen) {
        void closeCompanion().then(() => {
          setActivePinId(null);
          activePinIdRef.current = null;
        });
        return;
      }

      setActivePinId(pin.id);
      activePinIdRef.current = pin.id;
      void chrome.runtime.sendMessage({ action: 'saveLastActivePin', pinId: pin.id });
      void openCompanionForPin(pin);
    },
    [activePinId, closeCompanion, companionOpen, openCompanionForPin, settingsOpen]
  );

  handlePinClickRef.current = handlePinClick;

  const toggleSettings = useCallback(() => {
    if (settingsOpen) {
      setSettingsOpen(false);
      return;
    }
    void closeCompanion();
    setActivePinId(null);
    activePinIdRef.current = null;
    setSettingsOpen(true);
  }, [closeCompanion, settingsOpen]);

  const resetPinForm = useCallback(() => {
    setEditingPinId(null);
    setPinForm({ name: '', url: '', iconUrl: '' });
  }, []);

  const beginEditPin = useCallback((pin: Pin) => {
    setEditingPinId(pin.id);
    setPinForm({ name: pin.name, url: pin.url, iconUrl: pin.iconUrl });
  }, []);

  const pinCurrentPage = useCallback(() => {
    setEditingPinId(null);
    setPinForm(getCurrentPagePinDefaults());
  }, []);

  const isPinUrlDuplicate = useCallback(
    (url: string, excludePinId?: string | null): boolean => {
      const parsed = parsePinUrl(url);
      if (!parsed) {
        return false;
      }

      const normalized = parsed.href;
      return pins.some((pin) => {
        if (excludePinId && pin.id === excludePinId) {
          return false;
        }
        try {
          return new URL(pin.url).href === normalized;
        } catch {
          return false;
        }
      });
    },
    [pins]
  );

  const quickPinCurrentPage = useCallback(async () => {
    const defaults = getCurrentPagePinDefaults();
    const parsedUrl = parsePinUrl(defaults.url);

    if (!parsedUrl) {
      window.alert('This page cannot be pinned.');
      return;
    }

    if (isPinUrlDuplicate(parsedUrl.href)) {
      window.alert('This page is already pinned.');
      return;
    }

    const nextPins = [
      ...pins,
      {
        id: `custom-${Date.now()}`,
        name: defaults.name,
        url: parsedUrl.href,
        iconUrl: defaults.iconUrl,
        order: pins.length
      }
    ];

    resetPinForm();
    setPins(nextPins);
    await saveAndBroadcast(nextPins, settings, panelWidth);
  }, [isPinUrlDuplicate, panelWidth, pins, resetPinForm, saveAndBroadcast, settings]);

  const handleSavePin = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();
      const name = pinForm.name.trim();
      const url = pinForm.url.trim();
      const iconUrl = pinForm.iconUrl.trim();

      if (!name || !url) {
        return;
      }

      const parsedUrl = parsePinUrl(url);
      if (!parsedUrl) {
        window.alert('Please enter a valid URL (include https://).');
        return;
      }

      let nextPins: Pin[];
      let reloadActiveCompanion = false;

      if (editingPinId) {
        nextPins = pins.map((pin) =>
          pin.id === editingPinId
            ? { ...pin, name, url: parsedUrl.href, iconUrl }
            : pin
        );
        reloadActiveCompanion = activePinId === editingPinId && companionOpen;
      } else {
        nextPins = [
          ...pins,
          {
            id: `custom-${Date.now()}`,
            name,
            url: parsedUrl.href,
            iconUrl,
            order: pins.length
          }
        ];
      }

      resetPinForm();
      setPins(nextPins);
      await saveAndBroadcast(nextPins, settings, panelWidth);

      if (reloadActiveCompanion) {
        const updated = nextPins.find((p) => p.id === editingPinId);
        if (updated) {
          void openCompanionForPin(updated);
        }
      }
    },
    [
      activePinId,
      companionOpen,
      editingPinId,
      openCompanionForPin,
      panelWidth,
      pinForm,
      pins,
      resetPinForm,
      saveAndBroadcast,
      settings
    ]
  );

  const handleDeletePin = useCallback(
    async (index: number) => {
      const pin = pins[index];
      if (editingPinId === pin.id) {
        resetPinForm();
      }
      if (activePinId === pin.id) {
        void closeCompanion();
        setActivePinId(null);
        activePinIdRef.current = null;
      }
      const nextPins = reindexPins(pins.filter((_, i) => i !== index));
      setPins(nextPins);
      await saveAndBroadcast(nextPins, settings, panelWidth);
    },
    [activePinId, closeCompanion, editingPinId, panelWidth, pins, resetPinForm, saveAndBroadcast, settings]
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
      const reindexed = reindexPins(nextPins);
      setPins(reindexed);
      await saveAndBroadcast(reindexed, settings, panelWidth);
    },
    [panelWidth, pins, saveAndBroadcast, settings]
  );

  const handleReset = useCallback(async () => {
    if (!window.confirm('Reset all pins and settings to defaults?')) {
      return;
    }
    const response = await chrome.runtime.sendMessage({ action: 'resetStorage' });
    if (!response?.ok) {
      return;
    }
    setPins(response.data.pins);
    setSettings(response.data.settings);
    setPanelWidth(response.data.settings.panelWidth);
    setActivePinId(response.data.lastActivePinId ?? null);
    setSidebarHidden(Boolean(response.data.sidebarHidden));
    resetPinForm();
    void closeCompanion();
    setCompanionOpen(false);
    setSettingsOpen(false);
  }, [closeCompanion, resetPinForm]);

  useEffect(() => {
    setCssVariables(panelWidth, rootRef.current);
  }, [panelWidth]);

  useEffect(() => {
    applyLayoutClasses(sidebarHidden, settingsOpen);
  }, [settingsOpen, sidebarHidden]);

  useEffect(() => {
    const listener = (
      message: {
        action?: string;
        hidden?: boolean;
        pins?: Pin[];
        settings?: Settings;
        pinId?: string;
      },
      _sender: chrome.runtime.MessageSender,
      sendResponse: (response?: unknown) => void
    ) => {
      if (message.action === 'setSidebarHidden') {
        setSidebarHidden(Boolean(message.hidden));
        sendResponse({ ok: true, hidden: Boolean(message.hidden) });
      }

      if (message.action === 'togglePanel') {
        if (companionOpenRef.current) {
          void closeCompanion().then(() => {
            setActivePinId(null);
            activePinIdRef.current = null;
          });
        } else {
          setPins((currentPins) => {
            const pin =
              currentPins.find((p) => p.id === activePinIdRef.current) ?? currentPins[0];
            if (pin) {
              handlePinClickRef.current(pin);
            }
            return currentPins;
          });
        }
        sendResponse({ ok: true, companionOpen: companionOpenRef.current });
      }

      if (message.action === 'pinsUpdated') {
        const nextPins = (message.pins ?? [])
          .slice()
          .sort((a: Pin, b: Pin) => a.order - b.order);
        setPins(nextPins);

        if (message.settings) {
          setSettings((prev) => {
            const merged = { ...prev, ...message.settings! };
            setPanelWidth(merged.panelWidth ?? panelWidth);
            return merged;
          });
        }

        if (companionOpenRef.current) {
          const stillExists = nextPins.some((p: Pin) => p.id === activePinIdRef.current);
          if (!stillExists) {
            void closeCompanion();
            setActivePinId(null);
            activePinIdRef.current = null;
          }
        }

        sendResponse({ ok: true });
      }

      if (message.action === 'companionClosed') {
        setCompanionOpen(false);
        companionOpenRef.current = false;
        if (message.pinId === activePinIdRef.current) {
          setActivePinId(null);
          activePinIdRef.current = null;
        }
        sendResponse({ ok: true });
      }

      if (message.action === 'getState') {
        sendResponse({
          companionOpen: companionOpenRef.current,
          activePinId: activePinIdRef.current,
          sidebarHidden,
          panelWidth
        });
      }

      return false;
    };

    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, [closeCompanion, panelWidth, sidebarHidden]);

  const companionHeightMode =
    settings.companionHeightMode ?? GX_DEFAULTS.DEFAULT_SETTINGS.companionHeightMode;

  return (
    <div ref={rootRef} className={`sidebar-root${sidebarHidden ? ' hidden' : ''}`}>
      <IconStrip
        pins={pins}
        activePinId={activePinId}
        settingsOpen={settingsOpen}
        onPinClick={handlePinClick}
        onToggleSettings={toggleSettings}
      />

      <SettingsPanel
        open={settingsOpen}
        pins={pins}
        settings={settings}
        panelWidth={panelWidth}
        editingPinId={editingPinId}
        pinForm={pinForm}
        companionHeightMode={companionHeightMode}
        onClose={() => setSettingsOpen(false)}
        onPinFormChange={setPinForm}
        onSavePin={(e) => void handleSavePin(e)}
        onPinCurrentPage={pinCurrentPage}
        onQuickPinCurrentPage={() => void quickPinCurrentPage()}
        onCancelEdit={resetPinForm}
        onEditPin={beginEditPin}
        onDeletePin={(index) => void handleDeletePin(index)}
        onDragStart={(index) => {
          draggedIndexRef.current = index;
        }}
        onDragEnd={() => {
          draggedIndexRef.current = null;
        }}
        onDropPin={(index) => void handleDropPin(index)}
        onPanelWidthChange={(width) => {
          setPanelWidth(width);
          setSettings((prev) => ({ ...prev, panelWidth: width }));
        }}
        onPanelWidthCommit={() => void saveAndBroadcast(pins, { ...settings, panelWidth }, panelWidth)}
        onSettingsPatch={(patch) => setSettings((prev) => ({ ...prev, ...patch }))}
        onSettingsCommit={() => void saveAndBroadcast(pins, settings, panelWidth)}
        onSettingsPatchAndCommit={(patch) => {
          const next = { ...settings, ...patch };
          setSettings(next);
          void saveAndBroadcast(pins, next, panelWidth);
        }}
        onReset={() => void handleReset()}
      />
    </div>
  );
}
