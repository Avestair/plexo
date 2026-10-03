import { useAppStore } from '../store/useAppStore'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from './ui/alert-dialog'
import { useNow } from '../hooks/useNow'

const ACTION_LABEL: Record<'sleep' | 'hibernate' | 'shutdown', string> = {
  sleep: 'put the system to sleep',
  hibernate: 'hibernate the system',
  shutdown: 'shut the system down'
}

/** A prominent, impossible-to-miss confirmation for a queue's completed-download system action —
 * pushed live from the main process (see systemActionManager.ts), never polled. Only ever one
 * countdown is shown at a time (the oldest), the same way the app surfaces one current download
 * at a time; a second one queues behind it once the first is resolved. */
export function SystemActionConfirmDialog(): React.JSX.Element | null {
  const pending = useAppStore((store) => store.pendingSystemActions)
  const now = useNow(1000)
  const current = pending[0]

  if (!current) return null

  const secondsLeft = Math.max(0, Math.ceil((current.fireAt - now) / 1000))
  const label = ACTION_LABEL[current.action as 'sleep' | 'hibernate' | 'shutdown'] ?? current.action

  return (
    <AlertDialog open onOpenChange={() => {}}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>&ldquo;{current.queueName}&rdquo; finished</AlertDialogTitle>
          <AlertDialogDescription>
            Plexo will {label} in {secondsLeft}s. Cancel now to keep it from running.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={() => void window.plexo.cancelSystemAction(current.queueId)}>
            Cancel
          </AlertDialogCancel>
          <AlertDialogAction onClick={() => void window.plexo.confirmSystemAction(current.queueId)}>
            Do it now
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
