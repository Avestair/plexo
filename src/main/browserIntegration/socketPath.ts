import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { app } from 'electron'

/**
 * Where the local listener (BrowserIntegrationServer) binds, and where the native messaging host
 * process (nativeHostMain.ts) connects to reach it.
 *
 * On Linux/macOS this is a Unix domain socket file inside the app's own userData directory — a
 * location only this OS user can reach (the directory itself carries normal user-only
 * permissions, the same as every other file Plexo writes there), scoped per userData dir so two
 * instances pointed at different profiles (e.g. two e2e tests running in parallel, each given
 * their own PLEXO_USER_DATA) never collide.
 *
 * On Windows there is no filesystem-backed equivalent — named pipes live in a single machine-wide
 * namespace (`\\.\pipe\...`) regardless of which userData directory asked for one. The name is
 * salted with a short hash of the userData path so two profiles on the same machine still get
 * distinct pipes, but the OS enforces no user-scoping of its own here the way a Unix socket file's
 * directory permissions do; Windows named pipes do default to a DACL that only the creating user
 * (and admins/SYSTEM) can connect to, which is the property that actually matters for this to be
 * safe, not the name itself.
 */
export function browserIntegrationSocketPath(): string {
  const userData = app.getPath('userData')
  if (process.platform === 'win32') {
    const suffix = createHash('sha1').update(userData).digest('hex').slice(0, 12)
    return `\\\\.\\pipe\\plexo-browser-integration-${suffix}`
  }
  return join(userData, 'browser-integration.sock')
}
