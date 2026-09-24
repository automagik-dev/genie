// Test-suite preload: the one place the runner's own environment is made hermetic.
//
// Hosts export colour policy the suite must not inherit. An agent harness running the
// repository check can set FORCE_COLOR=3, and every CLI a test spawns then paints its
// output: JSON reads fail on the escape codes and the piped-stream contracts (m15) read
// as broken. A test that needs FORCE_COLOR sets it explicitly on the child it spawns.
// Removed, not assigned: `process.env.FORCE_COLOR = undefined` stores the string "undefined".
Reflect.deleteProperty(process.env, 'FORCE_COLOR');
