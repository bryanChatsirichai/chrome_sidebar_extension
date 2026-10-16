import type { RefObject } from 'react';
import type { Pin } from '../../lib/types';
import { resolveIconUrl } from '../../lib/pin-utils';
import type { PanelView, WarmFrameEntry } from '../SidebarApp';

interface AppPanelProps {
  open: boolean;
  pin: Pin | null;
  panelView: PanelView;
  fallbackPin: Pin | null;
  /** Mounted panel frames (active + warm), stable insertion order — the array is NEVER reordered: moving an iframe in the DOM reloads it. */
  warmFrames: WarmFrameEntry[];
  activePinId: string | null;
  registerFrame: (pinId: string, element: HTMLIFrameElement | null) => void;
  resizing: boolean;
  onClose: () => void;
  onRefresh: () => void;
  onOpenInTab: () => void;
  onIframeLoad: (pinId: string) => void;
  onIframeError: (pinId: string) => void;
  onResizeStart: (event: React.PointerEvent<HTMLDivElement>) => void;
  /** One-click partition repair (clears service workers) + retry. */
  onRepairEmbed: () => void;
  repairInProgress: boolean;
}

export function AppPanel({
  open,
  pin,
  panelView,
  fallbackPin,
  warmFrames,
  activePinId,
  registerFrame,
  resizing,
  onClose,
  onRefresh,
  onOpenInTab,
  onIframeLoad,
  onIframeError,
  onResizeStart,
  onRepairEmbed,
  repairInProgress
}: AppPanelProps) {
  const displayPin = fallbackPin ?? pin;

  return (
    <section className={`app-panel${open ? ' open' : ''}`} part="app-panel">
      <header className="panel-header">
        <span className="panel-title">{pin?.name ?? ''}</span>
        <div className="panel-actions">
          <button className="panel-action-btn refresh-btn" type="button" title="Refresh" onClick={onRefresh}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M23 4v6h-6M1 20v-6h6" />
              <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
            </svg>
          </button>
          <button className="panel-action-btn close-btn" type="button" title="Close panel" onClick={onClose}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
      </header>

      <div className="panel-body">
        <div className={`loading-view${panelView === 'loading' ? ' visible' : ''}`}>
          <span className="loading-spinner" />
          Loading...
        </div>

        {/*
          One dedicated iframe per pin that has been opened this session.
          Warm (inactive) frames stay mounted fully transparent (opacity: 0,
          see .panel-iframe.hidden in sidebar.module.scss) — never
          display:none, which would freeze the frame's rAF/CSS animations.
          Their documents stay alive, so switching pins is instant. The key
          includes the nav counter so a forced refresh remounts the frame.
        */}
        {warmFrames.map((entry) => (
          <iframe
            key={`${entry.pinId}:${entry.src}:${entry.nav}`}
            ref={(element) => registerFrame(entry.pinId, element)}
            src={entry.src}
            className={`panel-iframe${entry.pinId === activePinId && panelView === 'iframe' ? '' : ' hidden'}`}
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads"
            title={pin && entry.pinId === pin.id ? pin.name : 'Pinned website'}
            onLoad={() => onIframeLoad(entry.pinId)}
            onError={() => onIframeError(entry.pinId)}
          />
        ))}

        <div className={`fallback-view${panelView === 'fallback' ? ' visible' : ''}`}>
          <div className="fallback-icon">
            {displayPin?.iconUrl ? (
              <img src={resolveIconUrl(displayPin.iconUrl)} alt={displayPin.name} />
            ) : (
              displayPin?.name.charAt(0)
            )}
          </div>
          <h3 className="fallback-title">{displayPin?.name}</h3>
          <p className="fallback-message">This site could not load in the panel.</p>
          <div className="fallback-actions">
            <button className="open-tab-btn" type="button" onClick={onOpenInTab}>
              Open in new tab
            </button>
            <button
              className="repair-btn"
              type="button"
              onClick={onRepairEmbed}
              disabled={repairInProgress}
              title="Clears all sites' service workers and retries — fixes sites whose cached embed state blocks the panel"
            >
              {repairInProgress ? 'Repairing…' : 'Repair & retry'}
            </button>
          </div>
        </div>

        <div
          className={`resize-handle${resizing ? ' dragging' : ''}`}
          title="Drag to resize"
          onPointerDown={onResizeStart}
        />
      </div>
    </section>
  );
}
