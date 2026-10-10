const { chromium } = require('playwright-core');

const DIST = '/Users/bryan.chatsirichai/Desktop/personal/chrome_operaGX_sidebar_extension/dist';
const PAGE_URL = 'http://127.0.0.1:8931/test.html';
const EMBED_URL = 'http://127.0.0.1:8931/scroll.html';

(async () => {
  const ctx = await chromium.launchPersistentContext('/var/folders/0q/00x5l1k548517610h5z6x01c0000gn/T/opencode/extension-e2e/profile-scroll', {
    headless: false,
    args: [
      `--disable-extensions-except=${DIST}`,
      `--load-extension=${DIST}`,
      '--no-first-run',
      '--no-default-browser-check',
    ],
  });

  // --- 1. Seed a pin pointing at the local scroll.html via the popup page ---
  const worker = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent('serviceworker'));
  const extId = new URL(worker.url()).host;

  const popup = await ctx.newPage();
  await popup.goto(`chrome-extension://${extId}/src/popup/popup.html`);
  const pinCount = await popup.evaluate(async (embedUrl) => {
    const stored = await chrome.storage.sync.get('pins');
    const pins = stored.pins ?? [];
    if (!pins.some((p) => p.id === 'scrolltest')) {
      pins.push({ id: 'scrolltest', name: 'Scroll Test', url: embedUrl, iconUrl: '', order: 99 });
      await chrome.storage.sync.set({ pins });
    }
    await chrome.runtime.sendMessage({ action: 'broadcastPinsUpdated', pins });
    return pins.length;
  }, EMBED_URL);
  console.log('PIN_COUNT:', pinCount);
  await popup.close();

  // --- 2. Open the host page and click the seeded pin (last position in strip) ---
  const page = await ctx.newPage();
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(PAGE_URL, { waitUntil: 'load' });
  await page.waitForTimeout(2500);

  const pinIndex = pinCount - 1; // order 99 → last
  const pinY = 8 + pinIndex * 40 + 18; // strip padding 8 + 36px buttons + 4px gap
  await page.mouse.click(24, pinY);
  await page.waitForTimeout(2000);

  // --- 3. Locate the embedded frame via CDP (pierces the closed shadow root) ---
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('DOM.enable');
  const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
  const findIframes = (node, out) => {
    if (!node) return;
    if (node.nodeName === 'IFRAME') out.push(node);
    for (const c of node.children || []) findIframes(c, out);
    for (const s of node.shadowRoots || []) findIframes(s, out);
  };
  const iframes = [];
  findIframes(root, iframes);
  console.log('IFRAMES_IN_DOM:', iframes.length);

  const callOnNode = async (nodeId, expr) => {
    const { object } = await cdp.send('DOM.resolveNode', { nodeId });
    const res = await cdp.send('Runtime.callFunctionOn', {
      objectId: object.objectId,
      functionDeclaration: expr,
      returnByValue: true,
    });
    return res.result?.value;
  };

  const target = iframes.find((n) => (n.attributes || []).some((a) => String(a).startsWith(EMBED_URL)));
  const frameInfo = target
    ? await callOnNode(target.nodeId, `function() {
        const d = this.contentDocument;
        if (!d) return { found: false, noDoc: true };
        return {
          found: true,
          href: d.location?.href,
          guard: d.documentElement.style.overscrollBehavior,
          scrollHeight: d.documentElement.scrollHeight,
          clientHeight: d.documentElement.clientHeight,
        };
      }`)
    : { found: false };
  console.log('FRAME:', JSON.stringify(frameInfo));

  // Scroll the embedded page to its bottom
  if (target) {
    await callOnNode(target.nodeId, 'function() { this.contentWindow.scrollTo(0, 999999); }');
  }
  await page.waitForTimeout(300);

  // --- 4. Wheel DOWN over the iframe (at its bottom boundary): page must NOT scroll ---
  await page.mouse.move(350, 400); // panel spans x 48..648
  await page.mouse.wheel(0, 400);
  await page.waitForTimeout(300);
  const afterIframeWheel = await page.evaluate(() => ({
    pageY: window.scrollY,
  }));
  console.log('AFTER_IFRAME_BOTTOM_WHEEL:', JSON.stringify(afterIframeWheel));

  // --- 5. Wheel over the panel header (non-scrollable chrome): page must NOT scroll ---
  await page.mouse.move(350, 20);
  await page.mouse.wheel(0, 300);
  await page.waitForTimeout(300);
  const afterHeaderWheel = await page.evaluate(() => ({ pageY: window.scrollY }));
  console.log('AFTER_HEADER_WHEEL:', JSON.stringify(afterHeaderWheel));

  // --- 6. Control: wheel over plain page area: page MUST scroll ---
  await page.mouse.move(900, 600);
  await page.mouse.wheel(0, 400);
  await page.waitForTimeout(300);
  const afterPageWheel = await page.evaluate(() => ({ pageY: window.scrollY }));
  console.log('AFTER_PAGE_WHEEL:', JSON.stringify(afterPageWheel));

  // --- assertions ---
  const results = [];
  const check = (name, cond, detail) => results.push(`${cond ? 'PASS' : 'FAIL'} ${name}${cond ? '' : ' :: ' + JSON.stringify(detail)}`);
  check('embedded frame located and loaded', frameInfo.found === true, frameInfo);
  check('frame guard applied (overscroll-behavior: contain)', frameInfo.guard === 'contain', frameInfo);
  check('embedded page is scrollable', frameInfo.scrollHeight > frameInfo.clientHeight + 100, frameInfo);
  check('wheel at iframe bottom does not scroll page', afterIframeWheel.pageY === 0, afterIframeWheel);
  check('wheel over panel header does not scroll page', afterHeaderWheel.pageY === 0, afterHeaderWheel);
  check('wheel over page area scrolls page', afterPageWheel.pageY > 0, afterPageWheel);

  console.log('\n' + results.join('\n'));
  const failed = results.filter((r) => r.startsWith('FAIL'));
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  await ctx.close();
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('E2E-ERROR:', e.message); process.exit(2); });
