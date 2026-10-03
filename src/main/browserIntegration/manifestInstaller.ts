import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { app } from 'electron'

const execFileAsync = promisify(execFile)

/** Must match the `name` field both extensions' background scripts pass to
 * chrome.runtime.connectNative/sendNativeMessage — see browser-extension's background.js files.
 * Native messaging host names are restricted by both browsers to `[a-zA-Z0-9._]+`. */
export const NATIVE_HOST_NAME = 'com.plexo.browser_integration'

/** The Firefox extension's own fixed id (browser-extension/firefox/manifest.json's
 * browser_specific_settings.gecko.id) — unlike a Chrome extension loaded unpacked, a Firefox
 * extension's id is whatever the extension itself declares, so this can be wired into the host
 * manifest ahead of time with nothing for the user to look up. */
export const FIREFOX_EXTENSION_ID = 'browser-integration@plexo.app'

export interface BrowserIntegrationInstallResult {
  installed: string[]
  skipped: string[]
  errors: string[]
}

function nativeMessagingDir(): string {
  return join(app.getPath('userData'), 'native-messaging')
}

/** The host manifest's `path` must point at a single program with no extra arguments baked in —
 * neither browser's manifest format has a field for CLI args. This tiny wrapper script is that
 * program: all it does is exec this same already-installed app's own binary (whatever
 * `process.execPath` resolves to right now, i.e. the real installed location, not a guess at
 * electron-builder's default) with `--native-messaging-host`, so no second runtime (Node) needs to
 * be present on the user's machine beyond Plexo itself. */
async function writeWrapperScript(): Promise<string> {
  const dir = nativeMessagingDir()
  await mkdir(dir, { recursive: true })
  if (process.platform === 'win32') {
    const scriptPath = join(dir, 'run-host.bat')
    const execPath = app.getPath('exe')
    await writeFile(
      scriptPath,
      `@echo off\r\n"${execPath}" --native-messaging-host %*\r\n`,
      'utf-8'
    )
    return scriptPath
  }
  const scriptPath = join(dir, 'run-host.sh')
  const execPath = app.getPath('exe')
  await writeFile(
    scriptPath,
    `#!/bin/sh\nexec "${execPath}" --native-messaging-host "$@"\n`,
    'utf-8'
  )
  await chmod(scriptPath, 0o755)
  return scriptPath
}

function chromeManifest(hostPath: string, extensionId: string | undefined): object {
  return {
    name: NATIVE_HOST_NAME,
    description: 'Plexo browser integration — receives one link at a time, sent on request',
    path: hostPath,
    type: 'stdio',
    allowed_origins: [`chrome-extension://${extensionId ?? 'REPLACE_WITH_YOUR_EXTENSION_ID'}/`]
  }
}

function firefoxManifest(hostPath: string): object {
  return {
    name: NATIVE_HOST_NAME,
    description: 'Plexo browser integration — receives one link at a time, sent on request',
    path: hostPath,
    type: 'stdio',
    allowed_extensions: [FIREFOX_EXTENSION_ID]
  }
}

async function writeManifestFile(dir: string, content: object): Promise<void> {
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, `${NATIVE_HOST_NAME}.json`), JSON.stringify(content, null, 2), 'utf-8')
}

/** HKCU is used (not HKLM) deliberately — it needs no elevation, matches the fact that the
 * manifest it points to lives under this user's own userData directory, and is exactly the scope
 * both browsers document for a per-user native messaging host registration. */
async function writeWindowsRegistryEntry(
  browser: 'chrome' | 'firefox',
  manifestPath: string
): Promise<void> {
  const base = browser === 'chrome' ? 'Google\\Chrome' : 'Mozilla'
  const keyPath = `HKCU\\Software\\${base}\\NativeMessagingHosts\\${NATIVE_HOST_NAME}`
  await execFileAsync('reg', ['add', keyPath, '/ve', '/t', 'REG_SZ', '/d', manifestPath, '/f'])
}

/**
 * Writes the native messaging host manifest(s) Chrome and Firefox each need to find and launch
 * the wrapper script above, to every standard per-OS location for that browser. Never touches
 * anything else — not a config file of the browser's own, not anything outside this app's own
 * userData directory and the browser's documented native-messaging registration point.
 *
 * This still leaves the extension itself to be loaded by hand in the browser (see
 * browser-extension/chrome/README.md and browser-extension/firefox/README.md) — that step has no
 * programmatic equivalent for an unpacked/dev-loaded extension, in either browser.
 *
 * `chromeExtensionId`, when given, is the id the user copied from chrome://extensions after
 * loading the unpacked Chrome extension (see SettingsScreen) — without it, the Chrome manifest is
 * still written, but with a placeholder `allowed_origins` entry that matches no real extension
 * until the user re-registers with their real id filled in.
 */
export async function registerNativeMessagingHost(
  chromeExtensionId?: string
): Promise<BrowserIntegrationInstallResult> {
  const installed: string[] = []
  const skipped: string[] = []
  const errors: string[] = []

  const hostPath = await writeWrapperScript()
  const dir = nativeMessagingDir()
  const chromeManifestPath = join(dir, 'chrome-manifest.json')
  const firefoxManifestPath = join(dir, 'firefox-manifest.json')
  await writeFile(
    chromeManifestPath,
    JSON.stringify(chromeManifest(hostPath, chromeExtensionId), null, 2),
    'utf-8'
  )
  await writeFile(firefoxManifestPath, JSON.stringify(firefoxManifest(hostPath), null, 2), 'utf-8')

  const home = homedir()

  if (process.platform === 'win32') {
    for (const browser of ['chrome', 'firefox'] as const) {
      try {
        await writeWindowsRegistryEntry(
          browser,
          browser === 'chrome' ? chromeManifestPath : firefoxManifestPath
        )
        installed.push(`${browser} (registry)`)
      } catch (error) {
        errors.push(`${browser} registry key: ${error instanceof Error ? error.message : error}`)
      }
    }
    return { installed, skipped, errors }
  }

  const chromeDirs =
    process.platform === 'darwin'
      ? [
          join(home, 'Library/Application Support/Google/Chrome/NativeMessagingHosts'),
          join(home, 'Library/Application Support/Google/Chrome Beta/NativeMessagingHosts'),
          join(home, 'Library/Application Support/Chromium/NativeMessagingHosts')
        ]
      : [
          join(home, '.config/google-chrome/NativeMessagingHosts'),
          join(home, '.config/google-chrome-beta/NativeMessagingHosts'),
          join(home, '.config/chromium/NativeMessagingHosts')
        ]

  const firefoxDirs =
    process.platform === 'darwin'
      ? [join(home, 'Library/Application Support/Mozilla/NativeMessagingHosts')]
      : [join(home, '.mozilla/native-messaging-hosts')]

  for (const dirPath of chromeDirs) {
    try {
      await writeManifestFile(dirPath, chromeManifest(hostPath, chromeExtensionId))
      installed.push(dirPath)
    } catch (error) {
      errors.push(`${dirPath}: ${error instanceof Error ? error.message : error}`)
    }
  }
  for (const dirPath of firefoxDirs) {
    try {
      await writeManifestFile(dirPath, firefoxManifest(hostPath))
      installed.push(dirPath)
    } catch (error) {
      errors.push(`${dirPath}: ${error instanceof Error ? error.message : error}`)
    }
  }

  return { installed, skipped, errors }
}

/** Where the two extension folders live for "load unpacked" — bundled as extraResources
 * (electron-builder.yml) so a packaged install still ships them, found next to the app's own
 * resources in a packaged build or at the repo root in dev. */
export function browserExtensionDirs(): { chrome: string; firefox: string } {
  const root = app.isPackaged ? process.resourcesPath : join(app.getAppPath())
  return {
    chrome: join(root, 'browser-extension', 'chrome'),
    firefox: join(root, 'browser-extension', 'firefox')
  }
}
