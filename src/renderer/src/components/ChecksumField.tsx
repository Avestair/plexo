import { Input } from './ui/input'
import {
  checksumFieldError,
  type AlgorithmChoice,
  type ChecksumFieldState
} from '../utils/checksumField'

/**
 * Optional checksum input — an algorithm choice (Auto-detect by length, or pick one explicitly)
 * plus the expected hash itself. Used wherever a URL is entered for a download that can carry a
 * checksum: IdleScreen's ad-hoc flow and QueueDetailScreen's single-item add. Deliberately not
 * offered on the batch-import path (a per-line checksum there would need a second column in the
 * paste/file format) — see QueueItem.expectedChecksum's doc for that call.
 */
export function ChecksumField({
  state,
  onChange
}: {
  state: ChecksumFieldState
  onChange: (next: ChecksumFieldState) => void
}): React.JSX.Element {
  const error = checksumFieldError(state)
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <span
          id="checksum-field-label"
          className="shrink-0 font-mono text-[10px] tracking-[0.14em] text-muted-foreground"
        >
          CHECKSUM
        </span>
        <select
          value={state.algorithmChoice}
          aria-label="Checksum algorithm"
          onChange={(event) =>
            onChange({ ...state, algorithmChoice: event.target.value as AlgorithmChoice })
          }
          className="h-7 shrink-0 rounded-lg border border-input bg-transparent px-2 text-[11px] outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
        >
          <option value="auto">Auto-detect</option>
          <option value="md5">MD5</option>
          <option value="sha1">SHA-1</option>
          <option value="sha256">SHA-256</option>
        </select>
        <Input
          placeholder="Optional — paste an expected hash to verify after download"
          value={state.hex}
          aria-labelledby="checksum-field-label"
          onChange={(event) => onChange({ ...state, hex: event.target.value })}
          className="h-7 min-w-0 flex-1 font-mono text-[11.5px]"
        />
      </div>
      {error && <div className="font-sans text-[11px] text-destructive">{error}</div>}
    </div>
  )
}
