/**
 * DEBUG: in-frame diagnostics for pinned-site embeds.
 *
 * Runs in EVERY frame (all_frames: true, document_start). The panel embeds a
 * cross-origin document, so the sidebar's own script can never inspect it —
 * but a content script injected into that frame can. It reports what the
 * embedded app's own context looks like: JS errors, storage/cookie access,
 * and DOM boot progress. This is how we tell apart "X's JS crashed",
 * "storage partitioning blocked the app", and "X served an empty shell".
 */
(function frameDiagnostics(): void {
  if (window.self === window.top) {
    return; // Only diagnose embedded frames.
  }

  const tag = `[browser-sidebar:frame ${location.hostname}]`;
  const url = location.href;
  const isSandboxed = (() => {
    try {
      return window.origin === 'null' || !window.origin;
    } catch {
      return true;
    }
  })();

  console.log(`${tag} frame script booted`, { url, isSandboxed, cookiesVisible: document.cookie.length });

  // Storage access probe — partitioned third-party storage throws on access
  // in some contexts; silent breakage here is a common cause of dead embeds.
  try {
    localStorage.setItem('__bs_probe__', '1');
    localStorage.removeItem('__bs_probe__');
    console.log(`${tag} localStorage OK`);
  } catch (error) {
    console.error(`${tag} localStorage access FAILED:`, error);
  }
  try {
    sessionStorage.setItem('__bs_probe__', '1');
    sessionStorage.removeItem('__bs_probe__');
    console.log(`${tag} sessionStorage OK`);
  } catch (error) {
    console.error(`${tag} sessionStorage access FAILED:`, error);
  }

  // Capture every script-level failure from the earliest possible moment.
  window.addEventListener('error', (event) => {
    console.error(`${tag} JS error:`, {
      message: event.message,
      source: event.filename ? `${event.filename}:${event.lineno}:${event.colno}` : '(inline)',
      stack: (event.error instanceof Error && event.error.stack) || null
    });
  });
  window.addEventListener('unhandledrejection', (event) => {
    console.error(`${tag} Unhandled promise rejection:`, event.reason);
  });

  const reportDom = (label: string) => {
    const body = document.body;
    const text = (body?.innerText ?? '').trim();
    console.log(`${tag} DOM report (${label})`, {
      readyState: document.readyState,
      bodyChildren: body?.childElementCount ?? 0,
      textLength: text.length,
      textSnippet: text.slice(0, 150),
      // App-mounted marker elements (X uses #react-root / [data-testid]).
      reactRoot: Boolean(document.getElementById('react-root')),
      dataTestIdCount: document.querySelectorAll('[data-testid]').length
    });
  };

  document.addEventListener('DOMContentLoaded', () => reportDom('DOMContentLoaded'));
  window.addEventListener('load', () => {
    reportDom('load');
    // Late check: heavy apps mutate the DOM well after the load event; a
    // frame that is still empty 4s in is booted-dead, not slow.
    setTimeout(() => reportDom('load+4s'), 4000);
  });

  // Partitioned service-worker management (the x.com "refused to connect"
  // fix): a successfully loaded pinned frame CAN unregister the service
  // workers registered in its (host-site, origin) third-party storage
  // partition — those SWs answer later panel navigations from cache with
  // X-Frame-Options intact, which DNR header stripping can never reach. A
  // ~3s interval plus a pagehide sweep keeps the partition clean while the
  // panel is in use, so in-panel navigations (sign-in flows, hard SPA navs)
  // don't re-poison it. Blocked frames never run scripts, so this only
  // helps AFTER a successful load — the repair path handles the rest.
  try {
    chrome.runtime.sendMessage({ action: 'shouldManageServiceWorkers' }, (response: { ok?: boolean } | undefined) => {
      if (!response?.ok) {
        return;
      }
      // Blocked-frame detection signal: a COMMITTED document runs this
      // script at document_start; an XFO/partition-SW-blocked frame never
      // runs anything. The sidebar treats the absence of this signal within
      // the verify window as a hard embed failure (and engages auto-repair)
      // — the parent-side view (SecurityError + no document) is identical
      // for both, so this is the only reliable in-content discriminator.
      void chrome.runtime
        .sendMessage({ action: 'panelFrameBooted', url: location.href })
        .catch(() => {});
      const unregisterPartitionWorkers = () => {
        navigator.serviceWorker
          ?.getRegistrations()
          .then((registrations) => {
            for (const registration of registrations) {
              void registration.unregister().catch(() => {});
            }
          })
          .catch(() => {});
      };
      console.log(`${tag} managing partition service workers (interval 3s + pagehide)`);
      unregisterPartitionWorkers();
      setInterval(unregisterPartitionWorkers, 3000);
      window.addEventListener('pagehide', unregisterPartitionWorkers);
    });
  } catch {
    // Sandboxed/opaque-origin frames have no serviceWorker access — and
    // the panel's sandbox keeps the frame's real origin (allow-same-origin),
    // so genuine panel frames take the path above.
  }
})();
