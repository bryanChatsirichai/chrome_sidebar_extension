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

  const openState = await readState('panel-open-overlay');
  console.log(JSON.stringify(openState, null, 2));

  // Scroll the page: fixed elements must stay pinned AND stay shifted
  await page.evaluate(() => window.scrollTo(0, 600));
  await page.waitForTimeout(300);
  const scrollState = await readState('after-scroll-600');
  console.log(JSON.stringify(scrollState, null, 2));

  // Click on the page (outside the sidebar host / iframe): panel must close
  await page.mouse.click(900, 600);
  await page.waitForTimeout(800);
  const closedState = await readState('closed-by-outside-click');
  console.log(JSON.stringify(closedState, null, 2));

  // Dynamic fixed element added after the fact (SPA-style), still strip-shifted
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

  check('strip: page content starts right of strip', baseline.marker.left === 48, baseline.marker);
  check('strip: left-fixed element shifted to 48', near(baseline['fixed-el'].left, 48), baseline['fixed-el']);
  check('strip: full-width bar shifted to 48', near(baseline['fixed-bar'].left, 48), baseline['fixed-bar']);
  check('strip: right-anchored corner button untouched', near(baseline['fixed-corner'].left, cornerLeft), { expected: cornerLeft, actual: baseline['fixed-corner'] });
  check('strip: centered modal beyond strip stays put', near(baseline['fixed-modal'].left, modalBaseLeft), { expected: modalBaseLeft, actual: baseline['fixed-modal'] });

  check('overlay: html class is open', openState.htmlClasses === 'browser-sidebar-open', openState.htmlClasses);
  check('overlay: page NOT pushed (margin stays strip width)', openState.marginLeft === '48px', openState.marginLeft);
  check('overlay: page content still at 48', openState.marker.left === 48, openState.marker);
  check('overlay: fixed elements still at 48', near(openState['fixed-el'].left, 48) && near(openState['fixed-bar'].left, 48), { el: openState['fixed-el'], bar: openState['fixed-bar'] });
  check('overlay: corner button untouched', Math.abs(openState['fixed-corner'].left - baseline['fixed-corner'].left) < 2, openState['fixed-corner']);

  check('scroll: fixed bar still pinned at top', scrollState['fixed-bar'].top === 0, scrollState['fixed-bar']);
  check('scroll: fixed bar still shifted while pinned', scrollState['fixed-bar'].left === openState['fixed-bar'].left, scrollState['fixed-bar']);
  check('scroll: marker scrolled away', scrollState.marker.top < 0, scrollState.marker);

  check('outside click: panel closed', closedState.htmlClasses === 'browser-sidebar-strip-visible', closedState.htmlClasses);
  check('outside click: page still at 48', closedState.marker.left === 48, closedState.marker);

  check('late fixed element swept after mutation', lateState.marked && near(lateState.left, 48), lateState);

  console.log('\n' + results.join('\n'));
  const failed = results.filter(r => r.startsWith('FAIL'));
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  await ctx.close();
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('E2E-ERROR:', e.message); process.exit(2); });
