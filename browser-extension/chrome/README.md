# Send to Plexo — Chrome / Chromium extension

Sends one link at a time to Plexo, on request: a right-click "Send link to Plexo" on any link or
page, or the toolbar button for the current tab. It never touches Chrome's own download system —
see the repo root's phase documentation for why that's deliberate.

## 1. Install the native messaging host first

Before loading this extension, open Plexo → **Settings → Browser integration** and:

1. Turn on "Accept links sent from the browser".
2. Come back here after step 2 below to paste in your extension's id, then click
   "Register native messaging host".

## 2. Load the extension, unpacked

Chrome only runs this from source via "Load unpacked" — it is not published on the Chrome Web
Store.

1. Go to `chrome://extensions`.
2. Turn on **Developer mode** (top-right toggle).
3. Click **Load unpacked** and select this folder (`browser-extension/chrome`).
4. The extension now appears in your extensions list with an id like
   `abcdefghijklmnopabcdefghijklmnop` — a string of exactly 32 lowercase letters between `a` and
   `p`. **This id is random and different on every machine/profile it's loaded into** — it is
   derived from the extension's install path, not anything in this folder, so you cannot skip this
   step or reuse someone else's id.

## 3. Tell Plexo that id

1. Copy the id shown on the extension's card on `chrome://extensions`.
2. In Plexo's Settings → Browser integration, paste it into "Chrome extension id".
3. Click **Register native messaging host**.

This writes (or rewrites) the native messaging host manifest Chrome uses to decide which
extensions are allowed to launch Plexo's host process at all (its `allowed_origins` field) — see
`src/main/browserIntegration/manifestInstaller.ts`. Without this step, Chrome refuses to launch the
host for an unrecognized extension id, by design: this is native messaging's actual security
boundary, not a convenience setting.

## Reloading after you rebuild Plexo, or move/reinstall it

The manifest points at a path chosen when you last clicked "Register native messaging host" — if
you move or reinstall Plexo, click it again.

## If "Send link to Plexo" doesn't seem to do anything

- Confirm Plexo's "Accept links sent from the browser" setting is on.
- Confirm the extension id pasted into Settings matches the one on `chrome://extensions` exactly
  (it changes if you remove and re-load the extension).
- Open the extension's service worker console (`chrome://extensions` → this extension → "service
  worker" link) for the actual error Chrome reports.
- This only ever works with Plexo already running — the toolbar button flashes a red ✗ if Plexo
  isn't open, or if browser integration is turned off in its Settings.
