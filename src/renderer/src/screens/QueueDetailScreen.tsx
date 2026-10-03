import type { QueueItem, QueueItemStatus } from '@shared/types'
import { ArrowLeft, ArrowDown, ArrowUp, Pause, Play, Trash2, X } from 'lucide-react'
import { useState } from 'react'
import { ScreenFooter } from '../components/ScreenFooter'
import { Badge } from '../components/ui/badge'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { useAppStore } from '../store/useAppStore'
import { formatBytes, formatDuration, formatSpeed } from '../utils/format'

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
  onMove
}: {
  queueId: string
  item: QueueItem
  isFirst: boolean
  isLast: boolean
  onMove: (direction: -1 | 1) => void
}): React.JSX.Element {
  const canPause = item.status === 'pending' || item.status === 'downloading'
  const canResume = item.status === 'paused'
  const canCancel =
    item.status === 'pending' || item.status === 'downloading' || item.status === 'paused'

  return (
    <div className="flex flex-col gap-2 rounded-[10px] border-[0.5px] border-border bg-card p-[11px_13px]">
      <div className="flex items-center gap-2.5">
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
  const [url, setUrl] = useState('')
  const [renaming, setRenaming] = useState(false)
  const [nameDraft, setNameDraft] = useState(queue?.name ?? '')
  const [adding, setAdding] = useState(false)
  const [addError, setAddError] = useState<string | null>(null)

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
    if (!trimmed || adding) return
    setAdding(true)
    setAddError(null)
    try {
      await window.plexo.addQueueDownload(queueId, trimmed)
      setUrl('')
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
        <Button type="button" disabled={!url.trim() || adding} onClick={handleAdd}>
          Add
        </Button>
      </div>
      {addError && (
        <div className="px-5 pb-3 font-sans text-[11px] text-destructive">{addError}</div>
      )}

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
