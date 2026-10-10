import { BROWSER_SIDEBAR_DEFAULTS } from '../lib/defaults';

/**
 * Shifts `position: fixed` page elements right of the browser-sidebar.
 *
 * The page itself is shifted by the injected page-shift stylesheet
 * (`html { margin-left: … }`), which only moves normal-flow content: fixed
 * elements are anchored to the viewport and would otherwise stay underneath
 * the sidebar (a content script cannot shrink the real viewport — that is a
 * browser-chrome capability, cf. chrome.sidePanel).
 *
 * Closest supported behaviour, without pretending the viewport changed:
 * every visible fixed element whose left edge starts inside the sidebar area
 * gets a `translate: var(--browser-sidebar-shift)` override (the standalone
 * CSS `translate` property, so the site's own `transform` is never touched —
 * fixed elements keep their scroll pinning). Full-viewport-width bars also
 * get `width: calc(<computed> - var(--browser-sidebar-shift))` so they do
 * not stick out past the window's right edge. Because both overrides are
 * driven by the same live CSS variable as the page margin, drag-resizing
 * updates everything in one reflow and open/close animates in step.
 *
 * Sweep strategy (important — this module caused a resize fight on
 * mutation-heavy sites like github.com when it re-ran full sweeps):
 *  - `refreshFixedElementShift()` performs a FULL sweep (release everything,
 *    re-measure, re-apply). Call it only on explicit state changes: open /
 *    close / hidden / committed panel width.
 *  - DOM mutations are handled incrementally: added subtrees are checked for
 *    new intruders, removed nodes are released, and attribute (class/style)
 *    changes are verified per element. Managed elements are never released
 *    and re-applied just because the page mutated — releasing and
 *    re-capturing widths every debounce tick makes site JS react to our
 *    writes, which re-triggers the observer in a visible resize loop.
 *
 * Known limitations (inherent to the approach):
 *  - Elements inside same-origin iframes / site shadow roots are not reached.
 *  - Fixed elements entirely to the right of the sidebar are left alone, as
 *    in a real shrunk viewport.
 *  - An element the site re-anchors to the right while managed stays shifted
 *    until the next state change (full sweep re-evaluates it).
 *  - A site that writes inline `translate`/`width` on a managed element
 *    after us wins until we release on the next state change.
 */

const SHIFT_VAR = '--browser-sidebar-shift';
const MARKER = 'data-browser-sidebar-fixed-shift';
/** Full-viewport bars wider than this threshold get a width compensation. */
const FULL_WIDTH_TOLERANCE_PX = 40;
const RESWEEP_DEBOUNCE_MS = 250;

interface SavedInlineProps {
  translate: string;
  width: string;
}

const savedInline = new Map<Element, SavedInlineProps>();
let observer: MutationObserver | null = null;
let resweepTimer: ReturnType<typeof setTimeout> | null = null;
let pendingRecords: MutationRecord[] = [];

/**
 * Numeric shift width. Computed from the page-shift classes plus the inline
 * `--browser-sidebar-panel-width` (always a plain px value) — NOT from the
 * computed `--browser-sidebar-shift`, whose open-state value is a calc()
 * token stream ("calc(48px + 600px)") that parseFloat() cannot read.
 */
function currentShiftPx(): number {
  const html = document.documentElement;
  if (html.classList.contains('browser-sidebar-hidden')) {
    return 0;
  }
  if (html.classList.contains('browser-sidebar-open')) {
    const panel = parseFloat(html.style.getPropertyValue('--browser-sidebar-panel-width'));
    return (
      BROWSER_SIDEBAR_DEFAULTS.STRIP_WIDTH +
      (Number.isFinite(panel) ? panel : BROWSER_SIDEBAR_DEFAULTS.DEFAULT_SETTINGS.panelWidth)
    );
  }
  if (html.classList.contains('browser-sidebar-strip-visible')) {
    return BROWSER_SIDEBAR_DEFAULTS.STRIP_WIDTH;
  }
  return 0;
}

function isSidebarHostSubtree(el: Element): boolean {
  const host = document.getElementById('browser-sidebar-host');
  return Boolean(host && (el === host || host.contains(el)));
}

function removeOverride(el: Element): void {
  const props = savedInline.get(el);
  if (!props) {
    return;
  }
  const style = (el as HTMLElement).style;
  if (style.translate !== props.translate) {
    style.translate = props.translate;
  }
  if (style.width !== props.width) {
    style.width = props.width;
  }
  el.removeAttribute(MARKER);
  savedInline.delete(el);
}

function applyOverride(el: Element, fullWidth: boolean, computedWidth: string): void {
  const style = (el as HTMLElement).style;
  savedInline.set(el, { translate: style.translate, width: style.width });
  const wantedTranslate = `var(${SHIFT_VAR})`;
  if (style.translate !== wantedTranslate) {
    style.translate = wantedTranslate;
  }
  if (fullWidth) {
    const wantedWidth = `calc(${computedWidth} - var(${SHIFT_VAR}))`;
    if (style.width !== wantedWidth) {
      style.width = wantedWidth;
    }
  }
  el.setAttribute(MARKER, '');
}

/**
 * Single-element check: applies the override if the element is a visible
 * fixed element intruding into the sidebar area. Read-only otherwise.
 */
function checkElement(el: Element, shift: number): void {
  if (savedInline.has(el) || isSidebarHostSubtree(el)) {
    return;
  }
  if (el === document.documentElement || el === document.body) {
    return;
  }
  const cs = getComputedStyle(el);
  if (cs.position !== 'fixed' || cs.display === 'none' || cs.visibility === 'hidden') {
    return;
  }
  const rect = el.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) {
    return;
  }
  if (rect.left >= shift - 0.5) {
    return; // already clear of the sidebar
  }
  const fullWidth = rect.width >= window.innerWidth - FULL_WIDTH_TOLERANCE_PX;
  applyOverride(el, fullWidth, cs.width);
}

/**
 * Full sweep: release every override, re-measure, re-apply. Only for
 * explicit state changes (open/close/hidden/committed width) — running this
 * on DOM mutations caused a write-fight with site JS on busy pages.
 */
function fullSweep(): void {
  // Disconnect while sweeping: our own inline-style writes would otherwise
  // fire the observer and schedule an endless resweep loop.
  if (observer) {
    observer.disconnect();
    observer = null;
  }

  const shift = currentShiftPx();

  // Release every override first so measurements see unshifted positions;
  // re-applying the same values within one frame causes no visual change.
  for (const el of Array.from(savedInline.keys())) {
    if (el.isConnected) {
      removeOverride(el);
    } else {
      savedInline.delete(el);
    }
  }

  pendingRecords = [];

  if (shift <= 0) {
    stopObserver();
    return;
  }

  const body = document.body;
  if (!body) {
    startObserver(); // body not parsed yet — the observer will catch it
    return;
  }

  for (const el of body.querySelectorAll('*')) {
    checkElement(el, shift);
  }

  startObserver();
}

/**
 * Incremental pass over mutation records. Never rewrites a managed element
 * unless it stopped being fixed/visible; discovers newly-added intruders.
 */
function handleRecords(records: MutationRecord[]): void {
  const shift = currentShiftPx();
  if (shift <= 0) {
    return;
  }
  for (const record of records) {
    if (record.type === 'childList') {
      for (const node of record.removedNodes) {
        if (!(node instanceof Element)) {
          continue;
        }
        if (savedInline.has(node)) {
          removeOverride(node);
        }
        for (const el of node.querySelectorAll('*')) {
          if (savedInline.has(el)) {
            removeOverride(el);
          }
        }
      }
      for (const node of record.addedNodes) {
        if (!(node instanceof Element)) {
          continue;
        }
        checkElement(node, shift);
        for (const el of node.querySelectorAll('*')) {
          checkElement(el, shift);
        }
      }
    } else if (record.type === 'attributes' && record.target instanceof Element) {
      const el = record.target;
      if (savedInline.has(el)) {
        const cs = getComputedStyle(el);
        if (cs.position !== 'fixed' || cs.display === 'none' || cs.visibility === 'hidden') {
          removeOverride(el);
        }
      } else {
        checkElement(el, shift);
      }
    }
  }
}

function onMutations(records: MutationRecord[]): void {
  if (currentShiftPx() <= 0) {
    return;
  }
  pendingRecords.push(...records);
  if (!resweepTimer) {
    resweepTimer = setTimeout(() => {
      resweepTimer = null;
      const batch = pendingRecords;
      pendingRecords = [];
      handleRecords(batch);
    }, RESWEEP_DEBOUNCE_MS);
  }
}

function startObserver(): void {
  if (observer) {
    return;
  }
  observer = new MutationObserver(onMutations);
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['class', 'style']
  });
}

function stopObserver(): void {
  observer?.disconnect();
  observer = null;
  if (resweepTimer) {
    clearTimeout(resweepTimer);
    resweepTimer = null;
  }
  pendingRecords = [];
}

/**
 * Re-evaluates the fixed-element shift with a full sweep. Call after the
 * page-shift classes (`applyLayoutClasses`) or a committed panel-width
 * change; routine DOM mutations are handled incrementally by the observer.
 */
export function refreshFixedElementShift(): void {
  if (currentShiftPx() > 0) {
    startObserver();
  }
  fullSweep();
}
