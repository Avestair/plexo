import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { IpcChannels } from '../shared/ipc-channels'
import type { IpcContract } from '../shared/ipc-contract'
import type {
  AppSettings,
  DownloadUpdate,
  InitialState,
  NetworkInterfaceInfo,
  Queue,
  QueueAction,
  QueueSchedule,
  SystemActionState
} from '../shared/types'

/** Typed wrapper around ipcRenderer.invoke — the channel name picks its args/result shape out of
 * IpcContract, so a call here that doesn't match what registerIpcHandlers (main) actually handles
 * is a compile error instead of a silent runtime mismatch. */
function invoke<K extends keyof IpcContract>(
  channel: K,
  ...args: IpcContract[K]['args']
): Promise<IpcContract[K]['result']> {
  return ipcRenderer.invoke(IpcChannels[channel], ...args)
}

const plexoApi = {
  platform: process.platform,
  // Sync on purpose — see InitialState. One small read, once, before the renderer's first paint.
  initialState: ipcRenderer.sendSync(IpcChannels.getInitialState) as InitialState,

  listInterfaces: () => invoke('listInterfaces'),
  pingInterfaces: () => invoke('pingInterfaces'),
  deviceBindingSupported: () => invoke('deviceBindingSupported'),
  openNetworkSettings: () => invoke('openNetworkSettings'),
  updateSettings: (patch: AppSettings) => invoke('updateSettings', patch),
  probeUrl: (url: string) => invoke('probeUrl', url),
  chooseDestinationFolder: (defaultPath: string) => invoke('chooseDestinationFolder', defaultPath),
  readClipboardText: () => invoke('readClipboardText'),
  revealInFolder: (filePath: string) => invoke('revealInFolder', filePath),
  startDownload: (request: IpcContract['startDownload']['args'][0]) =>
    invoke('startDownload', request),
  getCurrentDownload: () => invoke('getCurrentDownload'),
  pauseDownload: (downloadId: string) => invoke('pauseDownload', downloadId),
  resumeDownload: (downloadId: string) => invoke('resumeDownload', downloadId),
  setDownloadNetwork: (downloadId: string, networkId: string, enabled: boolean) =>
    invoke('setDownloadNetwork', downloadId, networkId, enabled),
  cancelDownload: (downloadId: string) => invoke('cancelDownload', downloadId),
  removeDownload: (downloadId: string) => invoke('removeDownload', downloadId),
  checkForUpdate: () => invoke('checkForUpdate'),

  getQueues: () => invoke('getQueues'),
  createQueue: (name: string, description?: string) => invoke('createQueue', name, description),
  deleteQueue: (queueId: string) => invoke('deleteQueue', queueId),
  updateQueueName: (queueId: string, name: string) => invoke('updateQueueName', queueId, name),
  addQueueDownload: (queueId: string, url: string) => invoke('addQueueDownload', queueId, url),
  removeQueueDownload: (queueId: string, itemId: string) =>
    invoke('removeQueueDownload', queueId, itemId),
  pauseQueue: (queueId: string) => invoke('pauseQueue', queueId),
  resumeQueue: (queueId: string) => invoke('resumeQueue', queueId),
  pauseQueueItem: (queueId: string, itemId: string) => invoke('pauseQueueItem', queueId, itemId),
  resumeQueueItem: (queueId: string, itemId: string) => invoke('resumeQueueItem', queueId, itemId),
  cancelQueueItem: (queueId: string, itemId: string) => invoke('cancelQueueItem', queueId, itemId),
  reorderQueueItems: (queueId: string, itemIds: string[]) =>
    invoke('reorderQueueItems', queueId, itemIds),

  setSchedule: (queueId: string, schedule: Omit<QueueSchedule, 'queueId'>) =>
    invoke('setSchedule', queueId, schedule),
  getSchedule: (queueId: string) => invoke('getSchedule', queueId),
  getSchedules: () => invoke('getSchedules'),
  removeSchedule: (queueId: string) => invoke('removeSchedule', queueId),
  checkSchedulesNow: () => invoke('checkSchedulesNow'),

  setSystemAction: (queueId: string, action: Omit<QueueAction, 'queueId'>) =>
    invoke('setSystemAction', queueId, action),
  getSystemAction: (queueId: string) => invoke('getSystemAction', queueId),
  getSystemActions: () => invoke('getSystemActions'),
  removeSystemAction: (queueId: string) => invoke('removeSystemAction', queueId),
  getSystemActionLog: () => invoke('getSystemActionLog'),
  cancelSystemAction: (queueId: string) => invoke('cancelSystemAction', queueId),
  confirmSystemAction: (queueId: string) => invoke('confirmSystemAction', queueId),
  getPlatform: () => invoke('getPlatform'),

  onQueuesUpdated: (callback: (queues: Queue[]) => void): (() => void) => {
    const listener = (_event: IpcRendererEvent, queues: Queue[]): void => callback(queues)
    ipcRenderer.on(IpcChannels.queueUpdated, listener)
    return () => ipcRenderer.removeListener(IpcChannels.queueUpdated, listener)
  },

  onSchedulesUpdated: (callback: (schedules: QueueSchedule[]) => void): (() => void) => {
    const listener = (_event: IpcRendererEvent, schedules: QueueSchedule[]): void =>
      callback(schedules)
    ipcRenderer.on(IpcChannels.scheduleUpdated, listener)
    return () => ipcRenderer.removeListener(IpcChannels.scheduleUpdated, listener)
  },

  onDownloadUpdated: (callback: (update: DownloadUpdate) => void): (() => void) => {
    const listener = (_event: IpcRendererEvent, update: DownloadUpdate): void => callback(update)
    ipcRenderer.on(IpcChannels.downloadUpdated, listener)
    return () => ipcRenderer.removeListener(IpcChannels.downloadUpdated, listener)
  },

  onNetworksChanged: (callback: (networks: NetworkInterfaceInfo[]) => void): (() => void) => {
    const listener = (_event: IpcRendererEvent, networks: NetworkInterfaceInfo[]): void =>
      callback(networks)
    ipcRenderer.on(IpcChannels.networksChanged, listener)
    return () => ipcRenderer.removeListener(IpcChannels.networksChanged, listener)
  },

  onSystemActionUpdated: (callback: (state: SystemActionState) => void): (() => void) => {
    const listener = (_event: IpcRendererEvent, state: SystemActionState): void => callback(state)
    ipcRenderer.on(IpcChannels.systemActionUpdated, listener)
    return () => ipcRenderer.removeListener(IpcChannels.systemActionUpdated, listener)
  }
}

export type PlexoApi = typeof plexoApi

// Nothing in the renderer needs raw Electron/Node access — only the typed plexoApi above is
// exposed. The @electron-toolkit/preload electronAPI (which hands the renderer an unrestricted
// ipcRenderer.invoke/send/on on any channel) is deliberately not bridged.
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('plexo', plexoApi)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.plexo = plexoApi
}
