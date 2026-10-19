# browser-sidebar

[![Release](https://img.shields.io/github/v/release/bryanChatsirichai/chrome_operaGX_sidebar_extension?label=download)](https://github.com/bryanChatsirichai/chrome_operaGX_sidebar_extension/releases/latest)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](#license)

A Chrome extension that adds a native-browser-style sidebar to any website: a vertical icon strip on the left edge of the page with an expandable panel for your pinned web apps — Discord, Messenger, ChatGPT, or any site you choose.

## Features

- **Sidebar on every page** — a 48px icon strip on the left edge of every `http(s)` page; hide it any time from the toolbar icon
- **Expandable panel (300–1000px)** for pinned sites — overlays the page, like a native browser sidebar
- **Blocked sites just work** — sites that normally refuse to be embedded in iframes (Twitch, X, Instagram, ChatGPT, Claude, Messenger, …) load directly in the panel; see [Why some sites normally fail](#why-some-sites-normally-fail)
- **Instant switching** — recently used panels stay alive in the background and hovering a pin preloads it, so switching apps is instant
- **Smooth resizing** — drag the panel edge or use the settings slider; heavy sites never jank during the gesture
- **Smart page shifting** — normal content *and* fixed elements (sticky bars, floating buttons) shift right of the strip, so nothing hides underneath it
- **Scroll isolation** — scrolling inside an embedded app never chain-scrolls the page underneath
- **Pin any page** — one click adds the current site with its title and favicon; edit, reorder, and delete pins in settings
- **Synced settings** — pins and preferences follow you across devices
- Dark theme, 7 default apps included

## Install

### From a release (no build required)

1. Download **browser-sidebar-v*.zip** from [GitHub Releases](https://github.com/bryanChatsirichai/chrome_operaGX_sidebar_extension/releases/latest)
2. Extract the ZIP (e.g. to `Downloads\browser-sidebar`)
3. Open Chrome and go to `chrome://extensions`
4. Enable **Developer mode** (top right)
5. Click **Load unpacked** and select the extracted folder (the one containing `manifest.json`)
6. Visit any website — the icon strip appears on the left

> **Updating an existing install:** after replacing the folder and reloading the extension, new default pins and embed improvements apply after **Settings → Reset to defaults**.

### From source

Requires **Node.js 20+**.

```bash
npm install
npm run build
```

Then **Load unpacked** from the `dist/` folder at `chrome://extensions`.

## Usage

| Action | How |
|--------|-----|
| Open a pinned app | Click its icon in the strip |
| Switch between recently used apps | Click their icons — warm panels reopen instantly |
| Close the panel | Click the same icon again, the ✕ in the panel header, or anywhere on the page |
| Hide / show the sidebar | Click the extension's toolbar icon |
| Refresh an app | Click the refresh button in the panel header |
| Resize the panel | Drag the handle on its right edge, or use the width slider in settings |
| Open settings | Click the gear icon at the bottom of the strip |
| Pin the current website | Settings → **Pin current page** (or **+ Add website** to pre-fill the form) |
| Edit, reorder, or delete pins | Settings — drag to reorder |

## Troubleshooting

| Problem | Fix |
|---------|-----|
| A site shows "This site could not load in the panel" | The panel tried and the site refused to be embedded at the app level. Use **Open in new tab**, or **Repair & retry** if cached service-worker state is the culprit. |
| A pinned site suddenly shows "refused to connect" | Use **Repair & retry** in the fallback view — this clears the cached state that's blocking the embed. |
| The extension isn't on a page | Content scripts can't run on `chrome://` pages or the Web Store. |
| Panel asks me to sign in repeatedly | The embed uses your normal browser session; make sure third-party cookies aren't blocked in Chrome settings. |
| Something looks off after updating the extension | Reload the extension at `chrome://extensions`, then refresh open tabs. |

## Why some sites normally fail

Browsers with native sidebars render apps in a real tab, where nothing can block them. An extension can't do that, so browser-sidebar embeds sites in an iframe — a context many sites actively block with response headers, cookie rules, and framing checks. The extension works around all of those layers automatically, which is why sites like Twitch, X, and Messenger load in the panel even though they normally refuse iframes everywhere else.

The rare exceptions are sites that detect framing from inside their own JavaScript (mainly OAuth/sign-in pages like Google or Microsoft accounts) — those can't be spoofed and fall back to the in-panel message with an **Open in new tab** button.

For the full technical breakdown — the five-layer embed bypass, verification pipeline, and debugging — see [docs/IMPLEMENTATION.md](docs/IMPLEMENTATION.md).

## Limitations

- **In-page overlay, not browser chrome.** Chrome extensions cannot dock a real panel beside the page; this overlays the page viewport and shifts content with CSS.
- **A few sites still can't embed** (mainly OAuth/sign-in flows) — they get the in-panel fallback view.
- **Chrome only**, Chrome 114+ (Manifest V3).
- **Aggressive page layouts** may not shift cleanly when the panel opens.

## Development

```bash
npm install
npm run dev       # watch build
npm run build     # production build to dist/
npm run typecheck
```

After editing source files, reload the extension at `chrome://extensions` (load unpacked from `dist/`).

Architecture, the embed-bypass pipeline, message protocol, and debugging guides live in [docs/IMPLEMENTATION.md](docs/IMPLEMENTATION.md). Release procedure lives in [docs/RELEASE.md](docs/RELEASE.md).

## License

MIT
