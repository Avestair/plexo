import type {
  AppSettings,
  DownloadUpdate,
  NetworkInterfaceInfo,
  ProbeResult,
  Queue,
  QueueItem,
  StartDownloadRequest,
  UpdateInfo
} from './types'

/** The request/response half of the IPC surface (every IpcChannels entry except the
 * main->renderer push events, downloadUpdated, networksChanged and queueUpdated) — one source of
 * truth for both plexoApi (preload) and registerIpcHandlers (main), so a signature drift between
 * the two is a compile error instead of a runtime one. */
export interface IpcContract {
  listInterfaces: { args: []; result: NetworkInterfaceInfo[] }
  pingInterfaces: { args: []; result: Record<string, number | null> }
  deviceBindingSupported: { args: []; result: boolean }
  openNetworkSettings: { args: []; result: void }
  updateSettings: { args: [patch: AppSettings]; result: void }
  probeUrl: { args: [url: string]; result: ProbeResult }
  chooseDestinationFolder: { args: [defaultPath: string]; result: string | null }
  readClipboardText: { args: []; result: string }
  revealInFolder: { args: [filePath: string]; result: void }
  startDownload: { args: [request: StartDownloadRequest]; result: string }
  getCurrentDownload: { args: []; result: DownloadUpdate | null }
  pauseDownload: { args: [id: string]; result: void }
  resumeDownload: { args: [id: string]; result: void }
  setDownloadNetwork: { args: [id: string, networkId: string, enabled: boolean]; result: void }
  cancelDownload: { args: [id: string]; result: void }
  removeDownload: { args: [id: string]; result: void }
  checkForUpdate: { args: []; result: UpdateInfo | null }
  createQueue: { args: [name: string, description?: string]; result: Queue }
  deleteQueue: { args: [queueId: string]; result: void }
  addQueueDownload: { args: [queueId: string, url: string]; result: QueueItem }
  removeQueueDownload: { args: [queueId: string, itemId: string]; result: void }
  pauseQueue: { args: [queueId: string]; result: void }
  resumeQueue: { args: [queueId: string]; result: void }
  pauseQueueItem: { args: [queueId: string, itemId: string]; result: void }
  resumeQueueItem: { args: [queueId: string, itemId: string]; result: void }
  cancelQueueItem: { args: [queueId: string, itemId: string]; result: void }
  reorderQueueItems: { args: [queueId: string, itemIds: string[]]; result: void }
  updateQueueName: { args: [queueId: string, name: string]; result: void }
  getQueues: { args: []; result: Queue[] }
}
