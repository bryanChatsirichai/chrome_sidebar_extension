# Publishing a release

End users download a pre-built ZIP from [GitHub Releases](https://github.com/bryanChatsirichai/chrome_operaGX_sidebar_extension/releases). You do not commit `dist/` or ZIP files to git — CI builds them automatically when you push a version tag.

## One-time setup

1. Push this repo to GitHub (already done if you cloned from `origin`).
2. Ensure **Actions** are enabled: repo **Settings → Actions → General → Allow all actions**.
3. No secrets required — the workflow uses the built-in `GITHUB_TOKEN` to create releases.
4. Restrict who can push release tags — import `.github/rulesets/release-tags.json` (see [GITHUB-RULES.md](GITHUB-RULES.md)).

## Publish a new version

1. **Bump the version** in `manifest.json` (must match the tag, without the `v` prefix):
   ```json
   "version": "0.1.1"
   ```

2. **Commit and push** to `main`:
   ```bash
   git add manifest.json
   git commit -m "Release v0.1.1"
   git push
   ```

3. **Create and push a tag** on a commit that is on `main` (this triggers the build):
   ```bash
   git tag v0.1.1
   git push origin v0.1.1
   ```

4. **Wait for CI** — open the **Actions** tab on GitHub. The “Build and release extension” workflow should finish in about one minute.

5. **Verify the release** — open [Releases](https://github.com/bryanChatsirichai/chrome_operaGX_sidebar_extension/releases). You should see `browser-sidebar-v0.1.1.zip` attached.

Share this link with users:

```
https://github.com/bryanChatsirichai/chrome_operaGX_sidebar_extension/releases/latest
```

Direct download (after at least one release exists):

```
https://github.com/bryanChatsirichai/chrome_operaGX_sidebar_extension/releases/latest/download/browser-sidebar-v0.1.1.zip
```

Replace `0.1.1` with the current version, or use `/releases/latest/download/` only if you always upload a file with the same name (this workflow uses versioned filenames).

## Rebuild same version

Pushing commits to `main` alone does **not** rebuild the ZIP. The workflow only runs when you push a version tag, and it builds **the commit that tag points to** — not necessarily the latest `main`.

Use this when you fixed a bug but want to keep the same version (e.g. still `0.1.0`):

1. **Commit and push** your changes to `main` (leave `manifest.json` version unchanged):
   ```bash
   git add .
   git commit -m "Fix sidebar toggle"
   git push origin main
   ```

2. **Delete the existing tag** locally and on GitHub (replace `v0.1.0` with your tag):
   ```bash
   git tag -d v0.1.0
   git push origin :refs/tags/v0.1.0
   ```

3. **Recreate the tag** on the current commit and push it (this triggers a new build):
   ```bash
   git tag v0.1.0
   git push origin v0.1.0
   ```

4. **Wait for CI** — check the **Actions** tab. The release ZIP (`browser-sidebar-v0.1.0.zip`) is replaced on the existing **v0.1.0** release.

> **Tip:** For small fixes, bumping the patch version (`0.1.0` → `0.1.1`) is often simpler — no tag deletion, and users can tell which build is newest.

**Does not work:** Re-running a past workflow from the Actions tab rebuilds the **old** commit, not new changes on `main`. Move the tag instead.

## What the workflow does

On every push of a tag matching `v*` (e.g. `v0.1.0`, `v1.2.3`):

1. Checks out the code at that tag
2. Runs `npm ci`, `npm run typecheck`, and `npm run build`
3. Zips the contents of `dist/` into `browser-sidebar-v{version}.zip`
4. Creates a GitHub Release and attaches the ZIP

## Local build (optional)

For testing before you tag:

```bash
npm install
npm run build
```

Load the `dist/` folder in Chrome via **Load unpacked** at `chrome://extensions`.

## Troubleshooting

| Problem | Fix |
|---------|-----|
| Workflow did not run | Tag must start with `v` and be pushed: `git push origin v0.1.1` |
| Release failed on permissions | Ensure `permissions: contents: write` is in the workflow (already set) |
| ZIP missing from release | Check the Actions log for build/typecheck errors |
| Version mismatch | Tag `v0.1.1` must match `"version": "0.1.1"` in `manifest.json` |
| New commits on main but same ZIP | Push to `main` does not rebuild — see [Rebuild same version](#rebuild-same-version) |
| Re-run workflow didn't update ZIP | Re-run uses the old tagged commit — move the tag to the new commit instead |
| Release failed: not on main | Tag must point to a commit on `main` — merge to main first, then tag |
