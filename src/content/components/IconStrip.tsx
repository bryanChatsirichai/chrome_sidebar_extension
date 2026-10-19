import { useState } from 'react';
import type { Pin } from '../../lib/types';
import { resolveIconUrl } from '../../lib/pin-utils';

interface IconStripProps {
  pins: Pin[];
  activePinId: string | null;
  settingsOpen: boolean;
  onPinClick: (pin: Pin) => void;
  onToggleSettings: () => void;
  /** Speculative preload hooks: hover (with dwell) / press warm the pin's
   *  hidden frame before the click, so the open is instant. */
  onPinHover?: (pin: Pin) => void;
  onPinLeave?: () => void;
  onPinPress?: (pin: Pin) => void;
  /** Drag-to-reorder hooks, mirroring the SettingsPanel wiring. */
  onPinDragStart?: (index: number) => void;
  onPinDragEnd?: () => void;
  onPinDropPin?: (index: number) => void;
}

export function IconStrip({
  pins,
  activePinId,
  settingsOpen,
  onPinClick,
  onToggleSettings,
  onPinHover,
  onPinLeave,
  onPinPress,
  onPinDragStart,
  onPinDragEnd,
  onPinDropPin
}: IconStripProps) {
  const [dragging, setDragging] = useState(false);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const [dragIndex, setDragIndex] = useState<number | null>(null);

  const clearDragState = () => {
    setDragging(false);
    setDropIndex(null);
    setDragIndex(null);
  };

  const handleDragEnd = () => {
    clearDragState();
    // Idempotent: handleDropPin already nulled the ref on drop; the
    // dragend that follows drop just nulls it again (harmless).
    onPinDragEnd?.();
  };

  return (
    <aside className="icon-strip" part="icon-strip">
      {pins.map((pin, index) => (
        <button
          key={pin.id}
          className={`pin-button${activePinId === pin.id ? ' active' : ''}${dragIndex === index ? ' dragging' : ''}${dropIndex === index ? ' drop-target' : ''}`}
          type="button"
          title={pin.name}
          data-pin-id={pin.id}
          draggable
          onClick={() => {
            if (!dragging) {
              onPinClick(pin);
            }
          }}
          onPointerEnter={() => {
            if (!dragging) {
              onPinHover?.(pin);
            }
          }}
          onPointerLeave={() => {
            if (!dragging) {
              onPinLeave?.();
            }
          }}
          onPointerDown={() => {
            if (!dragging) {
              onPinPress?.(pin);
            }
          }}
          onDragStart={() => {
            setDragging(true);
            setDragIndex(index);
            onPinDragStart?.(index);
          }}
          onDragEnd={handleDragEnd}
          onDragOver={(e) => {
            e.preventDefault();
            setDropIndex(index === dragIndex ? null : index);
          }}
          onDrop={(e) => {
            e.preventDefault();
            clearDragState();
            onPinDropPin?.(index);
          }}
        >
          {pin.iconUrl ? (
            <img src={resolveIconUrl(pin.iconUrl)} alt={pin.name} />
          ) : (
            <span className="pin-fallback">{pin.name.charAt(0).toUpperCase()}</span>
          )}
        </button>
      ))}

      <div className="strip-spacer" />

      <div className="strip-footer">
        <button
          className={`settings-button${settingsOpen ? ' active' : ''}`}
          type="button"
          title="Settings"
          onClick={onToggleSettings}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="3" />
            <path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" />
          </svg>
        </button>
      </div>
    </aside>
  );
}
