export type NetworkInterfaceKind = 'wifi' | 'usb' | 'ethernet' | 'bridge' | 'other'
export type IpFamily = 4 | 6

export interface NetworkAddress {
  address: string
  family: IpFamily
  netmask?: string
  /** Used by the existing IPv4 same-subnet warning. */
  subnet?: string
}

export type ThemeSource = 'light' | 'dark'

export interface NetworkInterfaceInfo {
  /** Stable identifier for this interface (currently the OS device name, e.g. "en0"). */
  id: string
  device: string
  displayName: string
  addresses: NetworkAddress[]
  kind: NetworkInterfaceKind
  mac?: string
}

export interface ProbeResult {
  requestedUrl: string
  /** URL after following redirects — this is what the download should actually fetch. */
  finalUrl: string
  supportsRanges: boolean
  /** null when the server did not report a size. */
  totalBytes: number | null
  suggestedFileName: string
  contentType: string | null
  /** Strong validators, used to detect if the remote content changes between pause and resume. */
  etag: string | null
  lastModified: string | null
}

export type DownloadStatus = 'downloading' | 'paused' | 'completed' | 'error' | 'cancelled'

/** A stream's state. `pending` means it is waiting for work: it holds no block, either because
 * none is free for it right now or because it hasn't started. `downloading` always means it is
 * fetching one (`currentBlockIndex` says which). A stream that fails for good leaves the list;
 * what went wrong is its network's to report (see DownloadNetwork). */
export type ChunkStatus =
  'pending' | 'downloading' | 'retrying' | 'paused' | 'completed' | 'cancelled'

/** One connection to the server, through one network. Streams come and go as the download
 * runs; what a network has done is kept on its DownloadNetwork. */
export interface ChunkState {
  id: number
  /** The network it runs on: a DownloadNetwork's id. */
  interfaceId: string
  rangeStart: number
  /** null means an open-ended range (download to end of file). */
  rangeEnd: number | null
  /** New bytes it has delivered. */
  bytesDownloaded: number
  speedBytesPerSec: number
  status: ChunkStatus
  /** The block this stream is fetching. Unset whenever it holds none (idle, retrying, paused, done). */
  currentBlockIndex?: number
  /** True while this stream is racing another stream for `currentBlockIndex`, because that one
   * was too slow — see main/download/scheduler.ts. Whichever finishes first wins. */
  hedge?: boolean
}

export type BlockStatus = 'pending' | 'downloading' | 'completed'

export interface BlockState {
  index: number
  rangeStart: number
  rangeEnd: number | null
  status: BlockStatus
  /** The network currently leasing this block (or the last one to touch it). Only meaningful
   * as "who is working on it now" — for who actually *delivered* the bytes, read
   * `bytesByInterface`, since a block can be started on one network and finished on another
   * after a retry or a pause/resume. */
  interfaceId?: string
  bytesDownloaded: number
  /** Bytes of this block delivered by each network, keyed by interface id. Summing to
   * `bytesDownloaded`, this is what the block grid colors by, so a block split across
   * networks is attributed to all of them instead of only the one that happened to finish it. */
  bytesByInterface: Record<string, number>
}

/**
 * - on: in use.
 * - off: the user switched it off. A network that turns up mid-download starts off.
 * - offline: not connected to this computer. It's used again as soon as it is.
 * - unreachable: connected, but the server can't be reached through it. One connection keeps
 *   trying, and the rest follow once it gets through.
 * - failed: the server kept refusing requests over it (`error` says how). Switching it off and
 *   on, reconnecting it, or resuming tries again.
 */
export type NetworkStatus = 'on' | 'off' | 'offline' | 'unreachable' | 'failed'

/** A network as one download sees it: whether the user has it on, and how it is doing. */
export interface DownloadNetwork {
  /** A NetworkInterfaceInfo id. */
  id: string
  /** Its name and kind as the OS last reported them. */
  label: string
  kind: NetworkInterfaceKind
  /** The user's choice; `status` is what came of it. */
  enabled: boolean
  status: NetworkStatus
  error?: string
  /** Bytes of the file it delivered. */
  bytesDownloaded: number
  speedBytesPerSec: number
  /** Requests over it that failed and were tried again. */
  retries: number
}

export interface DownloadState {
  id: string
  url: string
  fileName: string
  destinationPath: string
  /** 0 means the size could not be determined ahead of time. */
  totalBytes: number
  bytesDownloaded: number
  speedBytesPerSec: number
  status: DownloadStatus
  /** Every network on this computer, and any the download used that has since gone, in the
   * order it first saw them. */
  networks: DownloadNetwork[]
  chunks: ChunkState[]
  /** The most streams it has run at once. */
  peakStreams?: number
  blocks?: BlockState[]
  totalBlocks?: number
  blockSizeBytes?: number
  error?: string
  /** For an error: whether resuming can pick up where it stopped. False when the progress was
   * thrown away, e.g. the file changed on the server. */
  resumable?: boolean
  startedAt: number
  pausedAt?: number
  totalPausedMs?: number
  completedAt?: number
  /** The update this state is as of (see DownloadUpdate). */
  seq?: number
}

/** What the main process sends as a download changes: everything but its blocks, and only the
 * blocks that changed since it last sent. A download can have tens of thousands of blocks, and
 * copying every one several times a second would cost the process that carries every byte. A
 * snapshot is the same with every block in it. */
export interface DownloadUpdate {
  /** Counts what the main process has sent for the download. A snapshot has the count it was
   * taken at. */
  seq: number
  state: Omit<DownloadState, 'blocks'>
  blocks: BlockState[]
}

/** User customization for one physical network, keyed by NetworkInterfaceInfo.id — lets a
 * cryptic OS device name (e.g. "feth0") get a real label, and a color distinct from its
 * kind's default. Persisted in the main process, independent of any single download. */
export interface NetworkPreference {
  customName?: string
  /** One of the app's curated swatch ids (see NETWORK_COLOR_SWATCHES) — not a raw hex, so every
   * swatch is guaranteed to have a legible on-solid text color already picked out for it. */
  colorId?: string
}

export type NetworkPreferences = Record<string, NetworkPreference>

export interface UpdateInfo {
  version: string
  /** Where clicking the notification should take the user — the landing page's downloads. */
  url: string
  /** True once the user has dismissed the banner for this exact version (persisted, so it stays
   * dismissed across relaunches) — the app then falls back to a quiet titlebar icon instead. */
  dismissed: boolean
}

/** What app-settings.json holds, and what the renderer sends to change it (merged over the saved
 * values, `undefined` clearing one). A missing field was never set. */
export interface AppSettings {
  themeSource?: ThemeSource
  dismissedUpdateVersion?: string
  /** The last destination folder picked. */
  destinationDir?: string
  /** User customizations (name/color) per network interface id. */
  networkPreferences?: NetworkPreferences
  /** App-wide max download speed, applied to every active transfer (ad-hoc or queue-driven)
   * that doesn't have its own override (see QueueBandwidthSettings.useGlobalLimit). 0 or
   * undefined = unlimited. A simple scalar setting here, not a BandwidthLimit record — the
   * global cap has no traffic cap or reset schedule of its own (see BandwidthLimit's doc). */
  globalMaxSpeedBytesPerSec?: number
  /** Whether closing the main window (the OS close button) hides it to a tray icon instead of
   * quitting the app. Off by default — not every user wants a background process they didn't
   * explicitly ask to keep running. The tray icon itself is created/destroyed to match this
   * setting as soon as it changes, no restart required (see main/tray.ts). */
  minimizeToTrayOnClose?: boolean
  /** Registers (or unregisters) Plexo as a login item via app.setLoginItemSettings. Off by
   * default. Applied on every app startup (in case the setting was changed, or a previous
   * version's registration is stale) and whenever this setting itself changes. */
  startOnLogin?: boolean
  /** Skips showing the main window on launch — it stays hidden until the user brings it up from
   * the tray (if minimizeToTrayOnClose is also on) or otherwise reveals it. Independent of
   * startOnLogin: a user may want either on its own, or both together. Off by default. */
  startMinimized?: boolean
}

/** Everything the renderer needs for its first paint, read synchronously by the preload so no
 * saved value flashes in over a default a moment after launch. */
export interface InitialState {
  homeDir: string
  downloadsDir: string
  themeSource: ThemeSource
  networkPreferences: NetworkPreferences
  /** The last folder picked, if it still exists — otherwise the renderer uses downloadsDir. */
  destinationDir?: string
}

export type QueueItemStatus = 'pending' | 'downloading' | 'paused' | 'completed' | 'failed'

/** One URL queued for download, as part of a Queue. Driven through DownloadManager one at a
 * time — its own progress fields mirror DownloadState while it is the one running. */
export interface QueueItem {
  id: string
  url: string
  fileName: string
  status: QueueItemStatus
  /** 0-100. */
  progress: number
  /** 0 means unknown ahead of time, same convention as DownloadState.totalBytes. */
  size: number
  downloadedSize: number
  speedBytesPerSec: number
  /** Seconds; 0 when it can't be estimated. */
  timeRemainingSec: number
  addedAt: number
  completedAt?: number
  error?: string
}

export type QueueStatus = 'idle' | 'active' | 'paused' | 'completed'

/** A named, ordered list of downloads the user wants run one after another. Persisted in the
 * main process (see main/storage/queueStorage.ts) independent of any single download. */
export interface Queue {
  id: string
  name: string
  description?: string
  createdAt: number
  items: QueueItem[]
  status: QueueStatus
  /** 0-100, the average of its items' progress. */
  totalProgress: number
  /** True while this queue's traffic cap (see QueueBandwidthSettings) is reached: pending items
   * stop being started, independent of `status`, and distinct from a user-initiated pause (see
   * BandwidthManager/QueueManager.nextCandidate). Cleared automatically once usage resets. */
  capReached?: boolean
}

/** Which weekdays (in the user's local time zone) a schedule repeats on. */
export interface WeeklyRepeat {
  monday: boolean
  tuesday: boolean
  wednesday: boolean
  thursday: boolean
  friday: boolean
  saturday: boolean
  sunday: boolean
}

/** When a queue should start (and optionally pause again) automatically, with optional
 * daily/weekly repetition — one per queue, keyed by queueId. Persisted in the main process (see
 * main/storage/scheduleStorage.ts) independent of the Queue it targets. */
export interface QueueSchedule {
  queueId: string
  /** Epoch ms of the next/configured start; null means no start is scheduled. */
  startTime: number | null
  /** Epoch ms to pause the queue again; null/undefined means no auto-pause. */
  sleepTime?: number | null
  repeatDaily?: boolean
  repeatWeekly?: WeeklyRepeat
  enabled: boolean
}

export type SystemAction = 'none' | 'sleep' | 'hibernate' | 'shutdown'

/** What should happen automatically once a queue finishes — one per queue, keyed by queueId.
 * Persisted in the main process (see main/storage/systemActionStorage.ts) independent of the
 * Queue it targets, the same way QueueSchedule is. */
export interface QueueAction {
  queueId: string
  action: SystemAction
  /** When true, nothing runs until the countdown below is confirmed (or elapses unconfirmed). */
  confirmBefore: boolean
  /** Seconds to count down before running, when confirmBefore is true. Unset means a sane
   * default (see systemActionManager.ts). */
  countdownSeconds?: number
}

/** A past (or in-progress-then-settled) system action, kept in a bounded, persisted log so the
 * user can see what actually ran. */
export interface SystemActionLogEntry {
  id: string
  queueId: string
  queueName: string
  action: SystemAction
  at: number
  /** What actually happened: run, cancelled during the countdown, or failed to execute. */
  outcome: 'ran' | 'cancelled' | 'failed'
  error?: string
}

/** A countdown currently running for one queue's configured action, pushed live so the renderer
 * can show (and let the user cancel or skip) it without polling. */
export interface PendingSystemAction {
  queueId: string
  queueName: string
  action: SystemAction
  /** Epoch ms this will fire, absent a cancel or an explicit confirmNow. */
  fireAt: number
}

/** Everything the renderer needs about post-download system actions, pushed whole each time any
 * of it changes — mirrors Queue[]/QueueSchedule[] pushes. */
export interface SystemActionState {
  actions: QueueAction[]
  log: SystemActionLogEntry[]
  pending: PendingSystemAction[]
}

export type BandwidthResetSchedule = 'daily' | 'weekly' | 'monthly' | 'never'

/**
 * A speed cap and/or a total-traffic cap, with an optional reset schedule for the traffic side.
 * Used both per-queue (see QueueBandwidthSettings) and, in a lighter form, for the app-wide
 * default (see AppSettings.globalMaxSpeedBytesPerSec — a plain number there, since the global
 * setting is only ever a speed cap: a traffic cap and its reset only make sense scoped to a
 * queue, where "usage" has a meaning — see main/queue/bandwidthManager.ts).
 *
 * Accounting: `usedBytes` is the queue's cumulative bytes downloaded since `lastResetAt`,
 * advanced by the *delta* in each active download's `bytesDownloaded` while it belongs to this
 * queue (tracked per download id in BandwidthManager) rather than by re-summing anything — a
 * pause/resume of the same download only ever adds the bytes it delivers after that point, so
 * nothing is double-counted, and a download that restarts from scratch (a new download id, e.g.
 * after an app relaunch drops an in-flight queue item back to 'pending') naturally starts its
 * delta tracking fresh rather than replaying bytes already credited.
 */
export interface BandwidthLimit {
  /** 0 or undefined = unlimited. */
  maxSpeedBytesPerSec?: number
  /** 0 or undefined = unlimited. */
  maxTrafficBytes?: number
  resetSchedule?: BandwidthResetSchedule
  /** Epoch ms usage was last zeroed (or first configured, before any reset has fired). */
  lastResetAt?: number
  usedBytes: number
}

/** A queue's bandwidth settings, keyed by queueId. Persisted in the main process (see
 * main/storage/bandwidthStorage.ts) independent of the Queue it targets, the same way
 * QueueSchedule and QueueAction are. */
export interface QueueBandwidthSettings {
  queueId: string
  limit?: BandwidthLimit
  /** true = ignore limit.maxSpeedBytesPerSec and use the app-wide global speed limit instead.
   * false = use limit.maxSpeedBytesPerSec on its own — unlimited if it isn't set, since opting
   * out of the global limit means exactly that, not "fall back to it after all". The traffic cap
   * and its reset schedule are always this queue's own either way — there's no "global" traffic
   * cap to defer to. */
  useGlobalLimit: boolean
}

/** Live usage for one queue, pushed whenever it changes (a byte tally, a reset, a cap newly
 * reached) — mirrors Queue[]/QueueSchedule[] pushes. `nearCapRatio` is usedBytes/maxTrafficBytes
 * when a cap is set, for the renderer's warning state (see useBandwidth's NEAR_CAP_RATIO). */
export interface QueueBandwidthUsage {
  queueId: string
  usedBytes: number
  maxTrafficBytes?: number
  capReached: boolean
  resetSchedule?: BandwidthResetSchedule
  lastResetAt?: number
}

export interface StartDownloadRequest {
  url: string
  destinationDir: string
  suggestedFileName: string
  /** 0 means unknown. */
  totalBytes: number
  supportsRanges: boolean
  /** The networks to start on. Every other one starts switched off. */
  interfaceIds: string[]
  etag: string | null
  lastModified: string | null
  /** Streams per network the user picked; left out, the count is decided automatically. */
  streamsPerNetwork?: number
}
