// Send to Plexo — Chrome (Manifest V3) background service worker.
//
// This extension does exactly one thing: when the user clicks the toolbar button, or picks
// "Send link to Plexo" from the context menu on a link or a page, it sends that one URL to the
// native messaging host Plexo registers (see ../../src/main/browserIntegration/manifestInstaller.ts)
// via chrome.runtime.sendNativeMessage. It never reads browsing history, never touches
// chrome.downloads, and never acts on anything the user didn't just explicitly click.

// Must exactly match NATIVE_HOST_NAME in
// src/main/browserIntegration/manifestInstaller.ts, and the native messaging host manifest's
// own "name" field that Plexo's "Register native messaging host" button writes.
const NATIVE_HOST_NAME = 'com.plexo.browser_integration'

const MENU_ID_LINK = 'plexo-send-link'
const MENU_ID_PAGE = 'plexo-send-page'

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: MENU_ID_LINK,
    title: 'Send link to Plexo',
    contexts: ['link']
  })
  chrome.contextMenus.create({
    id: MENU_ID_PAGE,
    title: 'Send this page to Plexo',
    contexts: ['page']
  })
})

/** Flashes the toolbar icon's badge with a one-word result, so a click gives the user some
 * feedback even though this extension has no popup UI of its own. */
function flashBadge(text, color) {
  chrome.action.setBadgeBackgroundColor({ color })
  chrome.action.setBadgeText({ text })
  setTimeout(() => chrome.action.setBadgeText({ text: '' }), 2500)
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

function sendLinkToPlexo(url) {
  if (!/^https?:\/\//i.test(url)) {
    flashBadge('✗', '#dc2626')
    return
  }
  const message = { url, suggestedFileName: suggestedFileNameFor(url) }
  chrome.runtime.sendNativeMessage(NATIVE_HOST_NAME, message, (response) => {
    if (chrome.runtime.lastError || !response || response.ok !== true) {
      console.error(
        'Plexo: failed to send link',
        chrome.runtime.lastError?.message || response?.error || 'unknown error'
      )
      flashBadge('✗', '#dc2626')
      return
    }
    flashBadge('✓', '#16a34a')
  })
}

chrome.contextMenus.onClicked.addListener((info) => {
  if (info.menuItemId === MENU_ID_LINK && info.linkUrl) {
    sendLinkToPlexo(info.linkUrl)
  } else if (info.menuItemId === MENU_ID_PAGE && info.pageUrl) {
    sendLinkToPlexo(info.pageUrl)
  }
})

chrome.action.onClicked.addListener((tab) => {
  if (tab.url) sendLinkToPlexo(tab.url)
})
