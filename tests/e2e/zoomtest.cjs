/**
 * Zoom-compensation E2E: the sidebar must render at the same physical size
 * regardless of the tab's browser zoom.
 *
 * Drives a real zoom change via chrome.tabs.setZoom (extension page bridge),
 * then asserts (through CDP shadow-root piercing — the root is a closed
 * shadow DOM) that:
 *   - html margin-left is STRIP_WIDTH / zoom in CSS px (page shift stays 48 physical px)
 *   - the sidebar root is counter-scaled (transform: scale(1/zoom), height 100vh * zoom)
 *   - .icon-strip / .app-panel measure STRIP_WIDTH/zoom / panelWidth/zoom in CSS px
 *   - zooming back to 100% fully restores the uncompensated styles
 *
 * Requires: `python3 -m http.server 8931 --directory dist` already running.
 */
const { chromium } = require('playwright-core');

const DIST = '/Users/bryan.chatsirichai/Desktop/personal/chrome_operaGX_sidebar_extension/dist';
const PAGE_URL = 'http://127.0.0.1:8931/test.html';
const PROFILE = '/var/folders/0q/00x5l1k548517610h5z6x01c0000gn/T/opencode/extension-e2e/profile-zoom';

let page;
let cdp;
let failures = 0;

function check(label, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${ok ? '' : ' — ' + detail}`);
  if (!ok) failures++;
}

/** Evaluate `fn` with `this` bound to the first pierced shadow-DOM node whose
 *  class list contains `className`. */
async function evalOnPiercedNode(className, fn) {
  const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
  let found = null;
  (function walk(node) {
    if (found) return;
    const attrs = node.attributes || [];
    for (let i = 0; i < attrs.length; i += 2) {
      if (attrs[i] === 'class' && attrs[i + 1].split(/\s+/).includes(className)) {
        found = node;
        return;
      }
    }
    (node.children || []).forEach(walk);
    (node.shadowRoots || []).forEach(walk);
  })(root);
  if (!found) throw new Error(`pierced node not found: ${className}`);
  const { object } = await cdp.send('DOM.resolveNode', { nodeId: found.nodeId, executionContextId: undefined });
  const res = await cdp.send('Runtime.callFunctionOn', {
    objectId: object.objectId,
    functionDeclaration: fn.toString(),
    returnByValue: true
  });
  return res.result.value;
}

async function setTabZoom(zoom) {
  const worker = page.context().serviceWorkers()[0] ?? (await page.context().waitForEvent('serviceworker'));
  const extId = new URL(worker.url()).host;
  const popup = await page.context().newPage();
  await popup.goto(`chrome-extension://${extId}/src/popup/popup.html`);
  await popup.waitForTimeout(500);
  await popup.evaluate(async (z) => {
    const [tab] = await chrome.tabs.query({ url: 'http://127.0.0.1:8931/*' });
    await chrome.tabs.setZoom(tab.id, z);
  }, zoom);
  await popup.close();
}

(async () => {
  const ctx = await chromium.launchPersistentContext(PROFILE, {
    headless: false,
    args: [
      `--disable-extensions-except=${DIST}`,
      `--load-extension=${DIST}`,
      '--no-first-run',
      '--no-default-browser-check',
    ],
  });

  // Determinism guard (see verify.js): never let lastActivePinId point at slot 0.
  {
    const worker = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent('serviceworker'));
    const extId = new URL(worker.url()).host;
    const popup = await ctx.newPage();
    await popup.goto(`chrome-extension://${extId}/src/popup/popup.html`);
    await popup.waitForTimeout(1500);
    await popup.evaluate(async () => {
      await chrome.storage.sync.set({ lastActivePinId: 'x' });
    });
    await popup.close();
  }

  page = await ctx.newPage();
  await page.setViewportSize({ width: 1280, height: 800 });
  cdp = await ctx.newCDPSession(page);
  await page.goto(PAGE_URL, { waitUntil: 'load' });
  await page.waitForTimeout(2500);

  // --- Baseline at 100% ---
  const base = await page.evaluate(() => ({
    dpr: window.devicePixelRatio,
    marginLeft: getComputedStyle(document.documentElement).marginLeft,
    vh: window.innerHeight
  }));
  const baseRoot = await evalOnPiercedNode('sidebar-root', function () {
    const strip = this.querySelector('.icon-strip');
    return {
      transform: this.style.transform,
      height: this.style.height,
      stripW: Math.round(strip.getBoundingClientRect().width)
    };
  });
  check('baseline: strip is 48 CSS px', baseRoot.stripW === 48, JSON.stringify(baseRoot));
  check('baseline: no counter-scale transform', baseRoot.transform === '', JSON.stringify(baseRoot));
  check('baseline: page margin 48px', base.marginLeft === '48px', base.marginLeft);

  // --- Zoom to 150% ---
  const Z = 1.5;
  await setTabZoom(Z);
  await page.waitForTimeout(1200);

  const zoomed = await page.evaluate(() => ({
    dpr: window.devicePixelRatio,
    marginLeft: getComputedStyle(document.documentElement).marginLeft,
    vh: window.innerHeight,
    markerLeft: Math.round(document.getElementById('marker').getBoundingClientRect().left)
  }));
  const zoomedRoot = await evalOnPiercedNode('sidebar-root', function () {
    const strip = this.querySelector('.icon-strip');
    const r = this.getBoundingClientRect();
    return {
      transform: this.style.transform,
      height: this.style.height,
      rectH: Math.round(r.height),
      stripW: Math.round(strip.getBoundingClientRect().width),
      stripVar: strip.style.getPropertyValue('--browser-sidebar-strip-width') ||
        this.style.getPropertyValue('--browser-sidebar-strip-width')
    };
  });

  check('zoom 150%: devicePixelRatio scaled by 1.5', Math.abs(zoomed.dpr / base.dpr - Z) < 0.01, `${base.dpr} -> ${zoomed.dpr}`);
  check('zoom 150%: viewport CSS px shrank by 1.5', Math.abs(zoomed.vh - base.vh / Z) < 2, `${base.vh} -> ${zoomed.vh}`);
  const scale = Number((zoomedRoot.transform.match(/scale\(([\d.]+)\)/) || [])[1]);
  check('zoom 150%: root counter-scaled by 1/1.5', Math.abs(scale - 1 / Z) < 0.001, JSON.stringify(zoomedRoot));
  check('zoom 150%: root height overridden (100vh * zoom)', zoomedRoot.height !== '' && zoomedRoot.height !== undefined, JSON.stringify(zoomedRoot));
  check('zoom 150%: scaled root still fills viewport', Math.abs(zoomedRoot.rectH - zoomed.vh) < 3, `${zoomedRoot.rectH} vs ${zoomed.vh}`);
  check('zoom 150%: strip layout 48 CSS px (48 physical after root scale)', zoomedRoot.stripW === 32, JSON.stringify(zoomedRoot));
  check('zoom 150%: page margin 32 CSS px', zoomed.marginLeft === '32px', zoomed.marginLeft);
  check('zoom 150%: page content starts at 32', zoomed.markerLeft === 32, String(zoomed.markerLeft));

  // --- Open the panel while zoomed: pin slot 0 center is at physical (24, 26)
  //     -> CSS px (16, 17) at 150%. ---
  await page.mouse.click(16, 17);
  await page.waitForTimeout(2000);

  const panel = await evalOnPiercedNode('sidebar-root', function () {
    const p = this.querySelector('.app-panel');
    return { panelW: Math.round(p.getBoundingClientRect().width) };
  });
  check('zoom 150%: panel width = 600/1.5 = 400 CSS px (600 physical)', panel.panelW === 400, JSON.stringify(panel));

  // --- Back to 100%: compensation must fully clear ---
  await setTabZoom(1);
  await page.waitForTimeout(1200);
  const restored = await page.evaluate(() => ({
    marginLeft: getComputedStyle(document.documentElement).marginLeft
  }));
  const restoredRoot = await evalOnPiercedNode('sidebar-root', function () {
    const strip = this.querySelector('.icon-strip');
    return {
      transform: this.style.transform,
      height: this.style.height,
      stripW: Math.round(strip.getBoundingClientRect().width)
    };
  });
  check('restored 100%: no transform', restoredRoot.transform === '', JSON.stringify(restoredRoot));
  check('restored 100%: no height override', restoredRoot.height === '', JSON.stringify(restoredRoot));
  check('restored 100%: strip back to 48 CSS px', restoredRoot.stripW === 48, JSON.stringify(restoredRoot));
  check('restored 100%: page margin back to 48px', restored.marginLeft === '48px', restored.marginLeft);

  await ctx.close();
  console.log(failures === 0 ? 'ALL ZOOM CHECKS PASSED' : `${failures} ZOOM CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((err) => {
  console.error('ZOOMTEST-ERROR:', err);
  process.exit(1);
});
