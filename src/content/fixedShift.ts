import { BROWSER_SIDEBAR_DEFAULTS } from '../lib/defaults';
import { getSidebarZoomFactor } from './sidebarUtils';

/**
 * Shifts viewport-anchored page elements right of the browser-sidebar:
 * `position: fixed` elements, plus `position: absolute` elements whose
 * containing block is the initial containing block (e.g. YouTube's ytd-app
 * app root) — both ignore the html margin and would otherwise sit under
 * the sidebar strip.
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
 * Numeric shift width. The panel overlays the page, so the page-level shift
 * is always the strip width; only the strip needs to be cleared of fixed
 * elements. Computed from the page-shift classes — NOT from the computed
 * `--browser-sidebar-shift` (unregistered custom properties keep their
 * calc() token form, which parseFloat() cannot read). Zoom-compensated so the
 * physical shift stays STRIP_WIDTH device px at any browser zoom.
 */
function currentShiftPx(): number {
  const html = document.documentElement;
  if (html.classList.contains('browser-sidebar-hidden')) {
    return 0;
  }
  if (
    html.classList.contains('browser-sidebar-open') ||
    html.classList.contains('browser-sidebar-strip-visible')
  ) {
    return BROWSER_SIDEBAR_DEFAULTS.STRIP_WIDTH / getSidebarZoomFactor();
  }
  return 0;
}

function isSidebarHostSubtree(el: Element): boolean {
  const host = document.getElementById('browser-sidebar-host');
  return Boolean(host && (el === host || host.contains(el)));
}

/**
 * True when an element's containing block is the initial containing block —
 * i.e. it is viewport-anchored like a fixed element even though its position
 * is `absolute` (no positioned / transform / filter / will-change / contain
 * ancestor between it and the document element). YouTube's `ytd-app` is the
 * canonical case: an absolute app root at left:0 that the html margin cannot
 * move, so without this check the marked masthead shifts while the content
 * below it (and the site's own guide drawer) stay put, malforming the page.
 */
function isViewportAnchored(el: Element): boolean {
  let parent: Element | null = el.parentElement;
  while (parent) {
    const cs = getComputedStyle(parent);
    if (cs.position !== 'static') {
      return false;
    }
    if (
      cs.transform !== 'none' ||
      cs.perspective !== 'none' ||
      cs.filter !== 'none' ||
      cs.backdropFilter !== 'none'
    ) {
      return false;
    }
    const will = cs.willChange;
    if (will.includes('transform') || will.includes('perspective') || will.includes('filter')) {
      return false;
    }
    const contain = cs.contain;
    if (
      contain.includes('layout') ||
      contain.includes('paint') ||
      contain.includes('content') ||
      contain.includes('strict')
    ) {
      return false;
    }
    if (cs.containerType !== 'normal' && cs.containerType !== '') {
      return false;
    }
    parent = parent.parentElement;
  }
  return true;
}

/**
 * Fixed elements always qualify; absolute ones only when anchored to the
 * ICB (viewport-anchored). Everything else follows the html margin.
 */
function isShiftablePosition(el: Element, cs: CSSStyleDeclaration): boolean {
  if (cs.position === 'fixed') {
    return true;
  }
  return cs.position === 'absolute' && isViewportAnchored(el);
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

/** True when an ancestor is already managed — the element rides that
 *  ancestor's translate and must never be marked again (double shift). */
function hasMarkedAncestor(el: Element): boolean {
  let parent: Element | null = el.parentElement;
  while (parent) {
    if (savedInline.has(parent)) {
      return true;
    }
    parent = parent.parentElement;
  }
  return false;
}

/** After marking `el`, any managed descendant that is now clear of the
 *  sidebar (shifted by el's translate) must be released — it would otherwise
 *  double-shift. Runs in the same synchronous pass, so measurements see the
 *  just-written translate. */
function releaseRedundantDescendants(el: Element, shift: number): void {
  for (const desc of el.querySelectorAll('*')) {
    if (!savedInline.has(desc)) {
      continue;
    }
    const rect = desc.getBoundingClientRect();
    if (rect.left >= shift - 0.5) {
      removeOverride(desc);
    }
  }
}

/**
 * Single-element check: applies the override if the element is a visible
 * viewport-anchored (fixed / ICB-absolute) element intruding into the
 * sidebar area. Read-only otherwise.
 */
function checkElement(el: Element, shift: number): void {
  if (savedInline.has(el) || isSidebarHostSubtree(el) || hasMarkedAncestor(el)) {
    return;
  }
  if (el === document.documentElement || el === document.body) {
    return;
  }
  const cs = getComputedStyle(el);
  if (cs.display === 'none' || cs.visibility === 'hidden' || !isShiftablePosition(el, cs)) {
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
  releaseRedundantDescendants(el, shift);
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
        if (cs.display === 'none' || cs.visibility === 'hidden' || !isShiftablePosition(el, cs)) {
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
