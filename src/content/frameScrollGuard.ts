/**
 * Frame-side scroll isolation for pinned-site embeds.
 *
 * When the mouse is inside the panel's embedded site and the site's scroll
 * hits its top/bottom boundary, the browser chains the scroll to the host
 * page underneath (scroll chaining). Wheel events over a cross-origin
 * iframe are never delivered to the parent document, so the only place
 * this can be stopped is inside the frame: `overscroll-behavior: contain`
 * on the frame's document severs the chain to ancestors.
 *
 * This script runs in EVERY subframe (all_frames: true) and asks the
 * background worker whether this frame's origin belongs to a pinned site,
 * so unrelated third-party iframes on normal pages keep default behaviour.
 */

function applyScrollContain(): void {
  const root = document.documentElement;
  if (root) {
    root.style.overscrollBehavior = 'contain';
  }
  if (document.body) {
    document.body.style.overscrollBehavior = 'contain';
  }
}

if (window.top !== window.self) {
  chrome.runtime
    .sendMessage({ action: 'shouldGuardScroll' })
    .then((response: { ok?: boolean } | undefined) => {
      if (!response?.ok) {
        return;
      }
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', applyScrollContain, { once: true });
      } else {
        applyScrollContain();
      }
    })
    .catch(() => {
      // Extension context invalidated (frame outlived an update) — no guard.
    });
}
