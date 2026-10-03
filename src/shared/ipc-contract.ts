import type {
  AppSettings,
  BatchAddResult,
  CategoryRule,
  DownloadUpdate,
  ExpectedChecksum,
  HistoryEntry,
  NetworkInterfaceInfo,
  ProbeResult,
  Queue,
  QueueAction,
  QueueBandwidthSettings,
  QueueBandwidthUsage,
  QueueItem,
  QueueSchedule,
  StartDownloadRequest,
  SystemActionLogEntry,
  UpdateInfo
} from './types'

/** Shaped here (not re-exported from main/queue/categoryRules.ts) so this file — shared by the
 * renderer and preload — never has to resolve a main-process module just for its types. */
type CategoryRuleInput = Omit<CategoryRule, 'id' | 'order'>
type CategoryRulePatch = Partial<Omit<CategoryRule, 'id'>>

/** 'windows'/'macos'/'linux'/'other' — process.platform mapped to what the renderer actually
 * needs to show (platform-appropriate labels/warnings for sleep/hibernate/shutdown), rather than
 * every raw NodeJS.Platform value. */
export type AppPlatform = 'windows' | 'macos' | 'linux' | 'other'

/** The request/response half of the IPC surface (every IpcChannels entry except the
 * main->renderer push events, downloadUpdated, networksChanged and queueUpdated) — one source of
 * truth for both plexoApi (preload) and registerIpcHandlers (main), so a signature drift between
 * the two is a compile error instead of a runtime one. */
export interface IpcContract {
  listInterfaces: { args: []; result: NetworkInterfaceInfo[] }
  pingInterfaces: { args: []; result: Record<string, number | null> }
  deviceBindingSupported: { args: []; result: boolean }
  openNetworkSettings: { args: []; result: void }
  getSettings: { args: []; result: AppSettings }
  updateSettings: { args: [patch: AppSettings]; result: void }
  probeUrl: { args: [url: string]; result: ProbeResult }
  chooseDestinationFolder: { args: [defaultPath: string]; result: string | null }
  /** Picks a local text file and returns its contents (UTF-8), or null if cancelled or
   * unreadable — combined into one round trip since the renderer has no fs access of its own to
   * follow up a bare path with (unlike chooseDestinationFolder, where the path itself is what's
   * wanted). */
  chooseTextFile: { args: []; result: string | null }
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
  addQueueDownload: {
    args: [queueId: string, url: string, expectedChecksum?: ExpectedChecksum]
    result: QueueItem
  }
  /** Validates and dedupes `urls` (see QueueManager.addDownloads for the exact policy) and adds
   * every survivor in one persisted write. */
  addQueueDownloads: { args: [queueId: string, urls: string[]]; result: BatchAddResult }
  removeQueueDownload: { args: [queueId: string, itemId: string]; result: void }
  pauseQueue: { args: [queueId: string]; result: void }
  resumeQueue: { args: [queueId: string]; result: void }
  pauseQueueItem: { args: [queueId: string, itemId: string]; result: void }
  resumeQueueItem: { args: [queueId: string, itemId: string]; result: void }
  cancelQueueItem: { args: [queueId: string, itemId: string]; result: void }
  reorderQueueItems: { args: [queueId: string, itemIds: string[]]; result: void }
  updateQueueName: { args: [queueId: string, name: string]; result: void }
  getQueues: { args: []; result: Queue[] }
  setSchedule: {
    args: [queueId: string, schedule: Omit<QueueSchedule, 'queueId'>]
    result: QueueSchedule
  }
  getSchedule: { args: [queueId: string]; result: QueueSchedule | null }
  getSchedules: { args: []; result: QueueSchedule[] }
  removeSchedule: { args: [queueId: string]; result: void }
  checkSchedulesNow: { args: []; result: void }
  setSystemAction: {
    args: [queueId: string, action: Omit<QueueAction, 'queueId'>]
    result: QueueAction
  }
  getSystemAction: { args: [queueId: string]; result: QueueAction | null }
  getSystemActions: { args: []; result: QueueAction[] }
  removeSystemAction: { args: [queueId: string]; result: void }
  getSystemActionLog: { args: []; result: SystemActionLogEntry[] }
  cancelSystemAction: { args: [queueId: string]; result: void }
  confirmSystemAction: { args: [queueId: string]; result: void }
  getPlatform: { args: []; result: AppPlatform }
  getGlobalBandwidthLimit: { args: []; result: number }
  setGlobalBandwidthLimit: { args: [bytesPerSec: number]; result: void }
  getQueueBandwidthLimit: { args: [queueId: string]; result: QueueBandwidthSettings | null }
  getQueueBandwidthLimits: { args: []; result: QueueBandwidthSettings[] }
  setQueueBandwidthLimit: {
    args: [queueId: string, patch: Omit<QueueBandwidthSettings, 'queueId'>]
    result: QueueBandwidthSettings
  }
  removeQueueBandwidthLimit: { args: [queueId: string]; result: void }
  getBandwidthUsage: { args: []; result: QueueBandwidthUsage[] }
  checkBandwidthNow: { args: []; result: void }
  createCategoryRule: { args: [input: CategoryRuleInput]; result: CategoryRule }
  updateCategoryRule: { args: [id: string, patch: CategoryRulePatch]; result: CategoryRule | null }
  getCategoryRule: { args: [id: string]; result: CategoryRule | null }
  getCategoryRules: { args: []; result: CategoryRule[] }
  removeCategoryRule: { args: [id: string]; result: void }
  reorderCategoryRules: { args: [ids: string[]]; result: void }
  getHistory: { args: []; result: HistoryEntry[] }
  /** Case-insensitive substring match against fileName/url; `statusFilter` narrows to one status
   * when given. An empty query with no statusFilter returns everything, newest first. */
  searchHistory: {
    args: [query: string, statusFilter?: HistoryEntry['status']]
    result: HistoryEntry[]
  }
  clearHistory: { args: []; result: void }
  getClipboardWatchEnabled: { args: []; result: boolean }
  setClipboardWatchEnabled: { args: [enabled: boolean]; result: void }
  /** Marks a detected URL as handled (added or dismissed) so it is never offered again this
   * session — see main/clipboard/clipboardWatcher.ts's doc for why this is a no-op most of the
   * time (the same dedup already applies automatically) but is still worth calling explicitly. */
  dismissClipboardDetected: { args: [url: string]; result: void }
  /** Runs one clipboard check synchronously instead of waiting for the poll interval — the escape
   * hatch that makes clipboard detection testable, same pattern as schedule:checkNow. */
  checkClipboardNow: { args: []; result: void }
}
