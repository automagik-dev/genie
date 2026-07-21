// capability-table.ts — the checked-in, per-harness capability declaration (G3, D10).
//
// This is DATA, not code: one row per real harness stating what its read-only ACP chat
// face can honestly claim. It is the SINGLE source of truth for two consumers — the chat
// drawer's minimal badges (rendered at HIRE time, because a lazily-spawned face does not
// exist to probe live) and the two-faces contract docs (G4). Nothing here spawns a process
// or imports the PTY layer; `chat-backend` re-exports `capabilities()` so the badge render
// path and the ACP pool share one table.
//
// Three honest questions per harness (RESEARCH fact table, D8/D10):
//   - sharedMemory?              does the chat face share durable memory with the terminal
//                                face across sessions? TRUE only where DEMONSTRATED (Hermes
//                                via `~/.hermes/state.db`, AC4b). CC JSONL-resume is a
//                                stretch, not demonstrated → false; Codex/rlmx exempt.
//   - writeCapable?              can the chat face mutate the worktree? FALSE for every
//                                harness in v1 — the chat face is non-mutating (D5/AC4a),
//                                the terminal face is the sole mutator. Write-promotion is
//                                OUT (R8), so this column is uniformly false until a future
//                                wish flips it per-harness.
//   - sessionBridgingDemonstrated?  has session bridging actually been shown for this
//                                harness on this box? Drives the honest "shared memory"
//                                badge. Best-effort (AC4b), never a gate.
//
// v1 depends on `session/prompt` + streamed `session/update` only — the ONE primitive all
// four adapters expose (R2). Nothing v1-critical rides on loadSession/resume/MCP, so those
// are deliberately absent from this table.

import type { Harness } from './server/genie-lane';

/** One harness's checked-in capability declaration. The badge/doc source of truth. */
export interface CapabilityRow {
  harness: Harness;
  /** Chat + terminal faces share durable memory across sessions. True only where demonstrated. */
  sharedMemory: boolean;
  /** The chat face can mutate the worktree. Uniformly false in v1 (D5 — non-mutating chat face). */
  writeCapable: boolean;
  /** Session bridging has actually been demonstrated for this harness (AC4b, best-effort). */
  sessionBridgingDemonstrated: boolean;
  /** The mechanism behind a demonstrated bridge, for the docs/tooltip; '' when none. */
  bridge: string;
  /** One honest sentence rendered under the chat face at hire time. */
  note: string;
}

/**
 * The table. Ordered fable→codex→hermes→rlmx (roster order). Hermes is the only row with a
 * demonstrated shared-memory bridge (its `state.db` is a published vendor contract, not an
 * inference). Everything else states the honest default: coherence is the shared worktree +
 * git artifacts, not session identity.
 */
export const CAPABILITY_TABLE: Readonly<Record<Harness, CapabilityRow>> = Object.freeze({
  claude: {
    harness: 'claude',
    sharedMemory: false,
    writeCapable: false,
    sessionBridgingDemonstrated: false,
    bridge: '',
    note: 'Read-only chat face. Shared truth is the worktree + git artifacts; JSONL-resume bridging is a stretch, not demonstrated.',
  },
  codex: {
    harness: 'codex',
    sharedMemory: false,
    writeCapable: false,
    sessionBridgingDemonstrated: false,
    bridge: '',
    note: 'Read-only chat face. Shared truth is the worktree + git artifacts; session bridging exempt (AC4b).',
  },
  hermes: {
    harness: 'hermes',
    sharedMemory: true,
    writeCapable: false,
    sessionBridgingDemonstrated: true,
    bridge: '~/.hermes/state.db',
    note: 'Read-only chat face with shared memory: session bridging demonstrated via ~/.hermes/state.db.',
  },
  rlmx: {
    harness: 'rlmx',
    sharedMemory: false,
    writeCapable: false,
    sessionBridgingDemonstrated: false,
    bridge: '',
    note: 'Read-only chat face. Shared truth is the worktree + git artifacts; session bridging exempt (AC4b).',
  },
});

/** The capability row for a harness (total over the four real harnesses). */
export function capabilityRow(harness: Harness): CapabilityRow {
  return CAPABILITY_TABLE[harness];
}

/**
 * The minimal badges rendered under a chat face at hire time. v1 ships exactly one badge —
 * "shared memory" — and only for a harness whose bridge is DEMONSTRATED (Hermes). Everything
 * else renders no badge (the honest default statement carries the rest). Kept minimal on
 * purpose (R10): add tiers only as each is demonstrated.
 */
export function badgesFor(harness: Harness): string[] {
  const row = CAPABILITY_TABLE[harness];
  const badges: string[] = [];
  if (row.sharedMemory && row.sessionBridgingDemonstrated) badges.push('shared memory');
  return badges;
}
