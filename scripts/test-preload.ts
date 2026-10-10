// Test-suite preload: the one place the runner's own environment is made hermetic.
//
// Hosts export colour policy the suite must not inherit. An agent harness running the
// repository check can set FORCE_COLOR=3, and every CLI a test spawns then paints its
// output: JSON reads fail on the escape codes and the piped-stream contracts (m15) read
// as broken. A test that needs FORCE_COLOR sets it explicitly on the child it spawns.
// Removed, not assigned: `process.env.FORCE_COLOR = undefined` stores the string "undefined".
Reflect.deleteProperty(process.env, 'FORCE_COLOR');

// Opt-in lifecycle capture (`genie metrics enable`) writes to <GENIE_HOME>/metrics/events.jsonl on
// every card event. Most suites spawn task verbs without isolating GENIE_HOME, so on a host that
// enabled capture the suite would append rows for throwaway tmpdir databases to the operator's
// real ledger. Off for the whole run; the metrics tests set their own GENIE_HOME and override it.
process.env.GENIE_METRICS = 'off';

// Runtime markers decide which runtime a card event is attributed to (src/lib/v5/identity.ts). A
// suite run from inside OMP inherits OMPCODE=1, from Codex CODEX_THREAD_ID, from Claude Code
// CLAUDECODE — and a test that sets only CLAUDECODE=1 would then resolve to whichever runtime ran
// the gate. Removed for the whole run; a test that needs one sets it on the child it spawns.
for (const marker of [
  'OMPCODE',
  'CODEX_THREAD_ID',
  'PI_SESSION_ID',
  'PI_SESSION_FILE',
  'CLAUDECODE',
  'CLAUDE_CODE',
  'CLAUDE_CODE_SESSION_ID',
  'GENIE_AGENT_KIND',
]) {
  Reflect.deleteProperty(process.env, marker);
}

// Everything above edits `process.env`, and Bun (1.3) does NOT hand that to a child spawned without
// an explicit `env`: `Bun.spawn`, `Bun.spawnSync` and the synchronous `node:child_process` calls
// built on them give the child the environment the runner was STARTED with. So a test that spawns
// a worker with `{ stdout: 'pipe' }` alone ran it with the host's colour policy, runtime markers
// and no `GENIE_METRICS=off` — on a host with capture enabled, the multi-process race tests in
// src/lib/v5/task-state.test.ts appended a line per card event for their tmpdir databases to the
// operator's real ledger. Defaulting the two primitives to the live environment is what makes the
// edits above reach every child; an explicit `env` is passed through untouched.
// scripts/test-preload.test.ts proves it per spawn API against a sentinel home.
function withLiveEnv(args: unknown[]): unknown[] {
  const [first, second] = args;
  if (Array.isArray(first)) {
    const options = (second ?? {}) as { env?: unknown };
    return options.env === undefined ? [first, { ...options, env: { ...process.env } }] : args;
  }
  const options = first as { env?: unknown } | undefined;
  return options && options.env === undefined ? [{ ...options, env: { ...process.env } }] : args;
}
const bunSpawn = Bun.spawn;
const bunSpawnSync = Bun.spawnSync;
Bun.spawn = ((...args: unknown[]) => Reflect.apply(bunSpawn, Bun, withLiveEnv(args))) as typeof Bun.spawn;
Bun.spawnSync = ((...args: unknown[]) => Reflect.apply(bunSpawnSync, Bun, withLiveEnv(args))) as typeof Bun.spawnSync;
