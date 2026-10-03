# Plexo browser integration

Lets you send a link from Chrome/Chromium or Firefox to Plexo with one click (toolbar button, or
"Send link to Plexo" on a link/page's right-click menu) instead of copying and pasting it in by
hand. It never intercepts or redirects the browser's own downloads — see the security framing
below for why that's a deliberate scope limit, not a missing feature.

- `chrome/` — Manifest V3 extension for Chrome and other Chromium-based browsers. See its own
  README for exact load/registration steps (the extension id Chrome assigns on load has to be
  copied into Plexo's Settings).
- `firefox/` — WebExtensions (MV3-shaped, `browser.*`, promise-based) extension for Firefox. See
  its own README — Firefox's native messaging manifest location and extension-id handling are both
  different from Chrome's, and it's covered there in full.

Both talk to a tiny native messaging host that ships inside Plexo itself (no separate Node install
or download needed — see `src/main/browserIntegration/nativeHostMain.ts`), which Plexo's own
"Register native messaging host" button (Settings → Browser integration) wires up for you.

## How a link actually gets from your browser to Plexo

```
 extension (background.js)
      │  chrome.runtime.sendNativeMessage / browser.runtime.sendNativeMessage
      │  { url, suggestedFileName? }           (4-byte length prefix + UTF-8 JSON, both ways)
      ▼
 native messaging host                          ← Plexo's own binary, launched with
 (src/main/browserIntegration/nativeHostMain.ts)   --native-messaging-host
      │  { url, suggestedFileName? }           (newline-delimited JSON, one line each way)
      ▼
 local listener, inside the already-running Plexo app
 (src/main/browserIntegration/server.ts)
      │  shows/focuses the window, pushes the URL to the renderer
      ▼
 Plexo's window — a dismissible "Link sent from your browser" banner,
 the same shape as the clipboard-detection one — Accept fills in the Start screen's
 URL field; nothing downloads until you press Start yourself.
```

## Security framing

The **only** thing a browser extension can ever ask Plexo to do, end to end, is "please add this
URL to the download flow" — optionally with a suggested filename. Nothing else reaches Plexo from
this channel: no config changes, no commands, no file access. Both the native messaging host and
the local listener independently parse the message as `{ url: string, suggestedFileName?: string
}` and reject (log, never throw, never act on) anything that isn't valid JSON of that exact shape,
or whose `url` doesn't parse as an `http(s)://` URL via `new URL()`.

The local listener is a Unix domain socket (a named pipe on Windows) under Plexo's own per-user
userData directory — not a TCP port, even on 127.0.0.1, because a loopback TCP port is reachable by
every other local user/process on a shared machine, where a socket file under a user-owned
directory (or a Windows pipe's default per-user DACL) is not. It only exists at all while "Accept
links sent from the browser" is turned on in Settings — off by default, and fully torn down (not
just hidden) when turned off.

The actual access-control boundary is each browser's own native messaging host manifest:
`allowed_origins` (Chrome — scoped to one specific extension id) and `allowed_extensions`
(Firefox — scoped to this extension's own fixed id). Only an extension listed there can even
launch the host process; this is why the Chrome README has you paste your loaded extension's id
into Plexo's Settings before registering, and why the Firefox extension ships with a fixed id
already built into both its own manifest and the host manifest Plexo writes.

**Deliberately out of scope**: automatically intercepting every browser download (overriding
`chrome.downloads`/`browser.downloads`). That would change how the browser behaves for every
download without being asked, which is a much larger and riskier behavior change than "send this
one link I clicked on" — and this is the last phase of this project, so it isn't coming later
either.

## What a human still has to do by hand

Nothing here can be fully automated — see each extension's own README for the exact, OS/browser-
specific steps, but at a glance:

1. **Load the extension itself.** Neither browser lets an app install an extension into it
   programmatically from outside the browser; this is a deliberate browser security boundary, not
   a gap in Plexo. Chrome: "Load unpacked" at `chrome://extensions` (dev mode on). Firefox: "Load
   Temporary Add-on" at `about:debugging` (resets on restart on release Firefox — see
   `firefox/README.md` for the alternatives).
2. **Copy the Chrome extension's id into Plexo's Settings** (Firefox doesn't need this — its id is
   fixed).
3. **Click "Register native messaging host"** in Plexo's Settings, after step 2.

## What is, and isn't, verified by this project's own tests

`e2e/browserIntegration.spec.ts` drives the local listener directly (connecting to its socket the
same way the native messaging host does) and verifies: a valid URL reaches the renderer as a push
event and shows/focuses the window; malformed JSON and a non-http(s) URL are both rejected without
crashing anything; the listener doesn't exist at all while the setting is off, and does once it's
on, and stops existing again once it's turned back off.

What that suite does **not**, and cannot, verify in this sandbox: that Chrome or Firefox actually
show the context menu or toolbar button, that `sendNativeMessage`/`connectNative` actually launches
the wrapper script and host process the way described above, or that the manifests
"Register native messaging host" writes end up in exactly the paths a real installed Chrome or
Firefox reads from on a given machine. Confirming those needs a human with a real browser: load the
extension as above, click it on a real link, and check Plexo's window for the banner.
