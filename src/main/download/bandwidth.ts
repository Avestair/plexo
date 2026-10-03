/**
 * Throttles how fast bytes move from the network into a download, without touching anything
 * about *how* they get fetched (streams, blocks, hedging) — a download's chunk workers just ask
 * this for permission to accept the next batch of bytes before writing them, the same way they
 * already wait out disk backpressure (see chunkDownloader.ts's drain handling).
 *
 * A classic token bucket: tokens refill at `bytesPerSec`, up to a one-second burst, and `take()`
 * resolves once enough have accumulated to cover the request. Unlimited (0 or never configured)
 * is the fast path every download takes unless the user has actually set a cap: `take()` returns
 * already-resolved with no clock read, no timer, no allocation — the "zero overhead" the feature
 * must not tax everyone else for.
 *
 * One instance is shared by every concurrent chunk of a single download (and, since
 * DownloadManager only ever runs one download at a time — see its `isIdle`/`hasActiveDownload` —
 * by the one DownloadManager-wide instance this app actually wires up), so a 500 KB/s cap on a
 * 4-connection download totals 500 KB/s rather than 500 KB/s per connection. The limit can be
 * changed live (`setLimit`) — a chunk mid-wait picks up the new rate on its next recheck, at most
 * `RECHECK_MS` later, without restarting anything.
 */
export class RateLimiter {
  private bytesPerSec = 0
  private tokens = 0
  private lastRefillAt = Date.now()

  /** 0 (or negative) means unlimited. */
  setLimit(bytesPerSec: number): void {
    const next = Number.isFinite(bytesPerSec) && bytesPerSec > 0 ? bytesPerSec : 0
    if (next === this.bytesPerSec) return
    // Starting a fresh cap with an empty bucket would stall the very first chunk waiting for a
    // full refill; starting it topped up like the burst it allows reads as a natural warm start.
    this.tokens = next > 0 ? next : 0
    this.bytesPerSec = next
    this.lastRefillAt = Date.now()
  }

  getLimit(): number {
    return this.bytesPerSec
  }

  private refill(now: number): void {
    if (this.bytesPerSec <= 0) return
    const elapsedSec = Math.max(0, now - this.lastRefillAt) / 1000
    this.lastRefillAt = now
    this.tokens = Math.min(this.bytesPerSec, this.tokens + elapsedSec * this.bytesPerSec)
  }

  /**
   * Resolves once `bytes` worth of budget is available (consuming it), or the signal aborts.
   * Unlimited: resolves immediately, touching nothing else — the zero-overhead path.
   *
   * A single chunk can be larger than a whole second's budget (a fast origin, a tight cap): that
   * would otherwise wait forever for tokens that can never fully accumulate, so a request is let
   * through once the bucket is as full as it can get, even if that's short of `bytes`. The next
   * request still pays for it — the bucket goes to zero rather than negative — so the long-run
   * rate still holds.
   */
  async take(bytes: number, signal?: AbortSignal): Promise<void> {
    if (this.bytesPerSec <= 0 || bytes <= 0) return
    for (;;) {
      if (signal?.aborted) return
      const now = Date.now()
      this.refill(now)
      if (this.tokens >= bytes || this.tokens >= this.bytesPerSec) {
        this.tokens = Math.max(0, this.tokens - bytes)
        return
      }
      const deficit = bytes - this.tokens
      const waitMs = Math.max(1, Math.ceil((deficit / this.bytesPerSec) * 1000))
      // Capped so a live setLimit() change is picked up promptly rather than after whatever a
      // stale, much-longer wait had already committed to.
      await delay(Math.min(waitMs, RECHECK_MS), signal)
    }
  }
}

const RECHECK_MS = 200

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve()
      return
    }
    const onAbort = (): void => {
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
