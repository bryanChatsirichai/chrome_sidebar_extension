/**
 * Cookie-based session reuse for pinned sites.
 *
 * Sites loaded in the panel iframe are third-party embeds: the panel lives on
 * whatever page the user is browsing, so requests from the iframe are
 * cross-site. Chrome does not attach `SameSite=Lax` (or unspecified) cookies
 * to cross-site sub-frame requests — which is why signed-in sites such as
 * claude.ai show a login page inside the panel even though the browser
 * already holds a valid session.
 *
 * The extension has host access plus the `cookies` permission, so it can
 * re-write those cookies with `sameSite: 'no_restriction'`. The cookie jar is
 * shared browser-wide, so the panel iframe then reuses the exact session the
 * user already has in normal tabs.
 *
 * A `cookies.onChanged` watcher keeps the attribute flipped when sites
 * re-issue cookies with restrictive SameSite attributes (login refreshes,
 * session rotation). Our own re-writes carry `no_restriction` and are
 * filtered out, so the watcher cannot loop.
 *
 * Note: storage partitioning still applies to localStorage/IndexedDB inside
 * a third-party iframe; this module only restores cookie-based sessions.
 */
import { browserSidebarGetPinHostnames } from './embed-bypass';
import { browserSidebarGetStorageData } from './storage';
import type { Pin } from './types';

/** SameSite values that are NOT attached to cross-site iframe requests. */
const IFRAME_BLOCKED_SAMESITE = new Set<string>(['lax', 'strict', 'unspecified']);

/** Returns the cookie domain without its leading dot. */
function browserSidebarBareCookieDomain(domain: string): string {
  return domain.replace(/^\./, '');
}

/** True when a cookie domain belongs to one of the pinned hostnames. */
function browserSidebarIsPinnedCookieDomain(domain: string, pinnedHosts: string[]): boolean {
  const bare = browserSidebarBareCookieDomain(domain);
  return pinnedHosts.some((host) => bare === host || bare.endsWith(`.${host}`));
}

/**
 * Re-writes one cookie with `sameSite: 'no_restriction'` so it is sent when
 * the site is embedded in the panel iframe. Returns true when changed.
 */
async function browserSidebarRelaxCookie(cookie: chrome.cookies.Cookie): Promise<boolean> {
  // Already usable in iframes, or not eligible (SameSite=None requires
  // the Secure attribute).
  if (cookie.sameSite === 'no_restriction' || !cookie.secure) {
    return false;
  }

  const bareDomain = browserSidebarBareCookieDomain(cookie.domain);
  const details: chrome.cookies.SetDetails = {
    url: `https://${bareDomain}/`,
    name: cookie.name,
    value: cookie.value,
    path: cookie.path,
    secure: true,
    httpOnly: cookie.httpOnly,
    sameSite: 'no_restriction'
  };

  // Preserve domain cookies (leading dot) vs host-only cookies (no domain).
  if (cookie.domain.startsWith('.')) {
    details.domain = cookie.domain;
  }

  // Preserve session cookies (no expiration) vs persistent ones.
  if (typeof cookie.expirationDate === 'number') {
    details.expirationDate = cookie.expirationDate;
  }

  try {
    const result = await chrome.cookies.set(details);
    if (!result) {
      console.warn(
        `[browser-sidebar] Failed to relax SameSite for cookie "${cookie.name}" on ${cookie.domain}`
      );
      return false;
    }
    return true;
  } catch (error) {
    console.warn(
      `[browser-sidebar] Error relaxing SameSite for cookie "${cookie.name}" on ${cookie.domain}:`,
      error
    );
    return false;
  }
}

/**
 * Re-writes cookies for every pinned domain so their sessions carry over to
 * the panel iframe. Call whenever the pin list changes or the extension
 * starts up.
 */
export async function browserSidebarRelaxPinnedSiteCookies(pins: Pin[]): Promise<void> {
  if (!chrome.cookies?.getAll) {
    return;
  }

  const pinnedHosts = browserSidebarGetPinHostnames(pins);
  if (pinnedHosts.length === 0) {
    return;
  }

  for (const host of pinnedHosts) {
    try {
      // `domain` matches the host itself plus any subdomains.
      const cookies = await chrome.cookies.getAll({ domain: host });
      await Promise.all(cookies.map((cookie) => browserSidebarRelaxCookie(cookie)));
    } catch (error) {
      console.warn(`[browser-sidebar] Failed to read cookies for ${host}:`, error);
    }
  }
}

/**
 * Registers the cookie watcher. Must be called synchronously at the top level
 * of the service worker so it is re-registered on every worker wake.
 */
export function browserSidebarWatchPinnedSiteCookies(): void {
  if (!chrome.cookies?.onChanged) {
    return;
  }

  chrome.cookies.onChanged.addListener((change) => {
    // Skip deletions and our own re-writes (they carry `no_restriction`).
    if (change.removed || !IFRAME_BLOCKED_SAMESITE.has(change.cookie.sameSite)) {
      return;
    }

    void (async () => {
      try {
        const data = await browserSidebarGetStorageData();
        if (!browserSidebarIsPinnedCookieDomain(change.cookie.domain, browserSidebarGetPinHostnames(data.pins))) {
          return;
        }
        await browserSidebarRelaxCookie(change.cookie);
      } catch (error) {
        console.warn('[browser-sidebar] Cookie watcher failed:', error);
      }
    })();
  });
}
