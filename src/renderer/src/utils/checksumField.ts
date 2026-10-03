import { detectHashAlgorithm, normalizeChecksumHex, validateChecksumFormat } from '@shared/checksum'
import type { ExpectedChecksum, HashAlgorithm } from '@shared/types'

export type AlgorithmChoice = 'auto' | HashAlgorithm

export interface ChecksumFieldState {
  algorithmChoice: AlgorithmChoice
  hex: string
}

export function emptyChecksumField(): ChecksumFieldState {
  return { algorithmChoice: 'auto', hex: '' }
}

/** Resolves a field's draft state to an ExpectedChecksum to send with a download request, or null
 * when the field is blank (checksum is always optional) or doesn't validate — a non-blank,
 * invalid value is surfaced by checksumFieldError below, and callers should refuse to submit
 * while that returns non-null rather than silently dropping what the user typed. */
export function resolveChecksumField(state: ChecksumFieldState): ExpectedChecksum | null {
  const hex = normalizeChecksumHex(state.hex)
  if (!hex) return null
  const algorithm =
    state.algorithmChoice === 'auto' ? detectHashAlgorithm(hex) : state.algorithmChoice
  if (!algorithm || !validateChecksumFormat(algorithm, hex).valid) return null
  return { algorithm, expectedHex: hex }
}

/** A human-readable reason the field's current value can't be used, or null when it's either
 * blank (fine — checksum is optional) or valid. */
export function checksumFieldError(state: ChecksumFieldState): string | null {
  const hex = normalizeChecksumHex(state.hex)
  if (!hex) return null
  if (state.algorithmChoice === 'auto') {
    return detectHashAlgorithm(hex)
      ? null
      : `Not a recognized checksum length (expected 32/40/64 hex characters for MD5/SHA-1/SHA-256, got ${hex.length})`
  }
  return validateChecksumFormat(state.algorithmChoice, hex).reason ?? null
}
