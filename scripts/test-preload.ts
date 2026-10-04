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
