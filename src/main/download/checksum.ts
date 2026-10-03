import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import type { HashAlgorithm } from '../../shared/types'

/**
 * Hashes a file on disk, streamed rather than read whole into memory — consistent with how the
 * rest of the download pipeline treats large files (see DownloadFile, which never buffers a
 * download's bytes either). A download can be many gigabytes; `createReadStream` + incremental
 * `hash.update()` keeps memory use flat regardless of size.
 */
export function hashFile(path: string, algorithm: HashAlgorithm): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash(algorithm)
    const stream = createReadStream(path)
    stream.on('error', reject)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => {
      try {
        resolve(hash.digest('hex'))
      } catch (error) {
        reject(error)
      }
    })
  })
}
