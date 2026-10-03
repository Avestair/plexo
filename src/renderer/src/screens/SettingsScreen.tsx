import type { CategoryRule } from '@shared/types'
import { ArrowDown, ArrowUp, Pencil, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { ScreenFooter } from '../components/ScreenFooter'
import { Button } from '../components/ui/button'
import { Checkbox } from '../components/ui/checkbox'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '../components/ui/dialog'
import { Input } from '../components/ui/input'
import { useAppStore } from '../store/useAppStore'

const selectClassName =
  'h-7 rounded-lg border border-input bg-transparent px-2 text-[12px] outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30'

/** Create/edit form for one category rule — keyed by the parent on the rule's id (or 'new'), the
 * same local-draft-until-saved shape as QueueDetailScreen's BandwidthForm/SystemActionForm, so
 * switching which rule is being edited remounts it instead of needing an effect to re-sync. */
function CategoryRuleDialog({
  open,
  onOpenChange,
  queues,
  editingRule
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  queues: { id: string; name: string }[]
  editingRule: CategoryRule | null
}): React.JSX.Element {
  const [name, setName] = useState(editingRule?.name ?? '')
  const [matchType, setMatchType] = useState<CategoryRule['matchType']>(
    editingRule?.matchType ?? 'extension'
  )
  const [pattern, setPattern] = useState(editingRule?.pattern ?? '')
  const [targetQueueId, setTargetQueueId] = useState(
    editingRule?.targetQueueId ?? queues[0]?.id ?? ''
  )
  const [saving, setSaving] = useState(false)

  const canSave = !!name.trim() && !!pattern.trim() && !!targetQueueId

  const handleSave = async (): Promise<void> => {
    if (!canSave || saving) return
    setSaving(true)
    try {
      const payload = {
        name: name.trim(),
        matchType,
        pattern: pattern.trim(),
        targetQueueId,
        enabled: editingRule?.enabled ?? true
      }
      if (editingRule) await window.plexo.updateCategoryRule(editingRule.id, payload)
      else await window.plexo.createCategoryRule(payload)
      onOpenChange(false)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{editingRule ? 'Edit rule' : 'New rule'}</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-2.5">
          <Input
            autoFocus
            placeholder="Rule name"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
          <div className="flex items-center gap-2">
            <span className="font-sans text-[11.5px] text-muted-foreground">Match by</span>
            <select
              value={matchType}
              onChange={(event) => setMatchType(event.target.value as CategoryRule['matchType'])}
              className={selectClassName}
            >
              <option value="extension">File extension</option>
              <option value="urlPattern">URL pattern</option>
            </select>
          </div>
          <Input
            placeholder={
              matchType === 'extension' ? 'mp4, mkv, avi' : 'example.com/movies (or a regex)'
            }
            value={pattern}
            onChange={(event) => setPattern(event.target.value)}
          />
          <div className="flex items-center gap-2">
            <span className="font-sans text-[11.5px] text-muted-foreground">Add to</span>
            <select
              value={targetQueueId}
              onChange={(event) => setTargetQueueId(event.target.value)}
              className={selectClassName}
            >
              {queues.map((queue) => (
                <option key={queue.id} value={queue.id}>
                  {queue.name}
                </option>
              ))}
            </select>
          </div>
        </div>
        <DialogFooter>
          <DialogClose render={<Button type="button" variant="outline" />}>Cancel</DialogClose>
          <Button type="button" disabled={!canSave || saving} onClick={handleSave}>
            {editingRule ? 'Save' : 'Create'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * Lets the user define rules that auto-route a URL to a queue (by file extension, or a pattern
 * in the URL) instead of always requiring a queue to be picked by hand — see IdleScreen for
 * where that's actually offered (a non-blocking suggestion once a rule matches, never forced).
 * App-level, not per-queue, since one rule list covers every queue — hence its home here rather
 * than on QueueDetailScreen. Deliberately minimal: a flat ordered list, first match wins.
 */
function CategoryRulesSection(): React.JSX.Element {
  const rules = useAppStore((store) => store.categoryRules)
  const queues = useAppStore((store) => store.queues)
  const sorted = [...rules].sort((a, b) => a.order - b.order)

  const [dialogOpen, setDialogOpen] = useState(false)
  const [editingRule, setEditingRule] = useState<CategoryRule | null>(null)

  const openCreate = (): void => {
    setEditingRule(null)
    setDialogOpen(true)
  }
  const openEdit = (rule: CategoryRule): void => {
    setEditingRule(rule)
    setDialogOpen(true)
  }

  const handleMove = (ruleId: string, direction: -1 | 1): void => {
    const ids = sorted.map((rule) => rule.id)
    const index = ids.indexOf(ruleId)
    const swapWith = index + direction
    if (swapWith < 0 || swapWith >= ids.length) return
    ;[ids[index], ids[swapWith]] = [ids[swapWith], ids[index]]
    void window.plexo.reorderCategoryRules(ids)
  }

  return (
    <div className="mt-3 flex flex-col gap-2.5 rounded-[10px] border-[0.5px] border-border bg-card p-[13px_14px]">
      <div className="flex items-center gap-2.5">
        <div className="font-sans text-[13px] font-semibold">Category rules</div>
        <div className="flex-1" />
        <Button type="button" size="sm" disabled={queues.length === 0} onClick={openCreate}>
          Add rule
        </Button>
      </div>
      <div className="max-w-[26rem] font-sans text-[11.5px] text-muted-foreground">
        Auto-routes a URL added on the Start screen — without picking a queue — to a queue, by file
        extension or a pattern in its address. The first enabled match, in order, wins. Adding a URL
        directly inside a queue is unaffected.
      </div>

      {queues.length === 0 ? (
        <div className="font-sans text-[11.5px] text-muted-foreground">
          Create a queue first to route a rule to it.
        </div>
      ) : sorted.length === 0 ? (
        <div className="font-sans text-[11.5px] text-muted-foreground">No rules yet.</div>
      ) : (
        <div className="flex flex-col gap-1.5">
          {sorted.map((rule, index) => {
            const queueName = queues.find((queue) => queue.id === rule.targetQueueId)?.name
            return (
              <div
                key={rule.id}
                className="flex items-center gap-2 rounded-lg border border-border px-2 py-1.5"
              >
                <Checkbox
                  checked={rule.enabled}
                  onCheckedChange={(checked) =>
                    void window.plexo.updateCategoryRule(rule.id, { enabled: checked === true })
                  }
                />
                <div className="min-w-0 flex-1">
                  <div className="truncate font-sans text-[12px] font-medium">{rule.name}</div>
                  <div className="truncate font-mono text-[10.5px] text-muted-foreground">
                    {rule.matchType === 'extension' ? 'ext' : 'pattern'}: {rule.pattern} →{' '}
                    {queueName ?? 'deleted queue'}
                  </div>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  disabled={index === 0}
                  onClick={() => handleMove(rule.id, -1)}
                  aria-label="Move rule up"
                >
                  <ArrowUp />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  disabled={index === sorted.length - 1}
                  onClick={() => handleMove(rule.id, 1)}
                  aria-label="Move rule down"
                >
                  <ArrowDown />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => openEdit(rule)}
                  aria-label="Edit rule"
                >
                  <Pencil />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => void window.plexo.removeCategoryRule(rule.id)}
                  aria-label="Delete rule"
                >
                  <Trash2 />
                </Button>
              </div>
            )
          })}
        </div>
      )}

      <CategoryRuleDialog
        key={editingRule?.id ?? 'new'}
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        queues={queues}
        editingRule={editingRule}
      />
    </div>
  )
}

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

        <CategoryRulesSection />
      </div>

      <ScreenFooter>
        <div className="font-mono text-[11px] text-muted-foreground">
          Applies to every download that doesn&apos;t set its own limit
        </div>
      </ScreenFooter>
    </div>
  )
}
