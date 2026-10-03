# Send to Plexo — Firefox extension

Sends one link at a time to Plexo, on request: a right-click "Send link to Plexo" on any link or
page, or the toolbar button for the current tab. It never touches Firefox's own download system —
see the repo root's phase documentation for why that's deliberate.

Unlike the Chrome version, this extension's id is fixed in its own manifest
(`browser_specific_settings.gecko.id`: `browser-integration@plexo.app`) rather than assigned at
load time — so there is nothing to copy into Plexo's Settings for Firefox. Registering the native
messaging host (below) is enough on its own.

## 1. Turn on browser integration in Plexo

Open Plexo → **Settings → Browser integration**, turn on "Accept links sent from the browser", and
click **Register native messaging host**. This writes the manifest file Firefox uses to find and
launch Plexo's native messaging host, and to check that only this extension (by its fixed id
above) is allowed to — see `src/main/browserIntegration/manifestInstaller.ts`.

## 2. Load the extension temporarily

Firefox has two ways to load an unsigned extension, with two different tradeoffs:

### Temporary (easiest, but reset every restart)

1. Go to `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on…**.
3. Select `manifest.json` inside this folder (`browser-extension/firefox`).
4. The extension is now active — until Firefox restarts, at which point you'd need to repeat this.

### Persistent, without a Mozilla account (Firefox Developer Edition or Nightly only)

1. Go to `about:config`, set `xpinstall.signatures.required` to `false`.
2. Go to `about:addons` → gear menu → **Install Add-on From File…** → select a zipped copy of this
   folder (zip its *contents*, not the folder itself, so `manifest.json` is at the zip's root).

Regular release Firefox refuses to permanently install an extension that Mozilla hasn't signed,
with no local override — that's a Firefox policy, not something this app can work around. The
temporary-load path above is the realistic option on release Firefox.

## If "Send link to Plexo" doesn't seem to do anything

- Confirm Plexo's "Accept links sent from the browser" setting is on, and that you clicked
  "Register native messaging host" after turning it on.
- Open `about:debugging#/runtime/this-firefox`, find this extension, and click **Inspect** to see
  its console for the actual error.
- This only ever works with Plexo already running — the toolbar button flashes a red ✗ if Plexo
  isn't open, or if browser integration is turned off in its Settings.
