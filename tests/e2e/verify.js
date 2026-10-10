const { chromium } = require('playwright-core');

const DIST = '/Users/bryan.chatsirichai/Desktop/personal/chrome_operaGX_sidebar_extension/dist';
const PAGE_URL = 'http://127.0.0.1:8931/test.html';

const readState = (label) => page.evaluate((l) => {
  const html = document.documentElement;
  const ids = ['marker', 'fixed-el', 'fixed-bar', 'fixed-corner', 'fixed-modal'];
  const out = { label: l, htmlClasses: html.className, marginLeft: getComputedStyle(html).marginLeft, clientWidth: html.clientWidth };
  for (const id of ids) {
    const el = document.getElementById(id);
    if (!el) continue;
    const r = el.getBoundingClientRect();
    out[id] = { left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top), width: Math.round(r.width) };
  }
  return out;
}, label);

let page;

(async () => {
  const ctx = await chromium.launchPersistentContext('/var/folders/0q/00x5l1k548517610h5z6x01c0000gn/T/opencode/extension-e2e/profile', {
    headless: false,
    args: [
      `--disable-extensions-except=${DIST}`,
      `--load-extension=${DIST}`,
      '--no-first-run',
      '--no-default-browser-check',
    ],
  });

  page = await ctx.newPage();
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(PAGE_URL, { waitUntil: 'load' });
  await page.waitForTimeout(2500);

  const baseline = await readState('baseline-strip');
  console.log(JSON.stringify(baseline, null, 2));

  // Open a pin (first pin button near top of the strip: x 0..48)
  await page.mouse.click(24, 26);
  await page.waitForTimeout(1200);

  const openState = await readState('panel-open');
  console.log(JSON.stringify(openState, null, 2));

  // Scroll the page: fixed elements must stay pinned AND stay shifted
  await page.evaluate(() => window.scrollTo(0, 600));
  await page.waitForTimeout(300);
  const scrollState = await readState('after-scroll-600');
  console.log(JSON.stringify(scrollState, null, 2));

  // Close the panel again (same pin toggles)
  await page.mouse.click(24, 26);
  await page.waitForTimeout(1200);
  const closedState = await readState('panel-closed');
  console.log(JSON.stringify(closedState, null, 2));

  // Dynamic fixed element added after the fact (SPA-style)
  await page.evaluate(() => {
    const el = document.createElement('div');
    el.id = 'late-fixed';
    el.textContent = 'late fixed toast';
    el.style.cssText = 'position:fixed;bottom:60px;left:0;width:220px;height:40px;background:#e33;z-index:99';
    document.body.appendChild(el);
  });
  await page.waitForTimeout(800); // > resweep debounce
  const lateState = await page.evaluate(() => {
    const el = document.getElementById('late-fixed');
    const r = el.getBoundingClientRect();
    return { left: Math.round(r.left), marked: el.hasAttribute('data-browser-sidebar-fixed-shift') };
  });
  console.log('LATE-FIXED:', JSON.stringify(lateState));

  // --- assertions ---
  const results = [];
  const check = (name, cond, detail) => results.push(`${cond ? 'PASS' : 'FAIL'} ${name}${cond ? '' : ' :: ' + JSON.stringify(detail)}`);
  const near = (actual, expected, tol = 1.5) => Math.abs(actual - expected) <= tol;

  const icb = baseline.clientWidth; // fixed elements lay out against the ICB
  const cornerLeft = icb - 20 - 44; // right: 20, width: 44
  const modalBaseLeft = icb / 2 - 150; // left: 50%, width: 300
  const panelLeft = 48 + 600; // strip + default panel width

  check('strip: page content starts right of strip', baseline.marker.left === 48, baseline.marker);
  check('strip: left-fixed element shifted to 48', near(baseline['fixed-el'].left, 48), baseline['fixed-el']);
  check('strip: full-width bar shifted to 48', near(baseline['fixed-bar'].left, 48), baseline['fixed-bar']);
  check('strip: right-anchored corner button untouched', near(baseline['fixed-corner'].left, cornerLeft), { expected: cornerLeft, actual: baseline['fixed-corner'] });
  check('strip: centered modal beyond strip stays put', near(baseline['fixed-modal'].left, modalBaseLeft), { expected: modalBaseLeft, actual: baseline['fixed-modal'] });

  check('panel: left-fixed element shifted past panel', near(openState['fixed-el'].left, panelLeft), openState['fixed-el']);
  check('panel: full-width bar left edge at sidebar edge', near(openState['fixed-bar'].left, panelLeft), openState['fixed-bar']);
  check('panel: full-width bar right edge stays at window edge', Math.abs(openState['fixed-bar'].right - baseline['fixed-bar'].right) <= 2, { open: openState['fixed-bar'], baseline: baseline['fixed-bar'] });
  check('panel: corner button still untouched', Math.abs(openState['fixed-corner'].left - baseline['fixed-corner'].left) < 2, openState['fixed-corner']);
  check('panel: page content shifted', near(openState.marker.left, panelLeft), openState.marker);
  check('panel: centered modal shifted clear of sidebar', near(openState['fixed-modal'].left, modalBaseLeft + panelLeft, 3), openState['fixed-modal']);

  check('scroll: fixed bar still pinned at top', scrollState['fixed-bar'].top === 0, scrollState['fixed-bar']);
  check('scroll: fixed bar still shifted while pinned', scrollState['fixed-bar'].left === openState['fixed-bar'].left, scrollState['fixed-bar']);
  check('scroll: marker scrolled away', scrollState.marker.top < 0, scrollState.marker);

  check('close: back to strip-only shift', near(closedState['fixed-el'].left, 48) && near(closedState['fixed-bar'].left, 48), { el: closedState['fixed-el'], bar: closedState['fixed-bar'] });
  check('close: page content back to 48', closedState.marker.left === 48, closedState.marker);

  check('late fixed element swept after mutation', lateState.marked && near(lateState.left, 48), lateState);

  console.log('\n' + results.join('\n'));
  const failed = results.filter(r => r.startsWith('FAIL'));
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  await ctx.close();
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('E2E-ERROR:', e.message); process.exit(2); });
