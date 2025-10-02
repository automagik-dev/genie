const assert = require('assert');
const { parseArguments } = require('../.genie/cli/dist/lib/cli-parser.js');

// Test: parseArguments with basic command
(function testParseArgumentsBasicCommand() {
  const result = parseArguments(['run', 'agent-name', 'prompt text']);
  assert.strictEqual(result.command, 'run', 'command should be extracted');
  assert.deepStrictEqual(result.commandArgs, ['agent-name', 'prompt text'], 'command args should be extracted');
  assert.strictEqual(result.options.requestHelp, undefined, 'help should be undefined by default');
  assert.strictEqual(result.options.full, false, 'full should be false by default');
  assert.strictEqual(result.options.live, false, 'live should be false by default');
})();

// Test: parseArguments with --help flag
(function testParseArgumentsWithHelp() {
  const result = parseArguments(['run', '--help', 'agent-name']);
  assert.strictEqual(result.command, 'run', 'command should be extracted');
  assert.strictEqual(result.options.requestHelp, true, 'help should be true when --help is present');
  assert.deepStrictEqual(result.commandArgs, ['agent-name'], '--help should be filtered out');
})();

// Test: parseArguments with -h flag
(function testParseArgumentsWithShortHelp() {
  const result = parseArguments(['view', '-h', 'session-id']);
  assert.strictEqual(result.command, 'view', 'command should be extracted');
  assert.strictEqual(result.options.requestHelp, true, 'help should be true when -h is present');
  assert.deepStrictEqual(result.commandArgs, ['session-id'], '-h should be filtered out');
})();

// Test: parseArguments with --full flag
(function testParseArgumentsWithFull() {
  const result = parseArguments(['view', 'session-id', '--full']);
  assert.strictEqual(result.command, 'view', 'command should be extracted');
  assert.strictEqual(result.options.full, true, 'full should be true when --full is present');
  assert.deepStrictEqual(result.commandArgs, ['session-id'], '--full should be filtered out');
})();

// Test: parseArguments with --live flag
(function testParseArgumentsWithLive() {
  const result = parseArguments(['view', 'session-id', '--live']);
  assert.strictEqual(result.command, 'view', 'command should be extracted');
  assert.strictEqual(result.options.live, true, 'live should be true when --live is present');
  assert.deepStrictEqual(result.commandArgs, ['session-id'], '--live should be filtered out');
})();

// Test: parseArguments with multiple flags
(function testParseArgumentsWithMultipleFlags() {
  const result = parseArguments(['view', '--full', 'session-id', '--live']);
  assert.strictEqual(result.command, 'view', 'command should be extracted');
  assert.strictEqual(result.options.full, true, 'full should be true');
  assert.strictEqual(result.options.live, true, 'live should be true');
  assert.deepStrictEqual(result.commandArgs, ['session-id'], 'flags should be filtered out');
})();

// Test: parseArguments with -- separator
(function testParseArgumentsWithSeparator() {
  const result = parseArguments(['run', 'agent', '--', '--user-arg', 'value']);
  assert.strictEqual(result.command, 'run', 'command should be extracted');
  assert.deepStrictEqual(result.commandArgs, ['agent', '--user-arg', 'value'], 'args after -- should be preserved');
  assert.strictEqual(result.options.full, false, 'full should be false');
})();

// Test: parseArguments with empty argv
(function testParseArgumentsEmpty() {
  const result = parseArguments([]);
  assert.strictEqual(result.command, undefined, 'command should be undefined for empty input');
  assert.deepStrictEqual(result.commandArgs, [], 'commandArgs should be empty');
})();

// Test: parseArguments with only command
(function testParseArgumentsOnlyCommand() {
  const result = parseArguments(['help']);
  assert.strictEqual(result.command, 'help', 'command should be extracted');
  assert.deepStrictEqual(result.commandArgs, [], 'commandArgs should be empty');
})();

// Test: parseArguments case insensitive command
(function testParseArgumentsCaseInsensitive() {
  const result = parseArguments(['RUN', 'agent']);
  assert.strictEqual(result.command, 'run', 'command should be lowercased');
  assert.deepStrictEqual(result.commandArgs, ['agent'], 'args should be preserved');
})();

// Test: parseArguments preserves rawArgs
(function testParseArgumentsRawArgs() {
  const argv = ['run', '--full', 'agent', 'prompt'];
  const result = parseArguments(argv);
  assert.deepStrictEqual(result.options.rawArgs, argv, 'rawArgs should be preserved exactly');
})();

console.log('✅ cli-parser tests passed');
