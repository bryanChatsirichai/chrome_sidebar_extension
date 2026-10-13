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
})();
