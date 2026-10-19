// E2E: strip drag-to-reorder (panel closed — default strip-only state).
// Seeds two pins at the end of the strip, dispatches an HTML5 DnD sequence
// (dragstart → dragover → drop → dragend) on the shadow-root buttons via CDP,
// then asserts: storage order flipped, strip DOM order flipped, and a plain
// click on the moved pin still opens the panel (drag didn't break clicks).
const { chromium } = require('playwright-core');
const fs = require('fs');

const DIST = '/Users/bryan.chatsirichai/Desktop/personal/chrome_operaGX_sidebar_extension/dist';
const PAGE_URL = 'http://127.0.0.1:8931/test.html';
const EMBED_URL = 'http://127.0.0.1:8931/scroll.html';
const PROFILE = '/var/folders/0q/00x5l1k548517610h5z6x01c0000gn/T/opencode/extension-e2e/profile-drag';

(async () => {
  fs.rmSync(PROFILE, { recursive: true, force: true });
  const ctx = await chromium.launchPersistentContext(PROFILE, {
    headless: false,
    args: [
      `--disable-extensions-except=${DIST}`,
      `--load-extension=${DIST}`,
      '--no-first-run',
      '--no-default-browser-check',
    ],
  });

  const worker = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent('serviceworker'));
  const extId = new URL(worker.url()).host;

  const seedViaPopup = async () => {
    const popup = await ctx.newPage();
    await popup.goto(`chrome-extension://${extId}/src/popup/popup.html`);
    const pins = await popup.evaluate(async (embedUrl) => {
      await new Promise((r) => setTimeout(r, 1500)); // onInstalled defaults race
      const stored = await chrome.storage.sync.get('pins');
      let pins = stored.pins ?? [];
      pins = pins.filter((p) => p.id !== 'dragA' && p.id !== 'dragB');
      pins.push({ id: 'dragA', name: 'Drag A', url: embedUrl, iconUrl: '', order: 97 });
      pins.push({ id: 'dragB', name: 'Drag B', url: embedUrl, iconUrl: '', order: 98 });
      pins = pins.map((p, i) => ({ ...p, order: i }));
      await chrome.storage.sync.set({ pins });
      await chrome.storage.sync.set({ lastActivePinId: 'x' }); // determinism guard
      await chrome.runtime.sendMessage({ action: 'broadcastPinsUpdated', pins });
      return pins.map((p) => p.id);
    }, EMBED_URL);
    await popup.close();
    return pins;
  };

  let order = await seedViaPopup();
  const assert = (ok, msg) => {
    console.log(`${ok ? 'PASS' : 'FAIL'} ${msg}`);
    if (!ok) process.exitCode = 1;
  };
  assert(order.indexOf('dragA') < order.indexOf('dragB'), 'seeded: dragA before dragB');

  const page = await ctx.newPage();
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(PAGE_URL, { waitUntil: 'load' });
  await page.waitForTimeout(2500);

  // CDP helpers: pierce the closed shadow root, find pin buttons by data-pin-id.
  // NOTE: nodeIds are only valid within one getDocument snapshot — find every
  // button needed in a single pass before resolving any of them.
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('DOM.enable');
  await cdp.send('Runtime.enable');
  const snapshotButtons = async () => {
    const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
    // NOTE: pierce:true alone does NOT fold closed shadow roots into
    // `children` — walk shadowRoots explicitly.
    const found = new Map();
    const stack = [root];
    while (stack.length) {
      const node = stack.pop();
      if (node?.nodeName === 'BUTTON') {
        const attrs = node.attributes ?? [];
        for (let i = 0; i < attrs.length; i += 2) {
          if (attrs[i] === 'data-pin-id') found.set(attrs[i + 1], node);
        }
      }
      (node?.children ?? []).forEach((c) => stack.push(c));
      (node?.shadowRoots ?? []).forEach((c) => stack.push(c));
    }
    return found;
  };
  const objectIdOf = async (node) => {
    const { object } = await cdp.send('DOM.resolveNode', { nodeId: node.nodeId });
    return object.objectId;
  };
  const dispatchDrag = async (sourceId, targetId) => {
    await cdp.send('Runtime.callFunctionOn', {
      objectId: sourceId,
      functionDeclaration: `function () {
        const fire = (el, type) => el.dispatchEvent(
          new DragEvent(type, { bubbles: true, cancelable: true })
        );
        fire(this, 'dragstart');
        return true;
      }`,
      awaitPromise: false,
    });
    await cdp.send('Runtime.callFunctionOn', {
      objectId: targetId,
      functionDeclaration: `function () {
        const fire = (el, type) => el.dispatchEvent(
          new DragEvent(type, { bubbles: true, cancelable: true })
        );
        fire(this, 'dragover');
        fire(this, 'drop');
        return true;
      }`,
      awaitPromise: false,
    });
    await cdp.send('Runtime.callFunctionOn', {
      objectId: sourceId,
      functionDeclaration: `function () {
        this.dispatchEvent(new DragEvent('dragend', { bubbles: true }));
        return true;
      }`,
      awaitPromise: false,
    });
  };

  const buttons = await snapshotButtons();
  const nodeA = buttons.get('dragA');
  const nodeB = buttons.get('dragB');
  assert(Boolean(nodeA && nodeB), 'strip: both drag-test pin buttons found');

  // Drag A onto B (panel closed — strip-only default state).
  await dispatchDrag(await objectIdOf(nodeA), await objectIdOf(nodeB));
  await page.waitForTimeout(800);

  // 1. Strip DOM order flipped inside the shadow root.
  // Read the visual (y) position of both buttons — DOM order via y is the
  // user-visible truth for a vertical strip. One snapshot for both.
  const rectOf = async (pinId) => {
    const snap = await snapshotButtons();
    const { object } = await cdp.send('DOM.resolveNode', { nodeId: snap.get(pinId).nodeId });
    const r = await cdp.send('Runtime.callFunctionOn', {
      objectId: object.objectId,
      functionDeclaration: `function () {
        const r = this.getBoundingClientRect();
        return { top: r.top, left: r.left };
      }`,
      returnByValue: true,
      awaitPromise: false,
    });
    return r.result.value;
  };
  const ra = await rectOf('dragA');
  const rb = await rectOf('dragB');
  assert(rb.top < ra.top, `strip: dragB now above dragA (B.top=${rb.top} < A.top=${ra.top})`);

  // 2. Storage order persisted (popup bridge = post-commit truth).
  const checkPopup = await ctx.newPage();
  await checkPopup.goto(`chrome-extension://${extId}/src/popup/popup.html`);
  const stored = await checkPopup.evaluate(async () => {
    const { pins } = await chrome.storage.sync.get('pins');
    return (pins ?? []).map((p) => p.id);
  });
  await checkPopup.close();
  assert(
    stored.indexOf('dragB') < stored.indexOf('dragA'),
    `storage: order persisted (B@${stored.indexOf('dragB')} < A@${stored.indexOf('dragA')})`
  );

  // 3. Plain click on the moved pin still opens the panel (drag wiring must
  //    not eat clicks). dragA is now the LAST pin.
  const pinCount = stored.length;
  const pinY = 8 + (pinCount - 1) * 40 + 18;
  await page.mouse.click(24, pinY);
  await page.waitForTimeout(2000);
  const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
  const iframes = [];
  const walk = (node) => {
    if (!node) return;
    if (node.nodeName === 'IFRAME') iframes.push(node);
    (node.children ?? []).forEach(walk);
    (node.shadowRoots ?? []).forEach(walk);
  };
  walk(root);
  const panelOpen = iframes.some((f) => {
    const attrs = f.attributes ?? [];
    return attrs.some((a, i) => i % 2 === 0 && a === 'src' && String(attrs[i + 1]).includes(EMBED_URL));
  });
  assert(panelOpen, 'click: moved pin still opens the panel after a drag');

  await ctx.close();
  console.log(process.exitCode ? 'DRAGTEST FAILED' : 'dragtest done');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
