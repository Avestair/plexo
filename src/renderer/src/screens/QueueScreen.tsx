import type { Queue, QueueStatus } from '@shared/types'
import { useState } from 'react'
import { ScreenFooter } from '../components/ScreenFooter'
import { Badge } from '../components/ui/badge'
import { Button } from '../components/ui/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger
} from '../components/ui/dialog'
import { Input } from '../components/ui/input'
import { useAppStore } from '../store/useAppStore'

const STATUS_LABEL: Record<QueueStatus, string> = {
  idle: 'Idle',
  active: 'Downloading',
  paused: 'Paused',
  completed: 'Completed'
}

function statusBadgeVariant(status: QueueStatus): 'default' | 'secondary' | 'outline' {
  if (status === 'active') return 'default'
  if (status === 'completed') return 'secondary'
  return 'outline'
}

function QueueRow({
  queue,
  onOpen,
  onDelete
}: {
  queue: Queue
  onOpen: () => void
  onDelete: () => void
}): React.JSX.Element {
  const completedCount = queue.items.filter((item) => item.status === 'completed').length

  return (
    <button
      type="button"
      onClick={onOpen}
      className="group/queue-row flex w-full flex-col gap-2.5 rounded-[10px] border-[0.5px] border-border bg-card p-[13px_14px] text-left transition-colors hover:bg-muted/60"
    >
      <div className="flex items-center gap-2.5">
        <div className="min-w-0 flex-1">
          <div className="truncate font-sans text-[13px] font-semibold">{queue.name}</div>
          {queue.description && (
            <div className="mt-0.5 truncate font-sans text-[11.5px] text-muted-foreground">
              {queue.description}
            </div>
          )}
        </div>
        <Badge variant={statusBadgeVariant(queue.status)}>{STATUS_LABEL[queue.status]}</Badge>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="opacity-0 group-hover/queue-row:opacity-100"
          onClick={(event) => {
            event.stopPropagation()
            onDelete()
          }}
        >
          Delete
        </Button>
      </div>
      <div className="flex items-center gap-2.5">
        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
          <div
            className="h-full rounded-full bg-primary transition-[width]"
            style={{ width: `${queue.totalProgress}%` }}
          />
        </div>
        <div className="shrink-0 font-mono text-[10.5px] tabular-nums text-muted-foreground">
          {completedCount}/{queue.items.length} · {queue.totalProgress}%
        </div>
      </div>
    </button>
  )
}

export function QueueScreen({
  onSelectQueue
}: {
  onSelectQueue: (queueId: string) => void
}): React.JSX.Element {
  const queues = useAppStore((store) => store.queues)
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [creating, setCreating] = useState(false)

  const handleCreate = async (): Promise<void> => {
    const trimmed = name.trim()
    if (!trimmed || creating) return
    setCreating(true)
    try {
      const queue = await window.plexo.createQueue(trimmed, description.trim() || undefined)
      setOpen(false)
      setName('')
      setDescription('')
      onSelectQueue(queue.id)
    } finally {
      setCreating(false)
    }
  }

  const handleDelete = (queueId: string): void => {
    void window.plexo.deleteQueue(queueId)
  }

  return (
    <div className="flex h-full flex-col bg-background">
      <div className="flex items-center gap-2.5 px-5 pt-5 pb-3">
        <h1 className="font-sans text-[15px] font-bold">Queues</h1>
        <div className="flex-1" />
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger render={<Button type="button" size="sm" />}>New Queue</DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>New queue</DialogTitle>
            </DialogHeader>
            <div className="flex flex-col gap-2.5">
              <Input
                autoFocus
                placeholder="Queue name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void handleCreate()
                }}
              />
              <Input
                placeholder="Description (optional)"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
              />
            </div>
            <DialogFooter>
              <DialogClose render={<Button type="button" variant="outline" />}>Cancel</DialogClose>
              <Button type="button" disabled={!name.trim() || creating} onClick={handleCreate}>
                Create
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-5">
        {queues.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-1.5 text-center">
            <div className="font-sans text-[13px] font-medium text-foreground">No queues yet</div>
            <div className="max-w-64 font-sans text-[12px] text-muted-foreground">
              Create a queue to download a list of URLs one after another.
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {queues.map((queue) => (
              <QueueRow
                key={queue.id}
                queue={queue}
                onOpen={() => onSelectQueue(queue.id)}
                onDelete={() => handleDelete(queue.id)}
              />
            ))}
          </div>
        )}
      </div>

      <ScreenFooter>
        <div className="font-mono text-[11px] text-muted-foreground">
          {queues.length} {queues.length === 1 ? 'queue' : 'queues'}
        </div>
      </ScreenFooter>
    </div>
  )
}
