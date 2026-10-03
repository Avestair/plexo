import { useEffect, useState } from 'react'

/** The current time, refreshed every `intervalMs` (default 30s) — for a countdown readout that
 * should stay roughly live without round-tripping to the main process every second. */
export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(id)
  }, [intervalMs])
  return now
}
