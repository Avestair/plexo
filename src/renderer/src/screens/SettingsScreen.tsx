import { useEffect, useState } from 'react'
import { ScreenFooter } from '../components/ScreenFooter'
import { Button } from '../components/ui/button'
import { Checkbox } from '../components/ui/checkbox'
import { Input } from '../components/ui/input'

/**
 * App-wide settings: the global max download speed, and platform-integration toggles (tray,
 * start on login, start minimized). Deliberately minimal beyond that — theme lives in the title
 * bar, destination folder on the Start screen, per-queue bandwidth on QueueDetailScreen.
 */
export function SettingsScreen(): React.JSX.Element {
  const [speedLimitKBs, setSpeedLimitKBs] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [saved, setSaved] = useState(false)

  const [minimizeToTrayOnClose, setMinimizeToTrayOnClose] = useState(false)
  const [startOnLogin, setStartOnLogin] = useState(false)
  const [startMinimized, setStartMinimized] = useState(false)
  const [platformLoaded, setPlatformLoaded] = useState(false)

  useEffect(() => {
    let disposed = false
    void window.plexo.getGlobalBandwidthLimit().then((bytesPerSec) => {
      if (disposed) return
      setSpeedLimitKBs(bytesPerSec > 0 ? String(Math.round(bytesPerSec / 1024)) : '')
      setLoaded(true)
    })
    void window.plexo.getSettings().then((settings) => {
      if (disposed) return
      setMinimizeToTrayOnClose(settings.minimizeToTrayOnClose ?? false)
      setStartOnLogin(settings.startOnLogin ?? false)
      setStartMinimized(settings.startMinimized ?? false)
      setPlatformLoaded(true)
    })
    return () => {
      disposed = true
    }
  }, [])

  const handleSave = async (): Promise<void> => {
    const kbs = Number(speedLimitKBs)
    const bytesPerSec = Number.isFinite(kbs) && kbs > 0 ? Math.round(kbs * 1024) : 0
    await window.plexo.setGlobalBandwidthLimit(bytesPerSec)
    setSaved(true)
    setTimeout(() => setSaved(false), 1500)
  }

  return (
    <div className="flex h-full flex-col bg-background">
      <div className="flex items-center gap-2.5 px-5 pt-5 pb-3">
        <h1 className="font-sans text-[15px] font-bold">Settings</h1>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-5">
        <div className="flex flex-col gap-2.5 rounded-[10px] border-[0.5px] border-border bg-card p-[13px_14px]">
          <div className="font-sans text-[13px] font-semibold">Download speed</div>
          <div className="max-w-80 font-sans text-[11.5px] text-muted-foreground">
            Caps every active transfer — ad-hoc or in a queue — that doesn&apos;t have its own
            override (set per-queue on a queue&apos;s own page). Leave blank for unlimited.
          </div>
          <div className="flex items-center gap-2">
            <span className="font-sans text-[11.5px] text-muted-foreground">Max speed</span>
            <Input
              type="number"
              min={0}
              placeholder="Unlimited"
              value={speedLimitKBs}
              disabled={!loaded}
              onChange={(event) => setSpeedLimitKBs(event.target.value)}
              className="h-7 w-24"
            />
            <span className="font-sans text-[11.5px] text-muted-foreground">KB/s</span>
            <Button type="button" size="sm" disabled={!loaded} onClick={handleSave}>
              {saved ? 'Saved' : 'Save'}
            </Button>
          </div>
        </div>

        <div className="mt-3 flex flex-col gap-2.5 rounded-[10px] border-[0.5px] border-border bg-card p-[13px_14px]">
          <div className="font-sans text-[13px] font-semibold">Background &amp; startup</div>

          <label className="flex items-center gap-2">
            <Checkbox
              checked={minimizeToTrayOnClose}
              disabled={!platformLoaded}
              onCheckedChange={(checked) => {
                const value = checked === true
                setMinimizeToTrayOnClose(value)
                void window.plexo.updateSettings({ minimizeToTrayOnClose: value })
              }}
            />
            <span className="font-sans text-[11.5px] text-muted-foreground">
              Keep running in the tray when the window is closed
            </span>
          </label>

          <label className="flex items-center gap-2">
            <Checkbox
              checked={startOnLogin}
              disabled={!platformLoaded}
              onCheckedChange={(checked) => {
                const value = checked === true
                setStartOnLogin(value)
                void window.plexo.updateSettings({ startOnLogin: value })
              }}
            />
            <span className="font-sans text-[11.5px] text-muted-foreground">
              Start Plexo when you log in
            </span>
          </label>

          <label className="flex items-center gap-2">
            <Checkbox
              checked={startMinimized}
              disabled={!platformLoaded}
              onCheckedChange={(checked) => {
                const value = checked === true
                setStartMinimized(value)
                void window.plexo.updateSettings({ startMinimized: value })
              }}
            />
            <span className="font-sans text-[11.5px] text-muted-foreground">
              Start minimized{' '}
              {minimizeToTrayOnClose
                ? '(to the tray)'
                : '(stays hidden — enable the tray above to reopen it)'}
            </span>
          </label>
        </div>
      </div>

      <ScreenFooter>
        <div className="font-mono text-[11px] text-muted-foreground">
          Applies to every download that doesn&apos;t set its own limit
        </div>
      </ScreenFooter>
    </div>
  )
}
