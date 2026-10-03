import type { DownloadState } from '@shared/types'
import { useEffect, useState } from 'react'
import { TitleBar, type TitleBarStatus, type TitleBarView } from './components/TitleBar'
import { Alert, AlertDescription, AlertTitle } from './components/ui/alert'
import { Button } from './components/ui/button'
import { NetworkBindingDialog } from './components/NetworkBindingDialog'
import { SystemActionConfirmDialog } from './components/SystemActionConfirmDialog'
import { UpdateDialog } from './components/UpdateDialog'
import { TooltipProvider } from './components/ui/tooltip'
import { useBandwidth } from './hooks/useBandwidth'
import { useCategoryRules } from './hooks/useCategoryRules'
import { useClipboardDetection } from './hooks/useClipboardDetection'
import { useDownloadEvents } from './hooks/useDownloadEvents'
import { useHistory } from './hooks/useHistory'
import { useNetworkEvents } from './hooks/useNetworks'
import { useQueues } from './hooks/useQueues'
import { useSchedules } from './hooks/useSchedules'
import { useSystemActions } from './hooks/useSystemActions'
import { CompleteScreen } from './screens/CompleteScreen'
import { DownloadingScreen } from './screens/DownloadingScreen'
import { ErrorScreen } from './screens/ErrorScreen'
import { HistoryScreen } from './screens/HistoryScreen'
import { IdleScreen } from './screens/IdleScreen'
import { NoConnectionsScreen } from './screens/NoConnectionsScreen'
import { QueueDetailScreen } from './screens/QueueDetailScreen'
import { QueueScreen } from './screens/QueueScreen'
import { ScheduleScreen } from './screens/ScheduleScreen'
import { SettingsScreen } from './screens/SettingsScreen'
import { useAppStore } from './store/useAppStore'

function assertNever(status: never): never {
  throw new Error(`Unhandled download status: ${String(status)}`)
}

/** One screen + title-bar status per download.status — a switch with an assertNever default so
 * a new DownloadStatus value is a compile error here instead of silently falling into whichever
 * branch happened to be last. */
function renderDownload(
  download: DownloadState,
  handlers: { onNewDownload: () => void; onDownloadAgain: () => void }
): { screen: React.JSX.Element; titleBarStatus: TitleBarStatus } {
  switch (download.status) {
    case 'downloading':
      return {
        screen: <DownloadingScreen download={download} />,
        titleBarStatus: {
          kind: 'combined',
          networkCount: download.networks.filter((network) => network.status === 'on').length
        }
      }
    case 'paused':
      return {
        screen: <DownloadingScreen download={download} />,
        titleBarStatus: {
          kind: 'paused',
          networkCount: download.networks.filter((network) => network.enabled).length
        }
      }
    case 'completed':
      return {
        screen: <CompleteScreen download={download} onNewDownload={handlers.onNewDownload} />,
        titleBarStatus: { kind: 'none' }
      }
    case 'error':
    case 'cancelled':
      return {
        screen: (
          <ErrorScreen
            download={download}
            onNewDownload={handlers.onNewDownload}
            onDownloadAgain={handlers.onDownloadAgain}
          />
        ),
        titleBarStatus: { kind: 'none' }
      }
    default:
      return assertNever(download.status)
  }
}

function App(): React.JSX.Element {
  useDownloadEvents()
  useNetworkEvents()
  useQueues()
  useSchedules()
  useSystemActions()
  useBandwidth()
  useCategoryRules()
  useHistory()
  useClipboardDetection()

  const [view, setView] = useState<TitleBarView>('downloads')
  const [selectedQueueId, setSelectedQueueId] = useState<string | null>(null)

  const interfaces = useAppStore((store) => store.interfaces)
  const interfacesStatus = useAppStore((store) => store.interfacesStatus)
  const currentDownload = useAppStore((store) => store.currentDownload)
  const clearCurrentDownload = useAppStore((store) => store.clearCurrentDownload)
  const checkForUpdate = useAppStore((store) => store.checkForUpdate)
  const setDraftUrl = useAppStore((store) => store.setDraftUrl)
  const clipboardDetectedUrl = useAppStore((store) => store.clipboardDetectedUrl)
  const dismissClipboardDetected = useAppStore((store) => store.dismissClipboardDetected)

  useEffect(() => {
    checkForUpdate()
  }, [checkForUpdate])

  const handleNewDownload = (): void => {
    if (currentDownload) void window.plexo.removeDownload(currentDownload.id)
    clearCurrentDownload()
  }

  const handleDownloadAgain = (): void => {
    if (currentDownload) {
      const url = currentDownload.url
      void window.plexo.removeDownload(currentDownload.id)
      clearCurrentDownload()
      useAppStore.getState().setDraftUrl(url)
    }
  }

  const noConnections = interfacesStatus === 'ready' && interfaces.length === 0

  const handleAcceptClipboardUrl = (): void => {
    if (!clipboardDetectedUrl) return
    setDraftUrl(clipboardDetectedUrl)
    void window.plexo.dismissClipboardDetected(clipboardDetectedUrl)
    dismissClipboardDetected()
    setView('downloads')
  }

  const handleDismissClipboardUrl = (): void => {
    if (!clipboardDetectedUrl) return
    void window.plexo.dismissClipboardDetected(clipboardDetectedUrl)
    dismissClipboardDetected()
  }

  let screen: React.JSX.Element
  let titleBarStatus: TitleBarStatus = { kind: 'none' }

  if (view === 'queues') {
    screen = selectedQueueId ? (
      <QueueDetailScreen queueId={selectedQueueId} onBack={() => setSelectedQueueId(null)} />
    ) : (
      <QueueScreen onSelectQueue={setSelectedQueueId} />
    )
  } else if (view === 'schedule') {
    screen = <ScheduleScreen />
  } else if (view === 'history') {
    screen = <HistoryScreen />
  } else if (view === 'settings') {
    screen = <SettingsScreen />
  } else if (currentDownload) {
    ;({ screen, titleBarStatus } = renderDownload(currentDownload, {
      onNewDownload: handleNewDownload,
      onDownloadAgain: handleDownloadAgain
    }))
  } else if (noConnections) {
    screen = <NoConnectionsScreen />
    titleBarStatus = { kind: 'offline' }
  } else {
    screen = <IdleScreen />
  }

  return (
    <TooltipProvider>
      <div className="relative flex h-full flex-col">
        <TitleBar status={titleBarStatus} view={view} onChangeView={setView} />
        {clipboardDetectedUrl && (
          <div className="absolute inset-x-0 top-14 z-20 mx-auto w-full max-w-md px-4">
            <Alert className="shadow-lg">
              <AlertTitle>Download this?</AlertTitle>
              <AlertDescription className="truncate font-mono text-[11px]">
                {clipboardDetectedUrl}
              </AlertDescription>
              <div className="mt-2 flex gap-2">
                <Button type="button" size="xs" onClick={handleAcceptClipboardUrl}>
                  Add to downloads
                </Button>
                <Button type="button" size="xs" variant="ghost" onClick={handleDismissClipboardUrl}>
                  Dismiss
                </Button>
              </div>
            </Alert>
          </div>
        )}
        <div className="min-h-0 flex-1">{screen}</div>
        <UpdateDialog />
        <NetworkBindingDialog />
        <SystemActionConfirmDialog />
      </div>
    </TooltipProvider>
  )
}

export default App
