import type {
  BandwidthResetSchedule,
  BatchAddResult,
  QueueAction,
  QueueBandwidthSettings,
  QueueBandwidthUsage,
  QueueItem,
  QueueItemStatus,
  SystemAction
} from '@shared/types'
import { cn } from 'cn'
import { ArrowLeft, ArrowDown, ArrowUp, GripVertical, Pause, Play, Trash2, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { ChecksumField } from '../components/ChecksumField'
import { ChecksumStatusBanner } from '../components/ChecksumStatusBanner'
import { ScreenFooter } from '../components/ScreenFooter'
import { Badge } from '../components/ui/badge'
import { Button } from '../components/ui/button'
import { Checkbox } from '../components/ui/checkbox'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '../components/ui/dialog'
import { Input } from '../components/ui/input'
import { useNow } from '../hooks/useNow'
import { useAppStore } from '../store/useAppStore'
import {
  checksumFieldError,
  emptyChecksumField,
  resolveChecksumField,
  type ChecksumFieldState
} from '../utils/checksumField'
import { formatBytes, formatCountdown, formatDuration, formatSpeed } from '../utils/format'
import { nextScheduleAction } from '../utils/schedule'

/** 90%, matching BandwidthManager.NEAR_CAP_RATIO — kept in sync by hand since the renderer
 * doesn't import main-process code; it's a display threshold only, not an enforcement one. */
const NEAR_CAP_RATIO = 0.9

const RESET_SCHEDULE_LABEL: Record<BandwidthResetSchedule, string> = {
  daily: 'Daily',
  weekly: 'Weekly',
  monthly: 'Monthly',
  never: 'Never'
}

/** The per-queue bandwidth settings: a speed override (or "use the global limit"), a total
 * traffic cap, and its reset schedule — same local-draft-until-saved shape as SystemActionForm
 * above, keyed by the parent on queueId. */
function BandwidthForm({
  queueId,
  existing,
  usage
}: {
  queueId: string
  existing: QueueBandwidthSettings | undefined
  usage: QueueBandwidthUsage | undefined
}): React.JSX.Element {
  const [useGlobalLimit, setUseGlobalLimit] = useState(() => existing?.useGlobalLimit ?? true)
  const [speedLimitKBs, setSpeedLimitKBs] = useState(() =>
    existing?.limit?.maxSpeedBytesPerSec
      ? String(Math.round(existing.limit.maxSpeedBytesPerSec / 1024))
      : ''
  )
  const [trafficCapGB, setTrafficCapGB] = useState(() =>
    existing?.limit?.maxTrafficBytes ? String(existing.limit.maxTrafficBytes / 1024 ** 3) : ''
  )
  const [resetSchedule, setResetSchedule] = useState<BandwidthResetSchedule>(
    () => existing?.limit?.resetSchedule ?? 'never'
  )

  const handleSave = async (): Promise<void> => {
    const speedKBs = Number(speedLimitKBs)
    const capGB = Number(trafficCapGB)
    const maxSpeedBytesPerSec =
      Number.isFinite(speedKBs) && speedKBs > 0 ? Math.round(speedKBs * 1024) : undefined
    const maxTrafficBytes =
      Number.isFinite(capGB) && capGB > 0 ? Math.round(capGB * 1024 ** 3) : undefined
    const patch: Omit<QueueBandwidthSettings, 'queueId'> = {
      useGlobalLimit,
      limit:
        maxSpeedBytesPerSec || maxTrafficBytes
          ? { usedBytes: 0, maxSpeedBytesPerSec, maxTrafficBytes, resetSchedule }
          : undefined
    }
    await window.plexo.setQueueBandwidthLimit(queueId, patch)
  }

  const handleRemove = async (): Promise<void> => {
    setUseGlobalLimit(true)
    setSpeedLimitKBs('')
    setTrafficCapGB('')
    setResetSchedule('never')
    await window.plexo.removeQueueBandwidthLimit(queueId)
  }

  const cap = usage?.maxTrafficBytes
  const ratio = cap ? Math.min(1, (usage?.usedBytes ?? 0) / cap) : 0
  const nearCap = !!cap && !usage?.capReached && ratio >= NEAR_CAP_RATIO

  return (
    <div className="flex flex-col gap-2.5 rounded-[10px] border-[0.5px] border-border bg-card p-[11px_13px]">
      <span className="font-sans text-[11.5px] font-medium text-muted-foreground">Bandwidth</span>

      <label className="flex items-center gap-2">
        <Checkbox
          checked={useGlobalLimit}
          onCheckedChange={(checked) => setUseGlobalLimit(checked === true)}
        />
        <span className="font-sans text-[11.5px] text-muted-foreground">
          Use the global speed limit
        </span>
      </label>

      {!useGlobalLimit && (
        <div className="flex items-center gap-2">
          <span className="font-sans text-[11.5px] text-muted-foreground">Max speed</span>
          <Input
            type="number"
            min={0}
            placeholder="Unlimited"
            value={speedLimitKBs}
            onChange={(event) => setSpeedLimitKBs(event.target.value)}
            className="h-7 w-24"
          />
          <span className="font-sans text-[11.5px] text-muted-foreground">KB/s</span>
        </div>
      )}

      <div className="flex items-center gap-2">
        <span className="font-sans text-[11.5px] text-muted-foreground">Traffic cap</span>
        <Input
          type="number"
          min={0}
          placeholder="Unlimited"
          value={trafficCapGB}
          onChange={(event) => setTrafficCapGB(event.target.value)}
          className="h-7 w-24"
        />
        <span className="font-sans text-[11.5px] text-muted-foreground">GB, resets</span>
        <select
          value={resetSchedule}
          onChange={(event) => setResetSchedule(event.target.value as BandwidthResetSchedule)}
          className="h-7 rounded-lg border border-input bg-transparent px-2 text-[12px] outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
        >
          {(Object.keys(RESET_SCHEDULE_LABEL) as BandwidthResetSchedule[]).map((value) => (
            <option key={value} value={value}>
              {RESET_SCHEDULE_LABEL[value]}
            </option>
          ))}
        </select>
      </div>

      {!!cap && (
        <div className="flex flex-col gap-1">
          <div className="h-1.5 overflow-hidden rounded-full bg-muted">
            <div
              className={`h-full rounded-full transition-[width] ${
                usage?.capReached
                  ? 'bg-destructive'
                  : nearCap
                    ? 'bg-[var(--color-usb)]'
                    : 'bg-primary'
              }`}
              style={{ width: `${Math.round(ratio * 100)}%` }}
            />
          </div>
          <div className="font-mono text-[10.5px] tabular-nums text-muted-foreground">
            {formatBytes(usage?.usedBytes ?? 0)} / {formatBytes(cap)} used
            {usage?.capReached && ' · Cap reached — new downloads in this queue are on hold'}
            {!usage?.capReached && nearCap && ' · Approaching cap'}
          </div>
        </div>
      )}

      <div className="flex items-center gap-2">
        <Button type="button" size="sm" onClick={handleSave}>
          Save
        </Button>
        {existing?.limit && (
          <Button type="button" size="sm" variant="outline" onClick={handleRemove}>
            Remove
          </Button>
        )}
      </div>
    </div>
  )
}

const SYSTEM_ACTION_LABEL: Record<SystemAction, string> = {
  none: 'Do nothing',
  sleep: 'Sleep',
  hibernate: 'Hibernate',
  shutdown: 'Shut down'
}

const DEFAULT_COUNTDOWN_SECONDS = 30

/** The per-queue post-download system action setting: none/sleep/hibernate/shutdown, an optional
 * confirm-before countdown, and a save/remove pair — same local-draft-until-saved shape as
 * ScheduleScreen's ScheduleForm, keyed by the parent on queueId so switching queues remounts it
 * instead of needing an effect to re-sync. */
function SystemActionForm({
  queueId,
  existing
}: {
  queueId: string
  existing: QueueAction | undefined
}): React.JSX.Element {
  const [action, setAction] = useState<SystemAction>(() => existing?.action ?? 'none')
  const [confirmBefore, setConfirmBefore] = useState(() => existing?.confirmBefore ?? true)
  const [countdownSeconds, setCountdownSeconds] = useState(() =>
    String(existing?.countdownSeconds ?? DEFAULT_COUNTDOWN_SECONDS)
  )

  const handleSave = async (): Promise<void> => {
    const seconds = Number(countdownSeconds)
    const patch: Omit<QueueAction, 'queueId'> = {
      action,
      confirmBefore,
      countdownSeconds: Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds) : undefined
    }
    await window.plexo.setSystemAction(queueId, patch)
  }

  const handleRemove = async (): Promise<void> => {
    setAction('none')
    await window.plexo.removeSystemAction(queueId)
  }

  return (
    <div className="flex flex-col gap-2.5 rounded-[10px] border-[0.5px] border-border bg-card p-[11px_13px]">
      <div className="flex items-center gap-2.5">
        <span className="font-sans text-[11.5px] font-medium text-muted-foreground">
          When this queue finishes
        </span>
        <select
          value={action}
          onChange={(event) => setAction(event.target.value as SystemAction)}
          className="h-7 rounded-lg border border-input bg-transparent px-2 text-[12px] outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
        >
          {(Object.keys(SYSTEM_ACTION_LABEL) as SystemAction[]).map((value) => (
            <option key={value} value={value}>
              {SYSTEM_ACTION_LABEL[value]}
            </option>
          ))}
        </select>
      </div>

      {action !== 'none' && (
        <>
          <label className="flex items-center gap-2">
            <Checkbox
              checked={confirmBefore}
              onCheckedChange={(checked) => setConfirmBefore(checked === true)}
            />
            <span className="font-sans text-[11.5px] text-muted-foreground">
              Ask for confirmation first, with a
            </span>
            <Input
              type="number"
              min={1}
              disabled={!confirmBefore}
              value={countdownSeconds}
              onChange={(event) => setCountdownSeconds(event.target.value)}
              className="h-7 w-16"
            />
            <span className="font-sans text-[11.5px] text-muted-foreground">second countdown</span>
          </label>
          {!confirmBefore && (
            <div className="font-sans text-[11px] text-destructive">
              Runs immediately, with no chance to cancel.
            </div>
          )}
        </>
      )}

      <div className="flex items-center gap-2">
        <Button type="button" size="sm" onClick={handleSave}>
          Save
        </Button>
        {existing && existing.action !== 'none' && (
          <Button type="button" size="sm" variant="outline" onClick={handleRemove}>
            Remove
          </Button>
        )}
      </div>
    </div>
  )
}

/**
 * Paste-many-URLs-at-once import, plus an "Import from file…" button that reads a local text
 * file (one line per URL, same as pasting) through the main process — the renderer has no fs
 * access of its own. Validation/dedup happens in QueueManager.addDownloads (see its doc for the
 * exact policy); this only shows what came back.
 */
function BatchImportDialog({
  queueId,
  open,
  onOpenChange
}: {
  queueId: string
  open: boolean
  onOpenChange: (open: boolean) => void
}): React.JSX.Element {
  const [text, setText] = useState('')
  const [importing, setImporting] = useState(false)
  const [result, setResult] = useState<BatchAddResult | null>(null)
  const [fileError, setFileError] = useState<string | null>(null)

  const handleImportFile = async (): Promise<void> => {
    setFileError(null)
    try {
      const content = await window.plexo.chooseTextFile()
      if (content === null) return
      setText((previous) => (previous.trim() ? `${previous}\n${content}` : content))
    } catch {
      setFileError('Could not read that file.')
    }
  }

  const handleAdd = async (): Promise<void> => {
    if (!text.trim() || importing) return
    setImporting(true)
    setResult(null)
    try {
      const outcome = await window.plexo.addQueueDownloads(queueId, text.split('\n'))
      setResult(outcome)
      if (outcome.added.length > 0) setText('')
    } finally {
      setImporting(false)
    }
  }

  const handleOpenChange = (nextOpen: boolean): void => {
    if (!nextOpen) {
      setText('')
      setResult(null)
      setFileError(null)
    }
    onOpenChange(nextOpen)
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add multiple downloads</DialogTitle>
          <DialogDescription>
            One URL per line. Blank lines are ignored; anything that isn&apos;t a usable link is
            reported below instead of being added.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-2.5">
          <textarea
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder={'https://example.com/a.zip\nhttps://example.com/b.zip'}
            rows={8}
            className="w-full resize-y rounded-lg border border-input bg-transparent px-2.5 py-1.5 font-mono text-[12px] text-foreground outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="self-start"
            onClick={handleImportFile}
          >
            Import from file…
          </Button>
          {fileError && <div className="font-sans text-[11px] text-destructive">{fileError}</div>}
          {result && (
            <div className="flex flex-col gap-1.5 rounded-lg border border-border bg-muted/40 p-2.5">
              <div className="font-sans text-[11.5px] font-medium">
                {result.added.length} added
                {result.skipped.length > 0 && `, ${result.skipped.length} skipped`}
              </div>
              {result.skipped.length > 0 && (
                <div className="flex max-h-24 flex-col gap-0.5 overflow-y-auto">
                  {result.skipped.map((entry, index) => (
                    <div
                      key={index}
                      className="truncate font-mono text-[10.5px] text-muted-foreground"
                    >
                      {entry.reason === 'invalid' ? 'Not a usable link: ' : 'Already queued: '}
                      {entry.url}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
        <DialogFooter>
          <DialogClose render={<Button type="button" variant="outline" />}>Close</DialogClose>
          <Button type="button" disabled={!text.trim() || importing} onClick={handleAdd}>
            {importing ? 'Adding…' : 'Add all'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

const ITEM_STATUS_LABEL: Record<QueueItemStatus, string> = {
  pending: 'Queued',
  downloading: 'Downloading',
  paused: 'Paused',
  completed: 'Completed',
  failed: 'Failed'
}

function itemBadgeVariant(
  status: QueueItemStatus
): 'default' | 'secondary' | 'outline' | 'destructive' {
  if (status === 'downloading') return 'default'
  if (status === 'completed') return 'secondary'
  if (status === 'failed') return 'destructive'
  return 'outline'
}

function QueueItemRow({
  queueId,
  item,
  isFirst,
  isLast,
  onMove,
  isDragging,
  onDragStart,
  onDragEnd,
  onDropOnto
}: {
  queueId: string
  item: QueueItem
  isFirst: boolean
  isLast: boolean
  onMove: (direction: -1 | 1) => void
  /** Drag-and-drop reordering — an addition alongside the up/down buttons above, not a
   * replacement: HTML5 drag events aren't reachable by keyboard, so the buttons (and a future
   * screen reader's view of them) stay the only way to reorder without a mouse. Native HTML5
   * drag/drop (draggable + dragstart/dragover/drop) rather than a library — nothing in
   * package.json already covers it, and this list is small enough not to need one. */
  isDragging: boolean
  onDragStart: () => void
  onDragEnd: () => void
  onDropOnto: () => void
}): React.JSX.Element {
  const canPause = item.status === 'pending' || item.status === 'downloading'
  const canResume = item.status === 'paused'
  const canCancel =
    item.status === 'pending' || item.status === 'downloading' || item.status === 'paused'

  return (
    <div
      draggable
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = 'move'
        // Required by Firefox for a drag to start at all; the actual reorder is driven by
        // onDragStart/onDropOnto's closures below, not by reading this back out.
        event.dataTransfer.setData('text/plain', item.id)
        onDragStart()
      }}
      onDragEnd={onDragEnd}
      onDragOver={(event) => {
        event.preventDefault()
        event.dataTransfer.dropEffect = 'move'
      }}
      onDrop={(event) => {
        event.preventDefault()
        onDropOnto()
      }}
      className={cn(
        'flex flex-col gap-2 rounded-[10px] border-[0.5px] border-border bg-card p-[11px_13px] transition-opacity',
        isDragging && 'opacity-40'
      )}
    >
      <div className="flex items-center gap-2.5">
        <GripVertical
          aria-hidden="true"
          className="size-4 shrink-0 cursor-grab text-muted-foreground"
        />
        <div className="min-w-0 flex-1">
          <div className="truncate font-sans text-[12.5px] font-medium">{item.fileName}</div>
          <div className="truncate font-mono text-[10.5px] text-muted-foreground">{item.url}</div>
        </div>
        <Badge variant={itemBadgeVariant(item.status)}>{ITEM_STATUS_LABEL[item.status]}</Badge>
      </div>

      {(item.status === 'downloading' ||
        item.status === 'paused' ||
        item.status === 'completed') && (
        <div className="h-1.5 overflow-hidden rounded-full bg-muted">
          <div
            className="h-full rounded-full bg-primary transition-[width]"
            style={{ width: `${item.progress}%` }}
          />
        </div>
      )}

      {item.error && <div className="font-sans text-[11px] text-destructive">{item.error}</div>}

      {item.checksumStatus && (
        <ChecksumStatusBanner
          status={item.checksumStatus}
          expected={item.expectedChecksum}
          computedHex={item.checksumComputedHex}
        />
      )}

      <div className="flex items-center gap-2.5">
        <div className="flex-1 font-mono text-[10.5px] tabular-nums text-muted-foreground">
          {item.size > 0
            ? `${formatBytes(item.downloadedSize)} / ${formatBytes(item.size)}`
            : formatBytes(item.downloadedSize)}
          {item.status === 'downloading' && (
            <>
              {' · '}
              {formatSpeed(item.speedBytesPerSec)}
              {item.timeRemainingSec > 0 && ` · ${formatDuration(item.timeRemainingSec)} left`}
            </>
          )}
        </div>

        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          disabled={isFirst}
          onClick={() => onMove(-1)}
          aria-label="Move up"
        >
          <ArrowUp />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          disabled={isLast}
          onClick={() => onMove(1)}
          aria-label="Move down"
        >
          <ArrowDown />
        </Button>
        {canPause && (
          <Button
            type="button"
            variant="outline"
            size="icon-sm"
            onClick={() => void window.plexo.pauseQueueItem(queueId, item.id)}
            aria-label="Pause"
          >
            <Pause />
          </Button>
        )}
        {canResume && (
          <Button
            type="button"
            variant="outline"
            size="icon-sm"
            onClick={() => void window.plexo.resumeQueueItem(queueId, item.id)}
            aria-label="Resume"
          >
            <Play />
          </Button>
        )}
        {canCancel && (
          <Button
            type="button"
            variant="outline"
            size="icon-sm"
            onClick={() => void window.plexo.cancelQueueItem(queueId, item.id)}
            aria-label="Cancel"
          >
            <X />
          </Button>
        )}
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={() => void window.plexo.removeQueueDownload(queueId, item.id)}
          aria-label="Remove from queue"
        >
          <Trash2 />
        </Button>
      </div>
    </div>
  )
}

export function QueueDetailScreen({
  queueId,
  onBack
}: {
  queueId: string
  onBack: () => void
}): React.JSX.Element {
  const queue = useAppStore((store) => store.queues.find((entry) => entry.id === queueId))
  const schedule = useAppStore((store) =>
    store.schedules.find((entry) => entry.queueId === queueId)
  )
  const systemAction = useAppStore((store) =>
    store.systemActions.find((entry) => entry.queueId === queueId)
  )
  const bandwidthUsage = useAppStore((store) =>
    store.bandwidthUsage.find((entry) => entry.queueId === queueId)
  )
  const [bandwidthSettings, setBandwidthSettings] = useState<QueueBandwidthSettings | null>(null)
  useEffect(() => {
    let disposed = false
    void window.plexo.getQueueBandwidthLimit(queueId).then((settings) => {
      if (!disposed) setBandwidthSettings(settings)
    })
    return () => {
      disposed = true
    }
  }, [queueId])
  const now = useNow()
  const [url, setUrl] = useState('')
  const [renaming, setRenaming] = useState(false)
  const [nameDraft, setNameDraft] = useState(queue?.name ?? '')
  const [adding, setAdding] = useState(false)
  const [addError, setAddError] = useState<string | null>(null)
  const [batchOpen, setBatchOpen] = useState(false)
  const [checksumField, setChecksumField] = useState<ChecksumFieldState>(emptyChecksumField)
  const [draggedItemId, setDraggedItemId] = useState<string | null>(null)

  if (!queue) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 bg-background">
        <div className="font-sans text-[13px] text-muted-foreground">This queue was removed.</div>
        <Button type="button" variant="secondary" onClick={onBack}>
          Back to queues
        </Button>
      </div>
    )
  }

  const handleAdd = async (): Promise<void> => {
    const trimmed = url.trim()
    if (!trimmed || adding || checksumFieldError(checksumField)) return
    setAdding(true)
    setAddError(null)
    try {
      await window.plexo.addQueueDownload(
        queueId,
        trimmed,
        resolveChecksumField(checksumField) ?? undefined
      )
      setUrl('')
      setChecksumField(emptyChecksumField())
    } catch (error) {
      setAddError(error instanceof Error ? error.message : String(error))
    } finally {
      setAdding(false)
    }
  }

  const handleRename = (): void => {
    const trimmed = nameDraft.trim()
    if (trimmed && trimmed !== queue.name) void window.plexo.updateQueueName(queueId, trimmed)
    setRenaming(false)
  }

  const handleMove = (itemId: string, direction: -1 | 1): void => {
    const ids = queue.items.map((item) => item.id)
    const index = ids.indexOf(itemId)
    const swapWith = index + direction
    if (swapWith < 0 || swapWith >= ids.length) return
    ;[ids[index], ids[swapWith]] = [ids[swapWith], ids[index]]
    void window.plexo.reorderQueueItems(queueId, ids)
  }

  /** Drops whatever's being dragged just before `targetId` — the same reorderQueueItems IPC call
   * the up/down buttons use, so dragging never diverges from the keyboard-accessible path. */
  const handleDropOnto = (targetId: string): void => {
    const draggedId = draggedItemId
    setDraggedItemId(null)
    if (!draggedId || draggedId === targetId) return
    const ids = queue.items.map((item) => item.id)
    const fromIndex = ids.indexOf(draggedId)
    if (fromIndex === -1 || !ids.includes(targetId)) return
    ids.splice(fromIndex, 1)
    ids.splice(ids.indexOf(targetId), 0, draggedId)
    void window.plexo.reorderQueueItems(queueId, ids)
  }

  const scheduleAction = nextScheduleAction(schedule, queue.status)

  const completedIds = queue.items
    .filter((item) => item.status === 'completed')
    .map((item) => item.id)
  const canPauseQueue = queue.status === 'active'
  const canResumeQueue = queue.status === 'paused' || queue.status === 'idle'

  return (
    <div className="flex h-full flex-col bg-background">
      <div className="flex items-center gap-2.5 px-5 pt-5 pb-3">
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={onBack}
          aria-label="Back to queues"
        >
          <ArrowLeft />
        </Button>
        {renaming ? (
          <Input
            autoFocus
            value={nameDraft}
            onChange={(event) => setNameDraft(event.target.value)}
            onBlur={handleRename}
            onKeyDown={(event) => {
              if (event.key === 'Enter') handleRename()
              if (event.key === 'Escape') {
                setNameDraft(queue.name)
                setRenaming(false)
              }
            }}
            className="h-7 max-w-64"
          />
        ) : (
          <button
            type="button"
            className="truncate font-sans text-[15px] font-bold hover:underline"
            onClick={() => {
              setNameDraft(queue.name)
              setRenaming(true)
            }}
          >
            {queue.name}
          </button>
        )}
        {scheduleAction && (
          <Badge variant="outline">
            {scheduleAction.kind === 'start' ? 'Starts' : 'Pauses'} in{' '}
            {formatCountdown(scheduleAction.time - now)}
          </Badge>
        )}
        {queue.capReached && (
          // Deliberately distinct from the paused state below: this queue is still 'active',
          // just not allowed to start anything new until its traffic cap resets.
          <Badge variant="destructive">Traffic cap reached</Badge>
        )}
        <div className="flex-1" />
        {canResumeQueue && (
          <Button type="button" size="sm" onClick={() => void window.plexo.resumeQueue(queueId)}>
            Start queue
          </Button>
        )}
        {canPauseQueue && (
          <Button
            type="button"
            size="sm"
            variant="secondary"
            onClick={() => void window.plexo.pauseQueue(queueId)}
          >
            Pause queue
          </Button>
        )}
      </div>

      <div className="flex items-center gap-2 px-5 pb-3">
        <Input
          placeholder="Paste a download URL and press Enter"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void handleAdd()
          }}
        />
        <Button
          type="button"
          disabled={!url.trim() || adding || !!checksumFieldError(checksumField)}
          onClick={handleAdd}
        >
          Add
        </Button>
        <Button type="button" variant="outline" onClick={() => setBatchOpen(true)}>
          Add multiple…
        </Button>
      </div>
      <div className="px-5 pb-3">
        <ChecksumField state={checksumField} onChange={setChecksumField} />
      </div>
      {addError && (
        <div className="px-5 pb-3 font-sans text-[11px] text-destructive">{addError}</div>
      )}
      <BatchImportDialog queueId={queueId} open={batchOpen} onOpenChange={setBatchOpen} />

      <div className="flex flex-col gap-3 px-5 pb-3">
        <SystemActionForm
          key={`${queueId}:${systemAction?.action ?? 'none'}`}
          queueId={queueId}
          existing={systemAction}
        />
        <BandwidthForm
          key={`${queueId}:${bandwidthSettings ? 'loaded' : 'loading'}`}
          queueId={queueId}
          existing={bandwidthSettings ?? undefined}
          usage={bandwidthUsage}
        />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-5">
        {queue.items.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-1.5 text-center">
            <div className="font-sans text-[13px] font-medium text-foreground">
              No downloads in this queue yet
            </div>
            <div className="max-w-64 font-sans text-[12px] text-muted-foreground">
              Add a URL above to get started.
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {queue.items.map((item, index) => (
              <QueueItemRow
                key={item.id}
                queueId={queueId}
                item={item}
                isFirst={index === 0}
                isLast={index === queue.items.length - 1}
                onMove={(direction) => handleMove(item.id, direction)}
                isDragging={draggedItemId === item.id}
                onDragStart={() => setDraggedItemId(item.id)}
                onDragEnd={() => setDraggedItemId(null)}
                onDropOnto={() => handleDropOnto(item.id)}
              />
            ))}
          </div>
        )}
      </div>

      <ScreenFooter>
        <div className="font-mono text-[11px] text-muted-foreground">
          {queue.items.length} {queue.items.length === 1 ? 'item' : 'items'} · {queue.totalProgress}
          %
        </div>
        <div className="flex-1" />
        <Button
          type="button"
          variant="secondary"
          disabled={completedIds.length === 0}
          onClick={() => {
            for (const id of completedIds) void window.plexo.removeQueueDownload(queueId, id)
          }}
        >
          Delete completed
        </Button>
      </ScreenFooter>
    </div>
  )
}
