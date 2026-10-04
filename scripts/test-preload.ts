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
