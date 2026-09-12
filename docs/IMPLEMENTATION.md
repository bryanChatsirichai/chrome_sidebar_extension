# GX Sidebar — Implementation Guide

This document describes how the extension works so a new agent session can understand the repo without re-discovering behavior from scratch.

## Purpose

GX Sidebar is a **Chrome Manifest V3 extension** that mimics Opera GX’s sidebar on normal web pages. It is **not** native browser chrome — it injects UI into page viewports and shifts page content with CSS margins.

**Primary UX:**
1. A fixed **48px icon strip** on the left of every `http(s)` page (hideable via toolbar icon).
2. An expandable **in-page panel** (300–600px) that loads pinned sites in an `<iframe>`. The panel is tried **first for every pin** — the background service worker strips iframe-blocking response headers (`X-Frame-Options`, CSP `frame-ancestors`) for pinned domains via `declarativeNetRequest`.
3. If a site still can't render in the panel (rare — app-level JS/OAuth anti-framing checks that don't rely on headers), the runtime iframe-verification layer detects the failure and falls back to a **companion popup window** beside the main browser window.
4. **Inline settings** (gear icon) to add/edit/remove/reorder pins, adjust panel width, and configure the companion window.

---

## Architecture

```mermaid
flowchart TB
  subgraph pages [Main browser tabs]
    MAIN[content/main.tsx]
    SA[SidebarApp.tsx + components]
    PSC[page-shift.module.scss]
    MAIN --> SA
    SA --> PSC
  end

  subgraph sw [background.ts service worker]
    BG[Message router]
    ST[lib/storage.ts]
    EB[lib/embed-bypass.ts]
    CP[lib/companion.ts]
  end

  subgraph companion [Companion popup window]
    CW[Full site tab - NO sidebar]
  end

  subgraph options [Options page]
    POP[popup/PopupApp.tsx]
  end

  SA -->|chrome.runtime.sendMessage| BG
  BG --> EB
  BG --> CP
  BG --> ST
  CP -->|chrome.windows.create / tabs.update| CW
  POP -->|broadcastPinsUpdated| BG
  BG -->|pinsUpdated / setSidebarHidden| SA
```

**Stack:** TypeScript, React 19, SCSS modules, Vite + `@crxjs/vite-plugin`. Content script mounts a React tree inside a closed Shadow DOM.

### Why not true Opera GX?

Opera GX loads sidebar apps in **native browser webviews** (top-level browsing contexts), which are never subject to `X-Frame-Options` / CSP `frame-ancestors` — those headers only govern embedding inside an `<iframe>`. Chrome extensions can only:
- Inject into pages (`content_scripts`)
- Open tabs/windows (`chrome.tabs`, `chrome.windows`)
- Rewrite network response headers for requests they have host permission for (`declarativeNetRequest`)

There's no extension API to create a real top-level browsing context docked beside the page like Opera GX does, so this extension uses an `<iframe>` inside the injected sidebar. Sites like X, Instagram, and Discord send `X-Frame-Options` / CSP `frame-ancestors` headers specifically to block that kind of iframe embedding.

**The fix (`lib/embed-bypass.ts`):** since the extension already has `<all_urls>` host permission, it uses `declarativeNetRequest` to strip those response headers for `sub_frame` requests to pinned domains before they reach the renderer. The remaining gap: a handful of sites (mainly OAuth/sign-in flows) also refuse framing via JavaScript or server-side checks unrelated to response headers — those still fall back to the companion popup window.

---

## File map

| Path | Role |
|------|------|
| `manifest.json` | MV3 config; `@crxjs/vite-plugin` builds to `dist/` |
| `src/background.ts` | Service worker: messaging hub, embed-bypass rule sync, companion routing, sidebar hide toggle |
| `src/content/main.tsx` | Entry: bootstrap, shadow DOM mount, React root |
| `src/content/SidebarApp.tsx` | Main UI state: pins, panel, iframe verification, settings |
| `src/content/components/IconStrip.tsx` | Pin buttons + gear |
| `src/content/components/AppPanel.tsx` | Iframe panel, loading/fallback views, resize handle |
| `src/content/components/SettingsPanel.tsx` | Inline settings UI |
| `src/content/sidebarUtils.ts` | Page-shift injection, layout classes, storage load, companion check |
| `src/content/keyboardIsolation.ts` | Prevents host-page shortcuts from swallowing sidebar input |
| `src/content/sidebar.module.scss` | Shadow DOM styles (Opera GX dark theme) |
| `src/content/page-shift.module.scss` | Shifts `html` margin when strip/panel open |
| `src/lib/defaults.ts` | Constants, default pins, companion layout helpers |
| `src/lib/storage.ts` | `chrome.storage.sync` read/write helpers |
| `src/lib/companion.ts` | Single companion window lifecycle, positioning, anchor tracking |
| `src/lib/embed-bypass.ts` | Syncs a `declarativeNetRequest` session rule that strips `X-Frame-Options` / CSP headers for pinned domains (`sub_frame` requests only) |
| `src/lib/pin-utils.ts` | Icon URL resolution, URL parsing, pin reindexing, `getCurrentPagePinDefaults()` |
| `src/lib/types.ts` | Shared TypeScript interfaces |
| `src/popup/*` | Full-page options UI (`options_ui`); mirrors inline settings |
| `icons/apps/*` | Default pin SVG icons |

**Build:** `npm run build` → `dist/`. Load unpacked from `dist/`.

---

## Permissions

```json
["storage", "scripting", "tabs", "windows", "system.display", "declarativeNetRequestWithHostAccess"]
```

- `storage` — pins/settings in `chrome.storage.sync`; companion state in `chrome.storage.session`
- `scripting` — fallback inject when toolbar click hits a tab without content script
- `tabs` / `windows` — companion window create/navigate/close; sidebar hide broadcast
- `system.display` — screen-edge positioning and work-area clamping for companion window
- `declarativeNetRequestWithHostAccess` — lets the background worker strip `X-Frame-Options` / CSP response headers for pinned domains (`lib/embed-bypass.ts`); requires the existing `<all_urls>` host permission
- `host_permissions: ["<all_urls>"]` — content scripts on all normal pages; also backs the header-stripping rule above

---

## Data model

### Pin (stored in `chrome.storage.sync`)

```ts
{
  id: string,        // e.g. "discord" or "custom-1734567890"
  name: string,
  url: string,       // full https URL
  iconUrl: string,   // extension-relative ("icons/apps/x.svg") or absolute http(s)
  order: number      // strip sort order
}
```

### Settings

```ts
{
  panelWidth: 400,
  theme: 'dark',
  companionWidth: 400,
  companionHeightMode: 'match' | 'fixed',
  companionHeight: 800,
  companionPosition: 'right' | 'left' | 'screen-right' | 'screen-left'
}
```

### Storage keys

| Key | Location | Purpose |
|-----|----------|---------|
| `pins` | sync | Ordered list of pins |
| `settings` | sync | Panel width, theme, companion layout |
| `lastActivePinId` | sync | Last clicked pin |
| `sidebarHidden` | sync | Whether icon strip is hidden on all pages |
| `companion` | session | `{ windowId, pinId, anchorWindowId, layout }` |

### Defaults

Defined in `src/lib/defaults.ts`:
- `GX_DEFAULTS.DEFAULT_PINS` — 11 default apps (Discord, WhatsApp, Telegram, Twitch, Spotify, X, Instagram, Messenger, ChatGPT, Claude, Example)
- `GX_DEFAULTS.BLOCKED_DOMAINS` — known iframe blockers (fast-path before header fetch); includes Twitch, ChatGPT, Claude, Spotify, YouTube, etc.
- `GX_DEFAULTS.IFRAME_LOAD_TIMEOUT_MS` — 5000ms fallback timer
- `GX_DEFAULTS.COMPANION_*` — min/max width/height, position and height-mode enums

---

## UI structure (content script)

Injected once per top-level frame into `#gx-sidebar-host` with **closed Shadow DOM**. React renders inside the shadow root.

```
.sidebar-root
├── IconStrip            ← pin buttons + gear (settings)
├── AppPanel             ← iframe panel (opens with .open)
│   ├── .panel-header
│   └── .panel-body (iframe | loading | fallback)
└── SettingsPanel        ← inline settings (opens with .open)
    └── pinned list, pin current page, add/edit form, width, companion settings, reset
```

**Page margin** (`page-shift.module.scss`, applied via `applyLayoutClasses()` in `sidebarUtils.ts`):
- `html.gx-sidebar-strip-visible` → `margin-left: 48px`
- `html.gx-sidebar-open` → `margin-left: 48px + panelWidth`
- `html.gx-sidebar-hidden` → `margin-left: 0` (strip hidden via toolbar)

CSS variables `--gx-strip-width` and `--gx-panel-width` are set on `document.documentElement` by `setCssVariables()`.

### Companion window exclusion

On bootstrap (`main.tsx`), `isCompanionContext()` calls `getSidebarContext`. If the tab’s window is the companion window, **sidebar injection is skipped entirely**. This prevents:
- Sidebar appearing in the companion window
- Double companion opens (companion page triggering another companion)

Detection: `gxIsCompanionWindowAsync()` in `lib/companion.ts` checks in-memory state + `chrome.storage.session`.

### Keyboard isolation

`keyboardIsolation.ts` stops host-page keyboard shortcuts from intercepting input inside sidebar form fields (settings add/edit form).

---

## Core user flows

### 1. Click a pin (`handlePinClick` in `SidebarApp.tsx`)

```
Click pin
  → close settings if open
  → if same pin + panel open → closePanel()
  → if same pin + companion open (panel closed) → closeCompanion()
  → set activePinId, save last active pin
  → setPanelOpen(true), openPanelForPin(pin)   ← always try the panel first
```

**Design goal (Opera GX parity):** the in-page panel opens for *every* pin. `lib/embed-bypass.ts` strips blocking response headers for pinned domains in the background, so the iframe attempt is expected to succeed for the vast majority of sites. Only a genuine runtime failure triggers the companion window.

### 2. Open panel (`openPanelForPin`)

Called directly on every pin click — no preflight gate.

1. Reset embed-failure guards (`embedFailureHandled`, `embedFailureInFlight`, verify generation).
2. Send `closeCompanion` immediately — only one side view (panel or companion) at a time.
3. Show loading spinner and set `iframe.src = pin.url`.
4. Start **5s timeout** → `handleEmbedFailure` if load/verification still failing (runtime fallback).
5. On iframe `load` → `startIframeVerification`.

### 2b. Open companion directly (`openCompanionDirectly`)

Used when the panel's runtime iframe verification decides the site truly can't render, and for the manual “Open companion panel” fallback button.

1. Close any open in-page panel quietly (no loading flash).
2. Call `openCompanionForPin(pin)` — opens or navigates the single companion window.
3. If companion fails, open the panel with `showFallbackUI` so the user can retry manually.

### 3. Iframe embed detection

Embedding is handled in **two layers**:

#### Layer A — Network-level header bypass (`lib/embed-bypass.ts`)

The background service worker keeps a single `declarativeNetRequest` **session rule** in sync with the current pin list. For `sub_frame` (iframe) requests to pinned hostnames, the rule removes:
- `X-Frame-Options`
- `Content-Security-Policy` (carries `frame-ancestors`)
- `Content-Security-Policy-Report-Only`
- `X-Content-Security-Policy` (legacy)

Re-synced on `onInstalled`, `onStartup`, and whenever pins change via `broadcastPinsUpdated` / `resetStorage`. Only `sub_frame` requests are affected — normal top-level navigation is untouched.

#### Layer B — Runtime iframe verification (`verifyIframeEmbed`)

Polls after load with a **generation counter** (`iframeVerifyGeneration`) so stale timers from previous loads/retries are ignored. This is the safety net for sites that still refuse to render even without blocking headers (JS-based or server-side anti-framing, mostly OAuth/sign-in flows).

Detection paths:
- `chrome-error:` in iframe location (when readable)
- Error text in iframe document (`refused to connect`, `content is blocked`, etc.)
- **`about:blank` stuck** after max retries → treat as failure (no infinite loading)
- Cross-origin opaque frame (`location.href` throws → `null`) → treated as success via `finalizeIframeSuccess` (expected for a genuine cross-origin load)

**Success** → `showIframeLoaded()`:
- Hides loading, shows iframe
- Sends `closeCompanion` again if still open (idempotent; primary close happens in `openPanelForPin`)

**Runtime failure** (panel already open) → `handleEmbedFailure()` (single-flight guarded):
- Opens/navigates companion via `openCompanionForPin({ closePanelOnOpen: true })`
- Closes in-page panel on success
- Shows manual fallback UI in panel if companion also fails

### 4. Companion window (`lib/companion.ts`)

**Only one side view at a time:** the in-page iframe panel and the companion popup are mutually exclusive. `openPanelForPin` closes the companion as soon as the panel opens; `openCompanionDirectly` closes the panel before opening the companion.

**Only one companion window** at a time. Concurrency guards:
- `companionOperation` — dedupe concurrent `openCompanion` messages
- `companionCreateInProgress` — wait loop during window creation
- `embedFailureInFlight` / `embedFailureHandled` — dedupe in content script

**Open flow** (`gxOpenOrNavigateCompanion`):
```
If companion exists → navigate its tab to new URL, apply layout bounds
Else → chrome.windows.create({ type: 'popup', url, ...bounds })
       Position from settings: right/left of anchor, or screen-right/screen-left
       Persist windowId + layout to session storage immediately
```

**Layout options** (from settings, normalized by `gxGetCompanionLayoutFromSettings`):
- **Width:** 300–900px
- **Height mode:** `match` (anchor window height) or `fixed` (400–1200px)
- **Position:** `right` / `left` (tracks anchor on move/resize) or `screen-right` / `screen-left` (fixed to work area)

**When user opens embeddable pin in main browser** (e.g. example.com):
- `openPanelForPin` sends `closeCompanion` immediately, then loads the iframe in the panel

**When user opens a pin that fails at runtime while companion already shows another site**:
- `handleEmbedFailure` navigates companion tab to new URL (no second window)

**When user opens a pin that fails at runtime while panel is open**:
- `handleEmbedFailure` closes the panel and opens/navigates companion

**When main browser window closes**:
- Companion window is also closed (`windows.onRemoved` listener)

**When anchor window moves/resizes** (position `right` or `left`):
- Companion repositions via debounced `onBoundsChanged` listener

**Companion window does NOT show the sidebar** (see exclusion above).

**Navigation from within companion:** If `openCompanion` is sent from a tab already in the companion window, `gxNavigateWithinCompanionWindow` updates the tab in place.

### 5. Settings (gear icon)

Opens `SettingsPanel` (same width as app panel). Closes app panel when opened.

Features:
- **Pin current page** — preview card with one-click add or “Edit before adding” (uses `getCurrentPagePinDefaults()` for title, URL, favicon)
- **+ Add website** — scrolls to add form and pre-fills current page
- Add or **edit** pin manually: name, URL, optional icon URL
- List pins with delete
- **Drag-and-drop reorder** (HTML5 DnD, updates `order`, calls `saveAndBroadcast`)
- Panel width slider
- **Companion window** settings: width, height mode, fixed height, initial position
- Reset to defaults

Icon strip footer has **gear (settings) only** — no separate “+” button on the strip.

`saveAndBroadcast()` writes to `chrome.storage.sync` and sends `broadcastPinsUpdated` → all tabs re-render strip; background also calls `gxUpdateCompanionLayout` if companion is open.

### 6. Toolbar icon click (`background.ts`)

Toggles `sidebarHidden` in sync storage and broadcasts `setSidebarHidden` to all tabs. On failure (content script not loaded), fallback `executeScript` injects the content script.

**Guard:** `isInjectableUrl()` — skips `chrome://`, `about:`, etc.

---

## Message protocol

| Action | Direction | Handler | Purpose |
|--------|-----------|---------|---------|
| `getSidebarContext` | content → background | `background.ts` | Returns `{ isCompanionWindow }` |
| `openCompanion` | content → background | `background.ts` → `companion.ts` | Open or navigate single companion |
| `closeCompanion` | content → background | `background.ts` → `companion.ts` | Close companion when panel opens or iframe succeeds (skipped if sender is companion) |
| `saveLastActivePin` | content → background | `storage.ts` | Persist active pin id |
| `broadcastPinsUpdated` | popup/settings → background | `background.ts` | Sync pins to all tabs + resize companion + re-sync embed-bypass rules |
| `pinsUpdated` | background → content | `SidebarApp.tsx` | Re-render strip/settings |
| `setSidebarHidden` | background → content | `SidebarApp.tsx` | Show/hide icon strip |
| `companionClosed` | background → content | `SidebarApp.tsx` | Clear active pin highlight |
| `getStorageData` | popup → background | `storage.ts` | Load pins/settings |
| `resetStorage` | popup/settings → background | `storage.ts` | Restore defaults + re-sync embed-bypass rules |
| `togglePanel` | background → content | `SidebarApp.tsx` | Legacy: open/close active panel |
| `getState` | popup → content | `SidebarApp.tsx` | Return panel/sidebar state |
| `openTab` | content → background | `background.ts` | Open URL in new tab |

All async handlers return `true` from `onMessage` and call `sendResponse` in a promise/IIFE.

---

## Key modules reference

### `content/SidebarApp.tsx`

| Concern | Purpose |
|---------|---------|
| `handlePinClick` | Always opens the in-page panel for the clicked pin |
| `openCompanionDirectly` | Open companion (runtime-failure fallback + manual button) |
| `openPanelForPin` | Close companion, then load the iframe |
| `verifyIframeEmbed` | Poll-based runtime embed detection (safety net after header bypass) |
| `finalizeIframeSuccess` | Confirms pin/generation are current, then shows the iframe |
| `handleEmbedFailure` | Runtime fallback when panel is already open |
| `quickPinCurrentPage` | One-click add of current page tab |
| `showIframeLoaded` | Success path; redundant `closeCompanion` if still open |
| `openCompanionForPin` | Send `openCompanion` with current companion settings |
| `saveAndBroadcast` | Persist + sync all tabs |
| Message listener | Handles `pinsUpdated`, `setSidebarHidden`, `companionClosed`, etc. |

### `content/sidebarUtils.ts`

| Function | Purpose |
|----------|---------|
| `isCompanionContext()` | Skip injection in companion window |
| `loadSidebarStorage()` | Initial pins/settings/hidden state |
| `applyLayoutClasses()` | Toggle `html` margin classes |
| `setCssVariables()` | Set `--gx-strip-width`, `--gx-panel-width` |
| `injectPageShiftStyles()` | Inject global page-shift CSS once |

### `lib/embed-bypass.ts`

| Function | Purpose |
|----------|---------|
| `gxSyncEmbedBypassRules()` | Recomputes pin hostnames and atomically replaces the single `declarativeNetRequest` session rule that strips iframe-blocking response headers |

### `lib/companion.ts`

| Function | Purpose |
|----------|---------|
| `gxOpenOrNavigateCompanion()` | Mutex-wrapped open or navigate |
| `gxNavigateCompanionTab()` | `tabs.update` in existing companion |
| `gxNavigateWithinCompanionWindow()` | In-place nav when request from companion tab |
| `gxCloseCompanion()` | Remove window + clear state |
| `gxIsCompanionWindowAsync()` | Detect companion context |
| `gxGetCompanionBounds()` | Position popup from layout + anchor/screen |
| `gxUpdateCompanionLayout()` | Apply new settings to open companion |

### `background.ts`

| Function | Purpose |
|----------|---------|
| `broadcastToAllTabs()` | Send message to all injectable tabs |
| `isInjectableUrl()` | http/https check |

---

## Concurrency and race conditions (important for debugging)

| Problem | Mitigation |
|---------|------------|
| Multiple companion windows | `companionOperation`, `companionCreateInProgress`, session persistence |
| Multiple `handleEmbedFailure` calls | `embedFailureHandled`, `embedFailureInFlight` |
| Stale iframe verify timers | `iframeVerifyGeneration` incremented on each new load |
| Cross-origin opaque frame mistaken for failure | `location.href` throwing is treated as success (expected for cross-origin load) |
| Edited pin's embed-bypass rule not synced yet | `handleSavePin` reloads panel only after `await saveAndBroadcast(...)` resolves |
| Runtime embed failure after header bypass | `handleEmbedFailure` (timeout/onerror/pattern match) — only remaining companion trigger |
| Panel + companion both open | `openPanelForPin` closes companion immediately; `openCompanionDirectly` closes panel first |
| Companion page opening another companion | Sidebar not injected in companion window |
| MV3 service worker sleep | Pass `url` directly to `chrome.windows.create` (not create-then-navigate) |
| Duplicate create retries | Max 2 attempts in `gxCreateCompanionWindow` (positioned, then plain) |
| Companion context race on load | `isCompanionContext()` retries up to 3 times |

---

## Platform limitations (do not try to “fix” without architectural change)

1. **A handful of sites still can't be embedded** (mainly OAuth/sign-in flows) — they detect framing via JavaScript or server-side checks, not just response headers. These fall back to the companion window.
2. **Cannot add real sidebar to browser chrome** — extension API limit.
3. **Companion is a separate popup window** — not docked native panel like Opera GX.
4. **Content scripts don’t run on `chrome://` pages** — toolbar toggle guarded.
5. **`chrome.storage.sync` merge** — existing users keep old pins until reset; new default pins only apply on first install or reset.
6. **Third-party cookie/session quirks** — the iframe is a third-party context; some sites may repeatedly ask to log in even once framing succeeds.

---

## Testing notes

| Pin | Expected behavior |
|-----|-------------------|
| **Example** (`example.com`) | Companion closes immediately → panel opens with iframe |
| **Twitch / Discord / X / Instagram / ChatGPT / Claude** | Panel opens and loads iframe — embed-bypass strips blocking headers. Verify via service worker console that `gxSyncEmbedBypassRules` ran. |
| OAuth/sign-in pages (e.g. `accounts.google.com`) | Panel opens, then falls back to companion after runtime detection — expected |
| Click same pin (companion open) | Companion closes, pin deselected |
| Switch pins while companion open | Same companion navigates, no second window |
| Open Example while companion open | Companion closes as panel opens; iframe loads in panel |
| **Settings → Pin current page** | Adds current tab URL/title/favicon to strip |
| Toolbar click | Hides/shows strip; page margin resets when hidden |
| Companion position `right` | Follows main window when moved/resized |

Reload extension after manifest/permission changes at `chrome://extensions`.

Service worker logs: click **Service worker** link on extension card. Look for `[GX Sidebar]` prefixed messages.

---

## Extending the codebase

### Add a default pin

Edit `GX_DEFAULTS.DEFAULT_PINS` in `src/lib/defaults.ts` and add icon under `icons/apps/`. Existing installs need **Reset to defaults** in settings.

### Add more headers to the bypass

Edit `HEADERS_TO_STRIP` in `src/lib/embed-bypass.ts` if a site uses another header to block framing. Keep the list conservative.

### Debug a site still falling back to the companion window

1. DevTools → Network → filter by pin domain → check whether `X-Frame-Options` / CSP are gone on the sub-frame document request. If still present, check service worker console for `gxSyncEmbedBypassRules` errors.
2. If headers are gone but panel still falls back, the site is doing JS/server-side anti-framing — expected companion fallback.
3. If fallback happens instantly, check `EMBED_BLOCKED_PATTERN` in `SidebarApp.tsx` isn't matching non-error page text (false positive).

### Change companion position defaults

Edit `DEFAULT_SETTINGS.companionPosition` in `src/lib/defaults.ts`, or adjust `gxResolveCompanionPosition()` in `src/lib/companion.ts`.

### Add new message action

1. Handle in `background.ts` `onMessage` (return `true` if async).
2. Call from `SidebarApp.tsx` via `chrome.runtime.sendMessage`, or listen in the content script message handler.
3. Document in this file’s message protocol table.

---

## Related docs

- `README.md` — user-facing install/usage
- `src/popup/` — full-page options UI; inline settings (`SettingsPanel`) is the primary in-page UX

---

*Last updated to reflect: `declarativeNetRequest`-based embed bypass (`lib/embed-bypass.ts`) replacing header-preflight/domain-blocklist gate — in-page panel opens for every pin; companion window is runtime-failure fallback only.*
