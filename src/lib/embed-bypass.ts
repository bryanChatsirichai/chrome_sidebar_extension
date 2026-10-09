/**
 * Network-level iframe embed bypass.
 *
 * Many sites refuse iframe embedding by sending `X-Frame-Options` and/or CSP
 * `frame-ancestors` on the document response. Chrome enforces those headers
 * before any page script runs — detecting the block and showing an in-panel
 * fallback does not fix it. The headers must be stripped from the response.
 *
 * A native browser sidebar renders sites in a real top-level browsing context,
 * which is never subject to these headers. A Chrome extension cannot create
 * such a context, so this extension uses `declarativeNetRequest` to rewrite
 * response headers for sub-frame requests to pinned domains so the panel
 * iframe is not blocked in the first place.
 */
import type { Pin } from './types';

/** Fixed rule id so re-syncing atomically replaces the previous rule. */
const EMBED_BYPASS_RULE_ID = 1;
/** Separate rule id: a rejected Sec-Fetch rewrite must not kill rule 1. */
const SEC_FETCH_SPOOF_RULE_ID = 2;

/**
 * Response headers that block iframe embedding when present.
 * `Cross-Origin-Embedder-Policy` is stripped so the embedded app's own
 * subresources are not restricted by the response's COEP requirements.
 */
const HEADERS_TO_STRIP = [
  'X-Frame-Options',
  'Content-Security-Policy',
  'Content-Security-Policy-Report-Only',
  'X-Content-Security-Policy',
  'Cross-Origin-Embedder-Policy'
] as const;

const CORP_HEADER = 'Cross-Origin-Resource-Policy';
const CORP_VALUE = 'cross-origin';

/**
 * Makes pinned-site sub_frame navigations look like address-bar top-level
 * visits. Meta (messenger.com) and similar sites reject embedded contexts via
 * fetch-metadata headers (Sec-Fetch-Dest: iframe + Sec-Fetch-Site:
 * cross-site) with generic "Your Request Couldn't be Processed" error pages.
 * The "document / navigate / none / ?1" set plus no Referer matches a
 * user-typed navigation exactly, so the request carries no sign of being
 * embedded.
 */
const SEC_FETCH_REQUEST_HEADERS = [
  { header: 'Sec-Fetch-Dest', value: 'document' },
  { header: 'Sec-Fetch-Mode', value: 'navigate' },
  { header: 'Sec-Fetch-Site', value: 'none' },
  { header: 'Sec-Fetch-User', value: '?1' }
] as const;

/** Extracts unique, bare (no `www.`) hostnames from a list of pin URLs. */
export function browserSidebarGetPinHostnames(pins: Pin[]): string[] {
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
 * Rewrites the declarativeNetRequest session rules so pinned domains have
 * iframe-blocking response headers stripped and their sub_frame navigations
 * look like top-level visits.
 */
export async function browserSidebarSyncEmbedBypassRules(pins: Pin[]): Promise<void> {
  if (!chrome.declarativeNetRequest?.updateSessionRules) {
    return;
  }

  const requestDomains = browserSidebarGetPinHostnames(pins);

  if (requestDomains.length === 0) {
    await chrome.declarativeNetRequest
      .updateSessionRules({ removeRuleIds: [EMBED_BYPASS_RULE_ID, SEC_FETCH_SPOOF_RULE_ID] })
      .catch(() => {});
    return;
  }

  const condition = {
    requestDomains,
    resourceTypes: ['sub_frame' as chrome.declarativeNetRequest.ResourceType]
  };

  try {
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [EMBED_BYPASS_RULE_ID],
      addRules: [
        {
          id: EMBED_BYPASS_RULE_ID,
          priority: 1,
          condition,
          action: {
            type: 'modifyHeaders' as chrome.declarativeNetRequest.RuleActionType,
            responseHeaders: [
              ...HEADERS_TO_STRIP.map((header) => ({
                header,
                operation: 'remove' as chrome.declarativeNetRequest.HeaderOperation
              })),
              {
                header: CORP_HEADER,
                operation: 'set' as chrome.declarativeNetRequest.HeaderOperation,
                value: CORP_VALUE
              }
            ]
          }
        }
      ]
    });
  } catch (error) {
    console.error('[browser-sidebar] Failed to sync embed bypass rules:', error);
  }

  // Rule 2 is updated separately on purpose: if Chrome ever rejects the
  // Sec-Fetch rewrite, the header-strip rule above still applies.
  try {
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [SEC_FETCH_SPOOF_RULE_ID],
      addRules: [
        {
          id: SEC_FETCH_SPOOF_RULE_ID,
          priority: 1,
          condition,
          action: {
            type: 'modifyHeaders' as chrome.declarativeNetRequest.RuleActionType,
            requestHeaders: [
              ...SEC_FETCH_REQUEST_HEADERS.map(({ header, value }) => ({
                header,
                operation: 'set' as chrome.declarativeNetRequest.HeaderOperation,
                value
              })),
              {
                header: 'Referer',
                operation: 'remove' as chrome.declarativeNetRequest.HeaderOperation
              }
            ]
          }
        }
      ]
    });
  } catch (error) {
    console.error('[browser-sidebar] Failed to sync Sec-Fetch spoof rules:', error);
  }
}
