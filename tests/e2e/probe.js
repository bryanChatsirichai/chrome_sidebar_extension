const { chromium } = require('playwright-core');

const DIST = '/Users/bryan.chatsirichai/Desktop/personal/chrome_operaGX_sidebar_extension/dist';

const SITES = [
  'https://www.youtube.com/',
  'https://chatgpt.com/',
  'https://x.com/',
  'https://github.com/',
  'https://www.reddit.com/',
];

(async () => {
  const ctx = await chromium.launchPersistentContext('/var/folders/0q/00x5l1k548517610h5z6x01c0000gn/T/opencode/extension-e2e/probe-profile', {
    headless: false,
    args: [
      `--disable-extensions-except=${DIST}`,
      `--load-extension=${DIST}`,
      '--no-first-run',
      '--no-default-browser-check',
    ],
  });

  for (const url of SITES) {
    const page = await ctx.newPage();
    await page.setViewportSize({ width: 1280, height: 800 });
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(3000);

      const probe = await page.evaluate(() => {
        return new Promise((resolve) => {
          const samples = [];
          let markerFlips = 0;
          let styleChurn = 0;
          const html = document.documentElement;
          const mo = new MutationObserver((records) => {
            for (const r of records) {
              if (r.attributeName === 'data-browser-sidebar-fixed-shift') markerFlips++;
              if (r.attributeName === 'style' && r.target.hasAttribute?.('data-browser-sidebar-fixed-shift')) styleChurn++;
            }
          });
          mo.observe(html, { subtree: true, attributes: true, attributeFilter: ['style', 'data-browser-sidebar-fixed-shift', 'class'] });
          const t0 = performance.now();
          const timer = setInterval(() => {
            samples.push({
              t: Math.round(performance.now() - t0),
              cls: html.className,
              ml: getComputedStyle(html).marginLeft,
              clientW: html.clientWidth,
              scrollW: html.scrollWidth,
              bodyW: Math.round(document.body.getBoundingClientRect().width),
              hScroll: html.scrollWidth > html.clientWidth + 1,
            });
          }, 200);
          setTimeout(() => {
            clearInterval(timer);
            mo.disconnect();
            resolve({ samples, markerFlips, styleChurn });
          }, 6000);
        });
      });

      const s = probe.samples;
      const margins = [...new Set(s.map(x => x.ml))];
      const widths = [...new Set(s.map(x => x.bodyW))];
      const hscrollEver = s.some(x => x.hScroll);
      const unstable = margins.length > 1 || widths.length > 2;
      console.log(`\n=== ${url}`);
      console.log(`margins seen: ${JSON.stringify(margins)} | bodyW variants: ${widths.join(',')} | hScrollbar at some point: ${hscrollEver} | markerFlips: ${probe.markerFlips} | styleChurn: ${probe.styleChurn}`);
      console.log(unstable || probe.markerFlips > 2 || probe.styleChurn > 4 ? '>>> UNSTABLE' : 'stable');
    } catch (e) {
      console.log(`\n=== ${url}\nSKIP: ${e.message.split('\n')[0]}`);
    }
    await page.close();
  }
  await ctx.close();
})().catch((e) => { console.error('PROBE-ERROR:', e.message); process.exit(1); });
