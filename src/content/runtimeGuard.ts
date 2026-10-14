/**
 * Extension-context invalidation guard for content scripts.
 *
 * When the extension is reloaded or updated, content scripts already
 * injected into open tabs are orphaned: from that moment every
 * chrome.runtime.* / chrome.storage.* call they make throws
 * "Error: Extension context invalidated". One unguarded throw inside a
 * React render (e.g. chrome.runtime.getURL for a pin icon) takes down the
 * whole sidebar content script for that page.
 *
 * The canonical liveness check is chrome.runtime?.id — it evaluates to
 * undefined (does not throw) once the context is invalidated.
 */
export function browserSidebarRuntimeAlive(): boolean {
  try {
    return typeof chrome !== 'undefined' && Boolean(chrome.runtime?.id);
  } catch {
    return false;
  }
}

/**
 * No-throw runtime.sendMessage. Returns undefined when the context is dead
 * or the send fails — callers must treat undefined as "no answer" and fall
 * back to local behavior.
 */
export async function browserSidebarSafeSendMessage<T = unknown>(
  message: unknown
): Promise<T | undefined> {
  if (!browserSidebarRuntimeAlive()) {
    return undefined;
  }
  try {
    return (await chrome.runtime.sendMessage(message)) as T | undefined;
  } catch {
    return undefined;
  }
}
