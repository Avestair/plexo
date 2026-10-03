import { HASH_ALGORITHM_LABEL } from '@shared/checksum'
import type { ChecksumStatus, ExpectedChecksum } from '@shared/types'
import { AlertTriangle, CheckCircle2, HelpCircle, Loader2 } from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from './ui/alert'

/**
 * Checksum verification result, shown prominently — a mismatch in particular is deliberately
 * loud (a destructive alert, not a small gray label) rather than folded quietly into the rest of
 * a completed download's details, per Phase 7's "don't silently mark it completed" requirement.
 * Used on CompleteScreen (ad-hoc) and inline in QueueDetailScreen's item row (queue-driven).
 */
export function ChecksumStatusBanner({
  status,
  expected,
  computedHex
}: {
  status: ChecksumStatus
  expected?: ExpectedChecksum
  computedHex?: string
}): React.JSX.Element | null {
  const algorithmLabel = expected ? HASH_ALGORITHM_LABEL[expected.algorithm] : ''

  if (status === 'verifying') {
    return (
      <Alert className="py-1.5">
        <Loader2 className="animate-spin" />
        <AlertDescription>Verifying {algorithmLabel} checksum…</AlertDescription>
      </Alert>
    )
  }

  if (status === 'match') {
    return (
      <Alert className="border-emerald-500/40 bg-emerald-500/10 py-1.5 text-emerald-700 dark:text-emerald-300">
        <CheckCircle2 className="text-emerald-600 dark:text-emerald-400" />
        <AlertDescription className="text-emerald-800 dark:text-emerald-200/90">
          {algorithmLabel} checksum verified — matches what you expected.
        </AlertDescription>
      </Alert>
    )
  }

  if (status === 'mismatch') {
    return (
      <Alert variant="destructive" className="py-1.5">
        <AlertTriangle />
        <AlertTitle className="font-bold">Checksum mismatch</AlertTitle>
        <AlertDescription>
          This file&apos;s {algorithmLabel} hash does not match what you expected — it may be
          corrupted, incomplete, or not the file you meant to download. Expected{' '}
          <span className="font-mono">{expected?.expectedHex}</span>, got{' '}
          <span className="font-mono">{computedHex}</span>.
        </AlertDescription>
      </Alert>
    )
  }

  if (status === 'error') {
    return (
      <Alert className="border-amber-500/40 bg-amber-500/10 py-1.5 text-amber-700 dark:text-amber-300">
        <HelpCircle className="text-amber-600 dark:text-amber-400" />
        <AlertDescription className="text-amber-800 dark:text-amber-200/90">
          Could not verify the checksum — the file may have been moved or removed right after
          downloading.
        </AlertDescription>
      </Alert>
    )
  }

  return null
}
