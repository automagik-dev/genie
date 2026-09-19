/**
 * Result delivery: the full value on disk, a bounded projection to the model.
 *
 * The consumer caps the model-facing projection (50000 characters on the
 * installed host), and a run that returns more loses its **tail** — a recorded
 * `council` run lost its synthesis block exactly that way while the lens
 * sections survived. So a loader has to do better than "return the value":
 * write the whole thing where the operator can read it, and hand the model a
 * bounded projection that says what it left out.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface Preview {
  text: string
  truncated: boolean
  chars: number
  omitted: number
}

/** A stable rendering of any JSON-ish value; never throws on a cycle. */
export function render(value: unknown): string {
  const seen = new WeakSet<object>()
  try {
    return (
      JSON.stringify(
        value,
        (_key, item) => {
          if (item && typeof item === 'object') {
            if (seen.has(item as object)) return '[circular]'
            seen.add(item as object)
          }
          return item
        },
        2,
      ) ?? String(value)
    )
  } catch {
    return String(value)
  }
}

/** Bound a value for the model, keeping the head and saying how much is missing. */
export function previewValue(value: unknown, maxChars: number): Preview {
  const text = render(value)
  if (text.length <= maxChars) return { text, truncated: false, chars: text.length, omitted: 0 }
  const omitted = text.length - maxChars
  return {
    text: `${text.slice(0, maxChars)}\n… [${omitted} more characters are in the journal, not in this projection]`,
    truncated: true,
    chars: text.length,
    omitted,
  }
}

/** Where a full result is written: configured, else `<DSH_HOME>/workflow-runs`. */
export function journalDirectory(configured: string, dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')): string {
  return configured || join(dshHome, 'workflow-runs')
}

export interface JournalRecord {
  name: string
  source: string
  root: string
  runId: string
  agentsStarted: number
  stoppedEffort: Array<{ line: number; option: string; snippet: string }>
  startedAt: string
  durationMs: number
  value: unknown
}

/**
 * Write one run's full result and return its path. Deliberately outside the DSH
 * run root, so a journal survives whatever the host does with its own tree.
 */
export function writeJournal(dir: string, record: JournalRecord): string {
  mkdirSync(dir, { recursive: true })
  const stamp = record.startedAt.replace(/[:.]/g, '-')
  const path = join(dir, `${stamp}-${record.name}-${record.runId.replace(/[^\w-]/g, '')}.json`)
  writeFileSync(path, `${render(record)}\n`, 'utf8')
  return path
}
