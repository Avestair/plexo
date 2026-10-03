import type { Queue, QueueSchedule, WeeklyRepeat } from '@shared/types'
import { useState } from 'react'
import { ScreenFooter } from '../components/ScreenFooter'
import { Badge } from '../components/ui/badge'
import { Button } from '../components/ui/button'
import { Checkbox } from '../components/ui/checkbox'
import { Input } from '../components/ui/input'
import { ToggleGroup, ToggleGroupItem } from '../components/ui/toggle-group'
import { useNow } from '../hooks/useNow'
import { useAppStore } from '../store/useAppStore'
import { formatCountdown } from '../utils/format'
import { nextScheduleAction } from '../utils/schedule'

type RepeatMode = 'none' | 'daily' | 'weekly'

const DEFAULT_WEEKLY: WeeklyRepeat = {
  monday: false,
  tuesday: false,
  wednesday: false,
  thursday: false,
  friday: false,
  saturday: false,
  sunday: false
}

const WEEKDAY_ORDER: { key: keyof WeeklyRepeat; label: string }[] = [
  { key: 'monday', label: 'Mon' },
  { key: 'tuesday', label: 'Tue' },
  { key: 'wednesday', label: 'Wed' },
  { key: 'thursday', label: 'Thu' },
  { key: 'friday', label: 'Fri' },
  { key: 'saturday', label: 'Sat' },
  { key: 'sunday', label: 'Sun' }
]

/** epoch ms -> the local "yyyy-MM-ddTHH:mm" an <input type="datetime-local"> wants. */
function toLocalInputValue(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return ''
  const date = new Date(ms)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
    date.getHours()
  )}:${pad(date.getMinutes())}`
}

/** The reverse of toLocalInputValue — parsed as local time, same as the input displays it. */
function fromLocalInputValue(value: string): number | null {
  if (!value) return null
  const time = new Date(value).getTime()
  return Number.isNaN(time) ? null : time
}

function repeatModeOf(schedule: QueueSchedule | undefined): RepeatMode {
  if (schedule?.repeatDaily) return 'daily'
  if (schedule?.repeatWeekly && WEEKDAY_ORDER.some(({ key }) => schedule.repeatWeekly?.[key])) {
    return 'weekly'
  }
  return 'none'
}

/** The schedule form for one queue — its local draft state is initialized once from `existing`
 * and from then on is the source of truth until saved. It's keyed by the parent (on the queue id
 * and on whether a schedule exists for it) so switching queues, or a save/remove changing whether
 * one exists, remounts this component instead of needing an effect to re-sync state pulled in
 * from props. */
function ScheduleForm({
  queueId,
  queueStatus,
  existing
}: {
  queueId: string
  queueStatus: Queue['status']
  existing: QueueSchedule | undefined
}): React.JSX.Element {
  const now = useNow()
  const [startValue, setStartValue] = useState(() => toLocalInputValue(existing?.startTime ?? null))
  const [sleepOn, setSleepOn] = useState(() => existing?.sleepTime != null)
  const [sleepValue, setSleepValue] = useState(() => toLocalInputValue(existing?.sleepTime ?? null))
  const [repeatMode, setRepeatMode] = useState<RepeatMode>(() => repeatModeOf(existing))
  const [weekly, setWeekly] = useState<WeeklyRepeat>(() => existing?.repeatWeekly ?? DEFAULT_WEEKLY)
  const [enabled, setEnabled] = useState(() => existing?.enabled ?? false)

  const action = nextScheduleAction(existing, queueStatus)

  const handleSave = async (): Promise<void> => {
    const startTime = fromLocalInputValue(startValue)
    const sleepTime = sleepOn ? fromLocalInputValue(sleepValue) : null
    const schedule: Omit<QueueSchedule, 'queueId'> = {
      startTime,
      sleepTime,
      repeatDaily: repeatMode === 'daily',
      repeatWeekly: repeatMode === 'weekly' ? weekly : DEFAULT_WEEKLY,
      enabled
    }
    await window.plexo.setSchedule(queueId, schedule)
  }

  const handleRemove = async (): Promise<void> => {
    await window.plexo.removeSchedule(queueId)
  }

  const handleRunNow = (): void => {
    // A manual override: starts the queue immediately without touching the schedule's own
    // timing, so the next scheduled start/pause still happens exactly when configured.
    void window.plexo.resumeQueue(queueId)
  }

  const toggleWeekday = (key: keyof WeeklyRepeat): void => {
    setWeekly((current) => ({ ...current, [key]: !current[key] }))
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 pb-5">
      {action && (
        <Badge variant="outline" className="self-start">
          {action.kind === 'start' ? 'Starts' : 'Pauses'} in {formatCountdown(action.time - now)}
        </Badge>
      )}

      <label className="flex flex-col gap-1.5">
        <span className="font-sans text-[11.5px] font-medium text-muted-foreground">
          Start time
        </span>
        <Input
          type="datetime-local"
          value={startValue}
          onChange={(event) => setStartValue(event.target.value)}
        />
      </label>

      <div className="flex flex-col gap-1.5">
        <label className="flex items-center gap-2">
          <Checkbox checked={sleepOn} onCheckedChange={(checked) => setSleepOn(checked === true)} />
          <span className="font-sans text-[11.5px] font-medium text-muted-foreground">
            Pause again at
          </span>
        </label>
        {sleepOn && (
          <Input
            type="datetime-local"
            value={sleepValue}
            onChange={(event) => setSleepValue(event.target.value)}
          />
        )}
      </div>

      <div className="flex flex-col gap-1.5">
        <span className="font-sans text-[11.5px] font-medium text-muted-foreground">Repeat</span>
        <ToggleGroup
          variant="pill"
          value={[repeatMode]}
          onValueChange={(value) => {
            const next = value[0]
            if (next) setRepeatMode(next as RepeatMode)
          }}
        >
          <ToggleGroupItem value="none">None</ToggleGroupItem>
          <ToggleGroupItem value="daily">Daily</ToggleGroupItem>
          <ToggleGroupItem value="weekly">Weekly</ToggleGroupItem>
        </ToggleGroup>
        {repeatMode === 'weekly' && (
          <div className="flex flex-wrap gap-2.5 pt-1">
            {WEEKDAY_ORDER.map(({ key, label }) => (
              <label key={key} className="flex items-center gap-1.5">
                <Checkbox checked={weekly[key]} onCheckedChange={() => toggleWeekday(key)} />
                <span className="font-sans text-[11.5px] text-foreground">{label}</span>
              </label>
            ))}
          </div>
        )}
      </div>

      <label className="flex items-center gap-2">
        <Checkbox checked={enabled} onCheckedChange={(checked) => setEnabled(checked === true)} />
        <span className="font-sans text-[11.5px] font-medium text-muted-foreground">Enabled</span>
      </label>

      <div className="flex items-center gap-2">
        <Button type="button" size="sm" onClick={handleSave}>
          Save schedule
        </Button>
        {existing && (
          <Button type="button" size="sm" variant="outline" onClick={handleRemove}>
            Remove schedule
          </Button>
        )}
        <div className="flex-1" />
        <Button
          type="button"
          size="sm"
          variant="secondary"
          disabled={queueStatus === 'active'}
          onClick={handleRunNow}
        >
          Run now
        </Button>
      </div>
    </div>
  )
}

export function ScheduleScreen(): React.JSX.Element {
  const queues = useAppStore((store) => store.queues)
  const schedules = useAppStore((store) => store.schedules)

  // Only ever set by the <select> below — if it names a queue that's gone (deleted elsewhere),
  // this falls back to the first queue instead, with no effect needed to "fix" the state.
  const [userSelectedQueueId, setUserSelectedQueueId] = useState<string | null>(null)
  const selectedQueueId =
    userSelectedQueueId && queues.some((queue) => queue.id === userSelectedQueueId)
      ? userSelectedQueueId
      : (queues[0]?.id ?? null)

  const selectedQueue = queues.find((queue) => queue.id === selectedQueueId)
  const existing = schedules.find((schedule) => schedule.queueId === selectedQueueId)
  const enabledCount = schedules.filter((schedule) => schedule.enabled).length

  return (
    <div className="flex h-full flex-col bg-background">
      <div className="flex items-center gap-2.5 px-5 pt-5 pb-3">
        <h1 className="font-sans text-[15px] font-bold">Schedule</h1>
      </div>

      {queues.length === 0 ? (
        <div className="flex h-full flex-col items-center justify-center gap-1.5 text-center">
          <div className="font-sans text-[13px] font-medium text-foreground">No queues yet</div>
          <div className="max-w-64 font-sans text-[12px] text-muted-foreground">
            Create a queue first, then schedule when it should run.
          </div>
        </div>
      ) : (
        <>
          <div className="px-5 pb-3">
            <label className="flex flex-col gap-1.5">
              <span className="font-sans text-[11.5px] font-medium text-muted-foreground">
                Queue
              </span>
              <select
                value={selectedQueueId ?? ''}
                onChange={(event) => setUserSelectedQueueId(event.target.value || null)}
                className="h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
              >
                {queues.map((queue) => (
                  <option key={queue.id} value={queue.id}>
                    {queue.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {selectedQueueId && selectedQueue && (
            <ScheduleForm
              key={`${selectedQueueId}:${existing ? 'scheduled' : 'unscheduled'}`}
              queueId={selectedQueueId}
              queueStatus={selectedQueue.status}
              existing={existing}
            />
          )}
        </>
      )}

      <ScreenFooter>
        <div className="font-mono text-[11px] text-muted-foreground">
          {enabledCount} active {enabledCount === 1 ? 'schedule' : 'schedules'}
        </div>
      </ScreenFooter>
    </div>
  )
}
