import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { SidebarApp } from './SidebarApp';
import {
  attachHostKeyboardBubbleStop,
  registerDocumentKeyboardIsolation
} from './keyboardIsolation';
import {
  injectPageShiftStyles,
  loadSidebarStorage
} from './sidebarUtils';
import sidebarStyles from './sidebar.module.scss?inline';

let hostEl: HTMLDivElement | null = null;

registerDocumentKeyboardIsolation(() => hostEl);

void (async function initGxSidebar(): Promise<void> {
  if (window.top !== window.self || document.getElementById('gx-sidebar-host')) {
    return;
  }

  injectPageShiftStyles();

  const storage = await loadSidebarStorage();

  hostEl = document.createElement('div');
  hostEl.id = 'gx-sidebar-host';
  document.documentElement.appendChild(hostEl);
  attachHostKeyboardBubbleStop(hostEl);

  const shadowRoot = hostEl.attachShadow({ mode: 'closed' });

  const style = document.createElement('style');
  style.textContent = sidebarStyles;
  shadowRoot.appendChild(style);

  const mount = document.createElement('div');
  shadowRoot.appendChild(mount);

  createRoot(mount).render(
    <StrictMode>
      <SidebarApp
        initialPins={storage.pins}
        initialSettings={storage.settings}
        initialActivePinId={storage.panelSession.pinId ?? storage.activePinId}
        initialSidebarHidden={storage.sidebarHidden}
        initialPanelWidth={storage.panelWidth}
        initialPanelOpen={storage.panelSession.open}
      />
    </StrictMode>
  );
})();
