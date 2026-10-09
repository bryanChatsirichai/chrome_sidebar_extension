# GX Sidebar — Opera GX-Style Chrome Extension

A Chrome extension that injects an Opera GX-style sidebar into web pages: a vertical icon strip on the left with an expandable panel for pinned web apps.

## Features

- Persistent 48px icon strip on the left edge of every page (hideable via toolbar icon)
- Expandable panel (300–600px, resizable) that always tries to load pinned sites in an iframe first — like Opera GX's native sidebar
- **Automatic iframe-block bypass** — strips `X-Frame-Options` / CSP `frame-ancestors` response headers for pinned domains via `declarativeNetRequest`, so sites that normally refuse to be framed (Discord, Twitch, X, Instagram, ChatGPT, Claude, etc.) load directly in the panel
- **In-panel fallback view** — if a site still can't render in the panel after the panel actually tries (e.g. app-level anti-framing on OAuth/sign-in pages), the panel shows an icon, the pin name, a "This site could not load in the panel." message, and an **Open in new tab** button
- 11 default apps: Discord, WhatsApp, Telegram, Twitch, Spotify, X, Instagram, Messenger, ChatGPT, Claude, and Example (iframe test)
- **Pin current page** from settings — one-click add with title, URL, and favicon
- Add and edit custom pins with name, URL, and optional icon
- Drag-to-reorder pins in settings
- Dark Opera GX-inspired theme
- Settings sync across devices via `chrome.storage.sync`

## Install

[![Release](https://img.shields.io/github/v/release/bryanChatsirichai/chrome_operaGX_sidebar_extension?label=download)](https://github.com/bryanChatsirichai/chrome_operaGX_sidebar_extension/releases/latest)

### For users (no build required)

1. Download **gx-sidebar-v*.zip** from [GitHub Releases](https://github.com/bryanChatsirichai/chrome_operaGX_sidebar_extension/releases/latest)
2. Extract the ZIP (e.g. to `Downloads\gx-sidebar`)
3. Open Chrome and go to `chrome://extensions`
4. Enable **Developer mode** (top right)
5. Click **Load unpacked** and select the extracted folder (the one containing `manifest.json`)
6. Visit any website — the icon strip appears on the left

> **Existing installs:** New default pins and embed-bypass behavior improvements apply after **Settings → Reset to defaults**, or on first install. Reload the extension after updating.

### For developers (build from source)

```bash
npm install
npm run build
```

Then **Load unpacked** from the `dist/` folder at `chrome://extensions`.

### Publishing a release (maintainers)

See [docs/RELEASE.md](docs/RELEASE.md) — bump `manifest.json` version, commit, then `git tag v0.1.x` and `git push origin v0.1.x`. GitHub Actions builds the ZIP and attaches it to the release automatically.

## Usage

| Action | How |
|--------|-----|
| Open a pinned app | Click its icon — sidebar panel opens and loads the site (headers that would normally block framing are stripped automatically) |
| Open a site that still refuses to embed | Click its icon — panel tries first, then shows an in-panel fallback view with an **Open in new tab** button if it truly can't render |
| Close panel | Click the same icon again, or the ✕ button in the panel header |
| Hide/show sidebar | Click the extension toolbar icon |
| Refresh app | Click the refresh button in the panel header |
| Resize panel | Drag the handle on the right edge of the panel, or use the width slider in settings |
| Settings | Click the gear icon at the bottom of the strip, or right-click the extension → Options |
| Pin current website | Settings → **Pin current page** (or **+ Add website** to pre-fill the form) |

## How blocked sites work

Many sites refuse to load inside iframes by sending `X-Frame-Options` / CSP `frame-ancestors` response headers. Opera GX's native sidebar doesn't hit this at all because it renders sites in a real browser tab, not a same-page `<iframe>`. A Chrome extension has no API to do that, so this extension takes a different route to the same result:

1. **Header bypass** — the background service worker keeps a `declarativeNetRequest` rule in sync with your pinned sites. For iframe requests to those domains, it strips the response headers that would normally block framing, *before* Chrome ever renders the frame.
2. **Panel opens for every pin** — since the blocking headers are gone, the in-page sidebar panel can now load almost every site directly.
3. **In-panel fallback view** — a very small number of sites (mainly Google/Microsoft-style OAuth sign-in pages) also detect framing via JavaScript or server-side checks that don't depend on headers. Only those genuinely can't load in the panel, and only after the panel actually tries. In that case the panel shows the pin icon, the pin name, a "This site could not load in the panel." message, and an **Open in new tab** button.

Sites like **Example.com** load normally in the in-page panel, as before. **Twitch, Discord, ChatGPT, X, Instagram**, and similar pins now also load directly in the panel — the in-panel fallback view is the exception now, not the default.

## Project Structure

```
manifest.json              MV3 config (source; build outputs to dist/)
src/
  background.ts            Service worker (toggle, storage, messaging, embed-bypass rule sync)
  content/
    main.tsx               Bootstrap: shadow DOM mount, React root
    SidebarApp.tsx         Main UI state and iframe logic
    sidebarUtils.ts        Page shift, layout classes, storage load
    keyboardIsolation.ts   Keyboard event isolation for settings forms
    components/
      IconStrip.tsx        Pin buttons + settings gear
      AppPanel.tsx         Iframe panel, loading/fallback views
      SettingsPanel.tsx    Inline settings (pins, pin current page, width, reset)
    sidebar.module.scss    Opera GX dark theme (shadow DOM)
    page-shift.module.scss Page margin shift styles
  popup/
    popup.html/main.tsx    Options page entry
    PopupApp.tsx           Full-page settings UI
    popup.module.scss      Options page styles
  lib/
    defaults.ts            Default pins, constants
    embed-bypass.ts        declarativeNetRequest rule sync (strips iframe-blocking headers)
    storage.ts             chrome.storage.sync helpers
    pin-utils.ts           Icon URLs, URL parsing, current-page pin defaults
    types.ts               Shared TypeScript types
icons/apps/                Default pin SVG icons (incl. chatgpt.svg, claude.svg)
dist/                      Built extension (load this in Chrome)
```

## Development

Requires **Node.js 20+**.

```bash
npm install
npm run dev    # watch build
npm run build  # production build to dist/
npm run typecheck
```

After editing source files, reload the extension at `chrome://extensions` (load unpacked from `dist/`).

## Known Limitations

- **In-page overlay, not browser chrome.** Chrome extensions cannot modify the area left of the address bar the way Opera GX does natively. This extension overlays the page viewport and shifts content with a CSS margin.
- **A few sites still can't embed.** Discord, Twitch, Spotify, ChatGPT, Claude, WhatsApp, X, Instagram, and similar sites *used to* refuse iframe embedding, but now load directly in the panel because the extension strips their blocking response headers automatically. Sites that detect framing via JavaScript or server-side checks instead of headers (mainly OAuth/sign-in flows like Google/Microsoft accounts) still can't be fixed this way — the panel shows an in-panel fallback view with an **Open in new tab** button instead.
- **Shared browser session.** The iframe panel uses your normal browser cookies/session.
- **Page layout conflicts.** Sites with aggressive full-viewport layouts may not shift cleanly when the panel opens.
- **Existing user pins.** New default pins only appear after first install or **Reset to defaults** (`chrome.storage.sync` merge behavior).
- **Chrome only.** Requires Chrome 114+ (Manifest V3). Built with TypeScript, React 19, and SCSS via Vite.

### Message Protocol

| Message | Direction | Purpose |
|---------|-----------|---------|
| `setSidebarHidden` | background → content | Hide/show icon strip via toolbar click |
| `pinsUpdated` | background → content | Re-render icon strip after settings change |
| `broadcastPinsUpdated` | popup/settings → background | Sync pins/settings to all tabs + re-sync embed-bypass rules |
| `getStorageData` | popup → background | Load pins/settings |
| `resetStorage` | popup/settings → background | Restore defaults + re-sync embed-bypass rules |
| `getState` | popup → content | Return panel/sidebar state |
| `openTab` | content → background | Open URL in new tab |

See `docs/IMPLEMENTATION.md` for full architecture, embed detection layers, and debugging notes.

## License

MIT
