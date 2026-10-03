import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { SystemAction } from '../../shared/types'
import { testKnobs } from '../testKnobs'

const execFileAsync = promisify(execFile)

export interface SystemCommand {
  command: string
  args: string[]
}

/**
 * Pure: decides which OS command would carry out `action` on `platform`, without running
 * anything — this is what's actually unit-tested, since runSystemActionCommand below must never
 * be invoked for real outside a packaged app. Returns null for 'none' (nothing to run) or an
 * action this platform has no command for.
 */
export function decideSystemActionCommand(
  action: SystemAction,
  platform: NodeJS.Platform
): SystemCommand | null {
  if (action === 'none') return null

  if (platform === 'win32') {
    switch (action) {
      case 'sleep':
        return { command: 'rundll32.exe', args: ['powrprof.dll,SetSuspendState', '0,1,0'] }
      case 'hibernate':
        return { command: 'shutdown', args: ['/h'] }
      case 'shutdown':
        return { command: 'shutdown', args: ['/s', '/t', '0'] }
    }
  }

  if (platform === 'darwin') {
    switch (action) {
      // macOS has no scripted "hibernate" distinct from sleep — true hibernate there is a
      // system-wide pmset mode, not a one-shot command, so this intentionally falls back to the
      // same sleep command rather than silently doing nothing.
      case 'sleep':
      case 'hibernate':
        return { command: 'osascript', args: ['-e', 'tell app "System Events" to sleep'] }
      case 'shutdown':
        return { command: 'osascript', args: ['-e', 'tell app "System Events" to shut down'] }
    }
  }

  if (platform === 'linux') {
    switch (action) {
      case 'sleep':
        return { command: 'systemctl', args: ['suspend'] }
      case 'hibernate':
        return { command: 'systemctl', args: ['hibernate'] }
      case 'shutdown':
        return { command: 'systemctl', args: ['poweroff'] }
    }
  }

  return null
}

/**
 * ⚠️ THE DANGEROUS SEAM. Actually runs the OS-level sleep/hibernate/shutdown command.
 *
 * Never call this to "see if it works" — not by hand, not in a test, not as a sanity check. On a
 * real machine it does exactly what it says; in this project's sandboxed dev/test environment it
 * kills the container this code runs in.
 *
 * e2e tests must never reach the child_process call below: they set
 * PLEXO_E2E_SYSTEM_ACTION_STUB=1 (read into testKnobs.systemActionStub), which this function
 * checks first and, if set, returns (or rejects, for PLEXO_E2E_SYSTEM_ACTION_FAIL) without
 * touching child_process at all. testKnobs itself ignores both env vars once app.isPackaged, so a
 * shipped build can never have this stubbed out from outside.
 */
export async function runSystemActionCommand(action: SystemAction): Promise<void> {
  if (action === 'none') return

  if (testKnobs.systemActionStub) {
    if (testKnobs.systemActionFailureMessage) {
      throw new Error(testKnobs.systemActionFailureMessage)
    }
    return
  }

  const command = decideSystemActionCommand(action, process.platform)
  if (!command) {
    throw new Error(`No system action command for "${action}" on ${process.platform}`)
  }
  await execFileAsync(command.command, command.args)
}
