# browser-sidebar

A Chrome extension that injects a native-browser-style sidebar into web pages: a vertical icon strip on the left with an expandable panel for pinned web apps.

## Features

- Persistent 48px icon strip on the left edge of every page (hideable via toolbar icon)
- Expandable panel (300–1000px, resizable) that always tries to load pinned sites in an iframe first — like a native browser sidebar
- **Automatic iframe-block bypass** — a four-layer pipeline (header stripping, Fetch Metadata spoofing, cookie `SameSite` relaxation, runtime verification) makes sites that normally refuse to be framed (Discord, Twitch, X, Instagram, ChatGPT, Claude, Messenger, etc.) load directly in the panel — see [How blocked sites work](#how-blocked-sites-work)
- **Seamless resizing** — drag the panel edge or scrub the settings slider; the host page tracks the cursor live while the embedded site reflows only once on release, so heavy apps (ChatGPT, Messenger) never jank or crash the tab during the gesture
- **In-panel fallback view** — if a site still can't render in the panel after the panel actually tries (e.g. app-level anti-framing on OAuth/sign-in pages), the panel shows an icon, the pin name, a "This site could not load in the panel." message, and an **Open in new tab** button
- 11 default apps: Discord, WhatsApp, Telegram, Twitch, Spotify, X, Instagram, Messenger, ChatGPT, Claude, and Example (iframe test)
- **Pin current page** from settings — one-click add with title, URL, and favicon
- Add and edit custom pins with name, URL, and optional icon
- Drag-to-reorder pins in settings
- Dark theme
- Settings sync across devices via `chrome.storage.sync`

## Install

[![Release](https://img.shields.io/github/v/release/bryanChatsirichai/chrome_operaGX_sidebar_extension?label=download)](https://github.com/bryanChatsirichai/chrome_operaGX_sidebar_extension/releases/latest)

### For users (no build required)

1. Download **browser-sidebar-v*.zip** from [GitHub Releases](https://github.com/bryanChatsirichai/chrome_operaGX_sidebar_extension/releases/latest)
2. Extract the ZIP (e.g. to `Downloads\browser-sidebar`)
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
| Resize panel | Drag the handle on the right edge of the panel, or use the width slider in settings — the embedded app reflows once on release, so the gesture stays smooth even for heavy sites |
| Settings | Click the gear icon at the bottom of the strip, or right-click the extension → Options |
| Pin current website | Settings → **Pin current page** (or **+ Add website** to pre-fill the form) |

## How blocked sites work

Many sites refuse to load inside iframes. Browsers with native sidebars don't hit this at all because they render sites in a real browser tab, not a same-page `<iframe>`. A Chrome extension has no API to do that, so this extension layers four workarounds to reach the same result:

1. **Header bypass** (`declarativeNetRequest`, rule 1) — for iframe responses from pinned domains, strips `X-Frame-Options`, CSP `frame-ancestors` (including `Content-Security-Policy-Report-Only` / `X-Content-Security-Policy`), and `Cross-Origin-Embedder-Policy`, *and* injects `Cross-Origin-Resource-Policy: cross-origin` so embeds also work on host pages that enforce COEP `require-corp`. All before Chrome ever renders the frame.
2. **Fetch Metadata spoofing** (rule 2) — rewrites the iframe's request headers to look like a top-level address-bar visit (`Sec-Fetch-Dest: document`, `Sec-Fetch-Mode: navigate`, `Sec-Fetch-Site: none`, `Sec-Fetch-User: ?1`, no `Referer`). This defeats server-side framing checks that never look at response headers — e.g. Messenger serving "Your Request Couldn't be Processed" (error 1357005) to anything arriving with `Sec-Fetch-Dest: iframe`.
3. **Cookie `SameSite` relaxation** — `SameSite=Lax/Strict` cookies aren't sent inside cross-site iframes, which would log you out of the embedded site. The background re-writes pinned-site cookies as `SameSite=None` via the `chrome.cookies` API and keeps re-flipping them when the site re-issues restrictive ones.
4. **Runtime verification** — each navigation mounts a fresh iframe and verifies it actually loaded (15s timeout, about:blank stall polling, strict error-page matching, and a post-load watchdog). A genuine failure lands on the in-panel fallback view with an **Open in new tab** button.

With all four layers active, sites like **Example.com, Twitch, Discord, ChatGPT, Claude, X, Instagram, and Messenger** load directly in the panel — the in-panel fallback view is the exception (mainly JavaScript/server-side anti-framing on OAuth sign-in flows), not the default.

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
    sidebar.module.scss    Dark theme (shadow DOM)
    page-shift.module.scss Page margin shift styles
  popup/
    popup.html/main.tsx    Options page entry
    PopupApp.tsx           Full-page settings UI
    popup.module.scss      Options page styles
  lib/
    defaults.ts            Default pins, constants
    embed-bypass.ts        declarativeNetRequest rule sync (header strip + Fetch Metadata spoofing)
    cookie-auth.ts          SameSite cookie relaxation + cookies.onChanged watcher
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

- **In-page overlay, not browser chrome.** Chrome extensions cannot modify the area left of the address bar the way native browser sidebars do. This extension overlays the page viewport and shifts content with a CSS margin.
- **A few sites still can't embed.** Discord, Twitch, Spotify, ChatGPT, Claude, WhatsApp, X, Instagram, and similar sites *used to* refuse iframe embedding, but now load directly in the panel thanks to the four-layer bypass (header stripping, Fetch Metadata spoofing, cookie relaxation). Sites that detect framing via JavaScript or server-side checks that can't be spoofed (mainly OAuth/sign-in flows like Google/Microsoft accounts) still can't be fixed this way — the panel shows an in-panel fallback view with an **Open in new tab** button instead.
- **Shared browser session.** The iframe panel uses your normal browser cookies/session — pinned-site cookies are re-written as `SameSite=None` so they work inside the cross-site iframe. Blocking third-party cookies in Chrome settings breaks iframe cookies regardless, and third-party iframe `localStorage`/`IndexedDB` stays storage-partitioned.
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
