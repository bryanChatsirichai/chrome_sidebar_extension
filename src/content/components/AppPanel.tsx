import type { RefObject } from 'react';
import type { Pin } from '../../lib/types';
import { resolveIconUrl } from '../../lib/pin-utils';
import type { PanelView } from '../SidebarApp';

interface AppPanelProps {
  open: boolean;
  pin: Pin | null;
  panelView: PanelView;
  fallbackPin: Pin | null;
  /** Changing this remounts the iframe: fresh, pristine frame per navigation. */
  frameEpoch: number;
  /** Target URL for the current frame; '' parks the frame on about:blank. */
  frameSrc: string;
  iframeRef: RefObject<HTMLIFrameElement | null>;
  resizeDragging: boolean;
  onClose: () => void;
  onRefresh: () => void;
  onOpenCompanion: () => void;
  onIframeLoad: () => void;
  onIframeError: () => void;
  onResizeStart: (event: React.MouseEvent) => void;
}

export function AppPanel({
  open,
  pin,
  panelView,
  fallbackPin,
  frameEpoch,
  frameSrc,
  iframeRef,
  resizeDragging,
  onClose,
  onRefresh,
  onOpenCompanion,
  onIframeLoad,
  onIframeError,
  onResizeStart
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
          <button
            className="panel-action-btn companion-btn"
            type="button"
            title="Open in companion window"
            onClick={onOpenCompanion}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
              <polyline points="15 3 21 3 21 9" />
              <line x1="10" y1="14" x2="21" y2="3" />
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

        <iframe
          key={frameEpoch}
          ref={iframeRef}
          src={frameSrc}
          className={`panel-iframe${panelView === 'iframe' ? '' : ' hidden'}`}
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads"
          title={pin?.name ?? 'Pinned website'}
          onLoad={onIframeLoad}
          onError={onIframeError}
        />

        <div className={`fallback-view${panelView === 'fallback' ? ' visible' : ''}`}>
          <div className="fallback-icon">
            {displayPin?.iconUrl ? (
              <img src={resolveIconUrl(displayPin.iconUrl)} alt={displayPin.name} />
            ) : (
              displayPin?.name.charAt(0)
            )}
          </div>
          <h3 className="fallback-title">{displayPin?.name}</h3>
          <p className="fallback-message">
            This site could not load in the panel. Use the companion window instead.
          </p>
          <button className="open-tab-btn" type="button" onClick={onOpenCompanion}>
            Open companion panel
          </button>
        </div>

        <div
          className={`resize-handle${resizeDragging ? ' dragging' : ''}`}
          title="Drag to resize"
          onMouseDown={onResizeStart}
        />
      </div>
    </section>
  );
}
