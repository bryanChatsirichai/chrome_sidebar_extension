import { useRef } from 'react';
import { GX_DEFAULTS } from '../../lib/defaults';
import { getCurrentPagePinDefaults, resolveIconUrl } from '../../lib/pin-utils';
import type { CompanionHeightMode, Pin, Settings } from '../../lib/types';

interface PinFormState {
  name: string;
  url: string;
  iconUrl: string;
}

interface SettingsPanelProps {
  open: boolean;
  pins: Pin[];
  settings: Settings;
  panelWidth: number;
  editingPinId: string | null;
  pinForm: PinFormState;
  companionHeightMode: CompanionHeightMode;
  onClose: () => void;
  onPinFormChange: (form: PinFormState) => void;
  onSavePin: (event: React.FormEvent) => void;
  onPinCurrentPage: () => void;
  onQuickPinCurrentPage: () => void;
  onCancelEdit: () => void;
  onEditPin: (pin: Pin) => void;
  onDeletePin: (index: number) => void;
  onDragStart: (index: number) => void;
  onDragEnd: () => void;
  onDropPin: (index: number) => void;
  onPanelWidthChange: (width: number) => void;
  onPanelWidthCommit: () => void;
  onSettingsPatch: (patch: Partial<Settings>) => void;
  onSettingsCommit: () => void;
  onSettingsPatchAndCommit: (patch: Partial<Settings>) => void;
  onReset: () => void;
}

export function SettingsPanel({
  open,
  pins,
  settings,
  panelWidth,
  editingPinId,
  pinForm,
  companionHeightMode,
  onClose,
  onPinFormChange,
  onSavePin,
  onPinCurrentPage,
  onQuickPinCurrentPage,
  onCancelEdit,
  onEditPin,
  onDeletePin,
  onDragStart,
  onDragEnd,
  onDropPin,
  onPanelWidthChange,
  onPanelWidthCommit,
  onSettingsPatch,
  onSettingsCommit,
  onSettingsPatchAndCommit,
  onReset
}: SettingsPanelProps) {
  const addFormRef = useRef<HTMLDivElement>(null);
  const currentPage = getCurrentPagePinDefaults();
  const companionWidth = settings.companionWidth ?? GX_DEFAULTS.DEFAULT_SETTINGS.companionWidth;
  const companionHeight = settings.companionHeight ?? GX_DEFAULTS.DEFAULT_SETTINGS.companionHeight;
  const companionPosition = settings.companionPosition ?? GX_DEFAULTS.DEFAULT_SETTINGS.companionPosition;

  return (
    <section className={`settings-panel${open ? ' open' : ''}`} part="settings-panel">
      <header className="panel-header">
        <span className="panel-title">Settings</span>
        <div className="panel-actions">
          <button
            className="panel-action-btn settings-close-btn"
            type="button"
            title="Close settings"
            onClick={onClose}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
      </header>

      <div className="settings-body">
        <div className="settings-section">
          <div className="settings-section-header">
            <h3 className="settings-heading">Pinned websites</h3>
            <button
              className="settings-btn settings-btn-secondary settings-add-pin-btn"
              type="button"
              onClick={() => {
                onPinCurrentPage();
                addFormRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
              }}
            >
              + Add website
            </button>
          </div>
          <ul className="settings-pins-list">
            {pins.length === 0 ? (
              <li className="settings-empty">No pinned websites yet. Add one below.</li>
            ) : (
              pins.map((pin, index) => (
                <li
                  key={pin.id}
                  className={`settings-pin-item${editingPinId === pin.id ? ' editing' : ''}`}
                  draggable
                  onDragStart={() => onDragStart(index)}
                  onDragEnd={onDragEnd}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => {
                    e.preventDefault();
                    onDropPin(index);
                  }}
                >
                  <span className="settings-pin-drag-handle" title="Drag to reorder">
                    ⠿
                  </span>
                  {pin.iconUrl ? (
                    <img className="settings-pin-icon" src={resolveIconUrl(pin.iconUrl)} alt="" />
                  ) : (
                    <span className="settings-pin-icon-fallback">{pin.name.charAt(0)}</span>
                  )}
                  <div className="settings-pin-info">
                    <div className="settings-pin-name">{pin.name}</div>
                    <div className="settings-pin-url">{pin.url}</div>
                  </div>
                  <div className="settings-pin-actions">
                    <button
                      className="settings-pin-edit"
                      type="button"
                      title="Edit"
                      onMouseDown={(e) => e.stopPropagation()}
                      onClick={() => onEditPin(pin)}
                    >
                      ✎
                    </button>
                    <button
                      className="settings-pin-delete"
                      type="button"
                      title="Remove"
                      onMouseDown={(e) => e.stopPropagation()}
                      onClick={() => onDeletePin(index)}
                    >
                      ✕
                    </button>
                  </div>
                </li>
              ))
            )}
          </ul>
          <p className="settings-hint">Drag to reorder pinned websites.</p>
        </div>

        <div className="settings-section" ref={addFormRef}>
          <h3 className="settings-heading settings-form-heading">
            {editingPinId ? 'Edit website' : 'Pin a new website'}
          </h3>

          {!editingPinId && (
            <div className="settings-current-page-card">
              <div className="settings-current-page-info">
                {currentPage.iconUrl ? (
                  <img
                    className="settings-current-page-icon"
                    src={currentPage.iconUrl}
                    alt=""
                  />
                ) : (
                  <span className="settings-current-page-icon-fallback">
                    {currentPage.name.charAt(0).toUpperCase()}
                  </span>
                )}
                <div className="settings-current-page-text">
                  <div className="settings-current-page-name">{currentPage.name}</div>
                  <div className="settings-current-page-url">{currentPage.url}</div>
                </div>
              </div>
              <div className="settings-current-page-actions">
                <button
                  className="settings-btn settings-btn-primary"
                  type="button"
                  onClick={onQuickPinCurrentPage}
                >
                  Pin current page
                </button>
                <button
                  className="settings-btn settings-btn-secondary"
                  type="button"
                  onClick={onPinCurrentPage}
                >
                  Edit before adding
                </button>
              </div>
            </div>
          )}

          <form className="settings-add-form" onSubmit={onSavePin}>
            <input
              className="settings-input"
              type="text"
              name="pinName"
              placeholder="Website name"
              maxLength={32}
              required
              value={pinForm.name}
              onChange={(e) => onPinFormChange({ ...pinForm, name: e.target.value })}
            />
            <input
              className="settings-input"
              type="text"
              name="pinUrl"
              placeholder="https://example.com"
              required
              spellCheck={false}
              autoCapitalize="off"
              value={pinForm.url}
              onChange={(e) => onPinFormChange({ ...pinForm, url: e.target.value })}
            />
            <input
              className="settings-input"
              type="text"
              name="pinIconUrl"
              placeholder="Icon URL (optional)"
              spellCheck={false}
              autoCapitalize="off"
              value={pinForm.iconUrl}
              onChange={(e) => onPinFormChange({ ...pinForm, iconUrl: e.target.value })}
            />
            <p className="settings-hint">Paste a direct link to a PNG, SVG, or JPG icon.</p>
            <div className="settings-form-actions">
              <button className="settings-btn settings-btn-primary settings-form-submit" type="submit">
                {editingPinId ? 'Save changes' : 'Add to sidebar'}
              </button>
              {editingPinId && (
                <button
                  className="settings-btn settings-btn-secondary settings-form-cancel"
                  type="button"
                  onClick={onCancelEdit}
                >
                  Cancel
                </button>
              )}
            </div>
          </form>
        </div>

        <div className="settings-section">
          <h3 className="settings-heading">Panel width</h3>
          <div className="settings-width-control">
            <input
              className="settings-width-range"
              type="range"
              min={300}
              max={1000}
              step={10}
              value={panelWidth}
              onChange={(e) => onPanelWidthChange(Number(e.target.value))}
              onMouseUp={onPanelWidthCommit}
              onTouchEnd={onPanelWidthCommit}
            />
            <span className="settings-width-value">{panelWidth}px</span>
          </div>
        </div>

        <div className="settings-section">
          <h3 className="settings-heading">Companion window</h3>
          <p className="settings-hint">Popup used when a site cannot load in the panel.</p>
          <label className="settings-label">Width</label>
          <div className="settings-width-control">
            <input
              className="settings-companion-width-range"
              type="range"
              min={300}
              max={900}
              step={10}
              value={companionWidth}
              onChange={(e) => onSettingsPatch({ companionWidth: Number(e.target.value) })}
              onMouseUp={onSettingsCommit}
              onTouchEnd={onSettingsCommit}
            />
            <span className="settings-companion-width-value">{companionWidth}px</span>
          </div>
          <label className="settings-label">Height</label>
          <select
            className="settings-select settings-companion-height-mode"
            value={companionHeightMode}
            onChange={(e) =>
              onSettingsPatchAndCommit({
                companionHeightMode: e.target.value as Settings['companionHeightMode']
              })
            }
          >
            <option value="match">Match browser window</option>
            <option value="fixed">Fixed height</option>
          </select>
          <div
            className={`settings-companion-height-row${companionHeightMode !== 'fixed' ? ' hidden' : ''}`}
          >
            <div className="settings-width-control">
              <input
                className="settings-companion-height-range"
                type="range"
                min={400}
                max={1200}
                step={10}
                value={companionHeight}
                onChange={(e) => onSettingsPatch({ companionHeight: Number(e.target.value) })}
                onMouseUp={onSettingsCommit}
                onTouchEnd={onSettingsCommit}
              />
              <span className="settings-companion-height-value">{companionHeight}px</span>
            </div>
          </div>
          <label className="settings-label">Initial position</label>
          <select
            className="settings-select settings-companion-position"
            value={companionPosition}
            onChange={(e) =>
              onSettingsPatchAndCommit({
                companionPosition: e.target.value as Settings['companionPosition']
              })
            }
          >
            <option value="right">Right of browser window</option>
            <option value="left">Left of browser window</option>
            <option value="screen-right">Right edge of screen</option>
            <option value="screen-left">Left edge of screen</option>
          </select>
        </div>

        <button className="settings-btn settings-btn-secondary settings-reset-btn" type="button" onClick={onReset}>
          Reset to defaults
        </button>
      </div>
    </section>
  );
}
