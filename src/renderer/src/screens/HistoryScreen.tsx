import type { HistoryEntry } from '@shared/types'
import { useMemo, useState } from 'react'
import { ScreenFooter } from '../components/ScreenFooter'
import { Badge } from '../components/ui/badge'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { useAppStore } from '../store/useAppStore'
import { formatBytes } from '../utils/format'

type StatusFilter = 'all' | HistoryEntry['status']

const STATUS_LABEL: Record<HistoryEntry['status'], string> = {
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled'
}

function statusBadgeVariant(
  status: HistoryEntry['status']
): 'secondary' | 'destructive' | 'outline' {
  if (status === 'completed') return 'secondary'
  if (status === 'failed') return 'destructive'
  return 'outline'
}

const selectClassName =
  'h-9 shrink-0 rounded-lg border border-input bg-transparent px-2 text-[12px] outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30'

/**
 * Every download that has ever reached a terminal state, ad-hoc or queue-driven, searchable by
 * file name or URL and filterable by status — see main/history/historyManager.ts for how entries
 * get here. Filtering happens client-side over the already-synced full list (see useHistory), the
 * same pattern SettingsScreen's CategoryRulesSection uses for its own list — history is capped at
 * a scale (1000 entries, see historyStorage.ts) small enough that this needs no virtualization and
 * no per-keystroke IPC round trip; history:search still exists on the IPC surface for anything
 * that isn't the renderer's own live-synced copy.
 */
export function HistoryScreen(): React.JSX.Element {
  const entries = useAppStore((store) => store.history)
  const [query, setQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return entries.filter((entry) => {
      if (statusFilter !== 'all' && entry.status !== statusFilter) return false
      if (!needle) return true
      return (
        entry.fileName.toLowerCase().includes(needle) || entry.url.toLowerCase().includes(needle)
      )
    })
  }, [entries, query, statusFilter])

  const handleClear = async (): Promise<void> => {
    await window.plexo.clearHistory()
  }

  return (
    <div className="flex h-full flex-col bg-background">
      <div className="flex items-center gap-2.5 px-5 pt-5 pb-3">
        <h1 className="font-sans text-[15px] font-bold">History</h1>
        <div className="flex-1" />
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={entries.length === 0}
          onClick={handleClear}
        >
          Clear history
        </Button>
      </div>

      <div className="flex items-center gap-2 px-5 pb-3">
        <Input
          placeholder="Search by file name or URL…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          className="flex-1"
        />
        <select
          value={statusFilter}
          onChange={(event) => setStatusFilter(event.target.value as StatusFilter)}
          className={selectClassName}
          aria-label="Filter by status"
        >
          <option value="all">All statuses</option>
          <option value="completed">Completed</option>
          <option value="failed">Failed</option>
          <option value="cancelled">Cancelled</option>
        </select>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-5">
        {filtered.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-1.5 text-center">
            <div className="font-sans text-[13px] font-medium text-foreground">
              {entries.length === 0 ? 'No downloads yet' : 'No matches'}
            </div>
            <div className="max-w-64 font-sans text-[12px] text-muted-foreground">
              {entries.length === 0
                ? 'Every download that finishes, fails, or is cancelled will show up here.'
                : 'Try a different search or status filter.'}
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {filtered.map((entry) => (
              <div
                key={entry.id}
                className="flex flex-col gap-1.5 rounded-[10px] border-[0.5px] border-border bg-card p-[11px_13px]"
              >
                <div className="flex items-center gap-2.5">
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-sans text-[12.5px] font-medium">
                      {entry.fileName}
                    </div>
                    <div className="truncate font-mono text-[10.5px] text-muted-foreground">
                      {entry.url}
                    </div>
                  </div>
                  <Badge variant={statusBadgeVariant(entry.status)}>
                    {STATUS_LABEL[entry.status]}
                  </Badge>
                </div>
                <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 font-mono text-[10.5px] text-muted-foreground">
                  <span>{formatBytes(entry.size)}</span>
                  <span>·</span>
                  <span>{new Date(entry.finishedAt).toLocaleString()}</span>
                  <span>·</span>
                  <span>
                    {entry.source === 'queue' ? (entry.queueName ?? 'a queue') : 'Ad-hoc'}
                  </span>
                  {entry.checksumStatus && entry.checksumStatus !== 'not_checked' && (
                    <>
                      <span>·</span>
                      <span
                        className={
                          entry.checksumStatus === 'mismatch'
                            ? 'font-bold text-destructive'
                            : undefined
                        }
                      >
                        checksum {entry.checksumStatus}
                      </span>
                    </>
                  )}
                </div>
                {entry.error && (
                  <div className="font-sans text-[11px] text-destructive">{entry.error}</div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      <ScreenFooter>
        <div className="font-mono text-[11px] text-muted-foreground">
          {filtered.length} of {entries.length} {entries.length === 1 ? 'entry' : 'entries'}
        </div>
      </ScreenFooter>
    </div>
  )
}
