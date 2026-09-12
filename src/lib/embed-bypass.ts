/**
 * Network-level iframe embed bypass.
 *
 * Many sites refuse iframe embedding by sending `X-Frame-Options` and/or CSP
 * `frame-ancestors` on the document response. Chrome enforces those headers
 * before any page script runs — detecting the block and opening a companion
 * window does not fix it. The headers must be stripped from the response.
 *
 * Opera GX's native sidebar renders sites in a real top-level browsing context,
 * which is never subject to frame-ancestors. Extensions cannot do that, but
 * `declarativeNetRequest` can rewrite response headers for sub-frame requests
 * to pinned domains so the panel iframe is not blocked in the first place.
 */
import type { Pin } from './types';

/** Fixed rule id so re-syncing atomically replaces the previous rule. */
const EMBED_BYPASS_RULE_ID = 1;

/** Response headers that block iframe embedding when present. */
const HEADERS_TO_STRIP = [
  'X-Frame-Options',
  'Content-Security-Policy',
  'Content-Security-Policy-Report-Only',
  'X-Content-Security-Policy'
] as const;

/** Extracts unique, bare (no `www.`) hostnames from a list of pin URLs. */
function gxGetPinHostnames(pins: Pin[]): string[] {
  const hostnames = new Set<string>();

  for (const pin of pins) {
    try {
      const hostname = new URL(pin.url).hostname.replace(/^www\./, '');
      if (hostname) {
        hostnames.add(hostname);
      }
    } catch {
      // Ignore malformed pin URLs.
    }
  }

  return Array.from(hostnames);
}

/**
 * Rewrites the declarativeNetRequest session rule so pinned domains have
 * iframe-blocking response headers stripped for sub-frame requests only.
 */
export async function gxSyncEmbedBypassRules(pins: Pin[]): Promise<void> {
  if (!chrome.declarativeNetRequest?.updateSessionRules) {
    return;
  }

  const requestDomains = gxGetPinHostnames(pins);

  try {
    if (requestDomains.length === 0) {
      await chrome.declarativeNetRequest.updateSessionRules({
        removeRuleIds: [EMBED_BYPASS_RULE_ID]
      });
      return;
    }

    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [EMBED_BYPASS_RULE_ID],
      addRules: [
        {
          id: EMBED_BYPASS_RULE_ID,
          priority: 1,
          condition: {
            requestDomains,
            resourceTypes: ['sub_frame' as chrome.declarativeNetRequest.ResourceType]
          },
          action: {
            type: 'modifyHeaders' as chrome.declarativeNetRequest.RuleActionType,
            responseHeaders: HEADERS_TO_STRIP.map((header) => ({
              header,
              operation: 'remove' as chrome.declarativeNetRequest.HeaderOperation
            }))
          }
        }
      ]
    });
  } catch (error) {
    console.error('[GX Sidebar] Failed to sync embed bypass rules:', error);
  }
}
