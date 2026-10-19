/**
 * YouTube layout diagnostic: does the sidebar (strip + fixed-element shift)
 * malform YouTube's own layout (guide drawer, masthead, centered grid)?
 *
 * Loads youtube.com twice — once without the extension, once with it — and
 * diffs the geometry of YouTube's key layout elements + captures screenshots.
 */
const { chromium } = require('playwright-core');

const DIST = '/Users/bryan.chatsirichai/Desktop/personal/chrome_operaGX_sidebar_extension/dist';
const URL = 'https://www.youtube.com/';
const OUT = '/var/folders/0q/00x5l1k548517610h5z6x01c0000gn/T/opencode';

const MEASURE = () => {
  const r = (el) => {
    if (!el) return null;
    const b = el.getBoundingClientRect();
    return { left: Math.round(b.left), right: Math.round(b.right), top: Math.round(b.top), width: Math.round(b.width), height: Math.round(b.height) };
  };
  const html = document.documentElement;
  const marked = [...document.querySelectorAll('[data-browser-sidebar-fixed-shift]')].map((el) => {
    const b = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return { tag: el.tagName.toLowerCase() + (el.id ? '#' + el.id : ''), cls: (el.className && String(el.className).split(' ')[0]) || '', rect: { l: Math.round(b.left), t: Math.round(b.top), w: Math.round(b.width), h: Math.round(b.height) }, pos: cs.position, translate: cs.translate, wStyle: cs.width };
  });
  // horizontal centering of the primary content column
  const pageMgr = document.querySelector('ytd-page-manager#page-manager');
  const gridItems = [...document.querySelectorAll('ytd-rich-item-renderer')].slice(0, 4).map((el) => Math.round(el.getBoundingClientRect().left));
  const vw = window.innerWidth;
  const pmr = pageMgr ? pageMgr.getBoundingClientRect() : null;
  return {
    vw,
    vh: window.innerHeight,
    htmlClasses: html.className,
    marginLeft: getComputedStyle(html).marginLeft,
    clientW: html.clientWidth,
    scrollW: html.scrollWidth,
    hOverflow: html.scrollWidth > html.clientWidth + 1,
    ytdApp: r(document.querySelector('ytd-app')),
    masthead: r(document.querySelector('ytd-masthead#header')),
    guide: r(document.querySelector('tp-yt-app-drawer#guide')),
    guideContent: r(document.querySelector('#guide #content')),
    pageManager: r(pageMgr),
    pageManagerMarginLeft: pageMgr ? getComputedStyle(pageMgr).marginLeft : null,
    contentCol: r(document.querySelector('ytd-browse[page-subtype="home"] #primary')),
    firstGridItemLefts: gridItems,
    marked,
  };
};

async function run(withExtension, tag) {
  const ctx = await chromium.launchPersistentContext(`${OUT}/yt-diag-${tag}-profile`, {
    headless: false,
    args: withExtension
      ? [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`, '--no-first-run', '--no-default-browser-check']
      : ['--no-first-run', '--no-default-browser-check'],
  });
  const page = await ctx.newPage();
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(6000);
  const state = await page.evaluate(MEASURE);
  await page.screenshot({ path: `${OUT}/yt-${tag}.png` });
  console.log(`\n=== ${tag} ===`);
  console.log(JSON.stringify(state, null, 1));
  await ctx.close();
  return state;
}

(async () => {
  const base = await run(false, 'base');
  const ext = await run(true, 'ext');
  const keys = ['masthead', 'guide', 'pageManager', 'contentCol', 'firstGridItemLefts', 'hOverflow', 'scrollW', 'clientW'];
  console.log('\n=== DIFF (base -> ext) ===');
  for (const k of keys) console.log(`${k}: ${JSON.stringify(base[k])} -> ${JSON.stringify(ext[k])}`);
})().catch((e) => { console.error('YT-DIAG-ERROR:', e.message); process.exit(1); });
