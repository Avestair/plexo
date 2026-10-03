// Send to Plexo — Firefox extension background script.
//
// Same behavior as the Chrome version (see ../chrome/background.js's comment for the full
// description) adapted to Firefox's WebExtensions API: `browser.*` instead of `chrome.*`, and
// promise-based rather than callback-based. Firefox runs this as a non-persistent background
// script even under manifest_version 3 (it does not yet support MV3 service workers the way
// Chrome does), which is why manifest.json declares `background.scripts` rather than
// `background.service_worker`.

// Must exactly match NATIVE_HOST_NAME in
// src/main/browserIntegration/manifestInstaller.ts, and the native messaging host manifest's own
// "name" field that Plexo's "Register native messaging host" button writes.
const NATIVE_HOST_NAME = 'com.plexo.browser_integration'

const MENU_ID_LINK = 'plexo-send-link'
const MENU_ID_PAGE = 'plexo-send-page'

browser.runtime.onInstalled.addListener(() => {
  browser.contextMenus.create({
    id: MENU_ID_LINK,
    title: 'Send link to Plexo',
    contexts: ['link']
  })
  browser.contextMenus.create({
    id: MENU_ID_PAGE,
    title: 'Send this page to Plexo',
    contexts: ['page']
  })
})

/** Flashes the toolbar icon's badge with a one-word result, so a click gives the user some
 * feedback even though this extension has no popup UI of its own. */
function flashBadge(text, color) {
  browser.action.setBadgeBackgroundColor({ color })
  browser.action.setBadgeText({ text })
  setTimeout(() => browser.action.setBadgeText({ text: '' }), 2500)
}

/** Only ever sends `{ url, suggestedFileName? }` — see this phase's security framing for why that
 * is the entire message schema, on purpose. `suggestedFileName` is best-effort only: the last path
 * segment of the URL, when it looks like a plausible filename, otherwise omitted entirely rather
 * than guessed at. */
function suggestedFileNameFor(url) {
  try {
    const segment = decodeURIComponent(new URL(url).pathname.split('/').pop() ?? '')
    return segment && segment.includes('.') ? segment : undefined
  } catch {
    return undefined
  }
}

async function sendLinkToPlexo(url) {
  if (!/^https?:\/\//i.test(url)) {
    flashBadge('✗', '#dc2626')
    return
  }
  const message = { url, suggestedFileName: suggestedFileNameFor(url) }
  try {
    const response = await browser.runtime.sendNativeMessage(NATIVE_HOST_NAME, message)
    if (!response || response.ok !== true) {
      console.error('Plexo: failed to send link', response?.error || 'unknown error')
      flashBadge('✗', '#dc2626')
      return
    }
    flashBadge('✓', '#16a34a')
  } catch (error) {
    console.error('Plexo: failed to reach the native messaging host', error)
    flashBadge('✗', '#dc2626')
  }
}

browser.contextMenus.onClicked.addListener((info) => {
  if (info.menuItemId === MENU_ID_LINK && info.linkUrl) {
    void sendLinkToPlexo(info.linkUrl)
  } else if (info.menuItemId === MENU_ID_PAGE && info.pageUrl) {
    void sendLinkToPlexo(info.pageUrl)
  }
})

browser.action.onClicked.addListener((tab) => {
  if (tab.url) void sendLinkToPlexo(tab.url)
})
