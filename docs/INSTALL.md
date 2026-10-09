# Install browser-sidebar (no build required)

Download a pre-built ZIP from [GitHub Releases](https://github.com/bryanChatsirichai/chrome_operaGX_sidebar_extension/releases/latest) and load it in Chrome. You do not need git, Node.js, or npm.

## Steps

1. Open [Releases](https://github.com/bryanChatsirichai/chrome_operaGX_sidebar_extension/releases/latest) and download `browser-sidebar-vX.Y.Z.zip`.
2. Extract the ZIP (right-click → **Extract All** on Windows).
3. Open Chrome and go to `chrome://extensions`.
4. Turn on **Developer mode** (toggle in the top-right corner).
5. Click **Load unpacked**.
6. Select the **extracted folder** — the one that contains `manifest.json` inside it.
7. Visit any website. The sidebar icon strip appears on the left edge of the page.

## Updating

1. Download the newer ZIP from Releases.
2. Extract it to a new folder (or replace the old folder).
3. Go to `chrome://extensions` and click the **Reload** button on browser-sidebar, or remove the old install and **Load unpacked** again from the new folder.

## Troubleshooting

- **Chrome will not load the ZIP directly** — you must extract it first.
- **"Manifest file is missing or unreadable"** — you selected the wrong folder. Choose the inner folder that contains `manifest.json`, not the parent download folder.
- **Developer mode required** — unpacked extensions always need Developer mode enabled in Chrome.
