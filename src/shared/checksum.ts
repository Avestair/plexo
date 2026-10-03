import type { HashAlgorithm } from './types'

/**
 * Pure checksum helpers, imported by both the main process (main/download/checksum.ts, the
 * source of truth once a download actually runs) and the renderer (so an obviously-wrong-length
 * hash can be rejected instantly as the user types, with no IPC round trip) — the same
 * one-implementation-shared-via-shared/ pattern as shared/categoryRules.ts's matchCategoryRule.
 * This is also why there is no checksum:validateFormat IPC channel: a renderer-only pure function
 * needs no main-process round trip to be "the one place this is decided".
 */

const HEX_LENGTH: Record<HashAlgorithm, number> = { md5: 32, sha1: 40, sha256: 64 }

export const HASH_ALGORITHM_LABEL: Record<HashAlgorithm, string> = {
  md5: 'MD5',
  sha1: 'SHA-1',
  sha256: 'SHA-256'
}

export function isHexString(value: string): boolean {
  return value.length > 0 && /^[0-9a-fA-F]+$/.test(value)
}

/** Lowercase, trimmed — the form every stored/compared ExpectedChecksum.expectedHex is in. */
export function normalizeChecksumHex(hex: string): string {
  return hex.trim().toLowerCase()
}

/** The algorithm a hex string's length alone identifies, or null when it matches none of
 * MD5/SHA-1/SHA-256 (too short, too long, or not hex at all). Lengths don't collide between the
 * three, so this is unambiguous whenever it returns non-null. */
export function detectHashAlgorithm(hex: string): HashAlgorithm | null {
  const trimmed = normalizeChecksumHex(hex)
  if (!isHexString(trimmed)) return null
  const match = (Object.entries(HEX_LENGTH) as [HashAlgorithm, number][]).find(
    ([, length]) => length === trimmed.length
  )
  return match ? match[0] : null
}

/**
 * Whether `hex` is a plausible digest for `algorithm` — hex characters, and exactly as long as
 * that algorithm's digest. Doesn't (can't) check that it's the *right* hash for any particular
 * file; that's what actually downloading and hashing the file is for. Letting the UI reject an
 * obviously-wrong-length paste before a download even starts is the whole point of keeping this
 * separate from, and cheaper than, main/download/checksum.ts's real hashing.
 */
export function validateChecksumFormat(
  algorithm: HashAlgorithm,
  hex: string
): { valid: boolean; reason?: string } {
  const trimmed = normalizeChecksumHex(hex)
  if (!trimmed) return { valid: false, reason: 'Enter a checksum' }
  if (!isHexString(trimmed)) return { valid: false, reason: 'Must be a hexadecimal string' }
  const expectedLength = HEX_LENGTH[algorithm]
  if (trimmed.length !== expectedLength) {
    return {
      valid: false,
      reason: `${HASH_ALGORITHM_LABEL[algorithm]} checksums are ${expectedLength} hex characters (got ${trimmed.length})`
    }
  }
  return { valid: true }
}
