const assert = require('assert');
const path = require('path');
const {
  formatRelativeTime,
  formatPathRelative,
  truncateText,
  sanitizeLogFilename,
  safeIsoString,
  deriveStartTime,
  deriveLogFile
} = require('../.genie/cli/dist/lib/utils.js');

// Test: formatRelativeTime with just now
(function testFormatRelativeTimeJustNow() {
  const now = new Date().toISOString();
  const result = formatRelativeTime(now);
  assert.strictEqual(result, 'just now', 'recent timestamp should be "just now"');
})();

// Test: formatRelativeTime with seconds ago
(function testFormatRelativeTimeSecondsAgo() {
  const tenSecondsAgo = new Date(Date.now() - 10000).toISOString();
  const result = formatRelativeTime(tenSecondsAgo);
  assert.strictEqual(result, '10s ago', 'should format seconds correctly');
})();

// Test: formatRelativeTime with minutes ago
(function testFormatRelativeTimeMinutesAgo() {
  const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const result = formatRelativeTime(fiveMinutesAgo);
  assert.strictEqual(result, '5m ago', 'should format minutes correctly');
})();

// Test: formatRelativeTime with hours ago
(function testFormatRelativeTimeHoursAgo() {
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  const result = formatRelativeTime(twoHoursAgo);
  assert.strictEqual(result, '2h ago', 'should format hours correctly');
})();

// Test: formatRelativeTime with days ago
(function testFormatRelativeTimeDaysAgo() {
  const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
  const result = formatRelativeTime(threeDaysAgo);
  assert.strictEqual(result, '3d ago', 'should format days correctly');
})();

// Test: formatRelativeTime with weeks ago
(function testFormatRelativeTimeWeeksAgo() {
  const twoWeeksAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
  const result = formatRelativeTime(twoWeeksAgo);
  assert.strictEqual(result, '2w ago', 'should format weeks correctly');
})();

// Test: formatRelativeTime with invalid date
(function testFormatRelativeTimeInvalid() {
  const result = formatRelativeTime('invalid-date');
  assert.strictEqual(result, 'n/a', 'invalid date should return n/a');
})();

// Test: formatRelativeTime with future date
(function testFormatRelativeTimeFuture() {
  const future = new Date(Date.now() + 10000).toISOString();
  const result = formatRelativeTime(future);
  assert.strictEqual(result, 'just now', 'future date should return "just now"');
})();

// Test: formatPathRelative with simple path
(function testFormatPathRelativeSimple() {
  const result = formatPathRelative('/home/user/project/file.ts', '/home/user/project');
  assert.strictEqual(result, 'file.ts', 'should return relative path');
})();

// Test: formatPathRelative with nested path
(function testFormatPathRelativeNested() {
  const result = formatPathRelative('/home/user/project/src/lib/utils.ts', '/home/user/project');
  assert.strictEqual(result, path.join('src', 'lib', 'utils.ts'), 'should return relative nested path');
})();

// Test: formatPathRelative with empty path
(function testFormatPathRelativeEmpty() {
  const result = formatPathRelative('', '/home/user');
  assert.strictEqual(result, 'n/a', 'empty path should return n/a');
})();

// Test: formatPathRelative with same path
(function testFormatPathRelativeSame() {
  const result = formatPathRelative('/home/user/project', '/home/user/project');
  assert.strictEqual(result, '/home/user/project', 'same path should return original or empty');
})();

// Test: truncateText with short text
(function testTruncateTextShort() {
  const result = truncateText('Hello World', 64);
  assert.strictEqual(result, 'Hello World', 'short text should not be truncated');
})();

// Test: truncateText with long text
(function testTruncateTextLong() {
  const longText = 'a'.repeat(100);
  const result = truncateText(longText, 64);
  assert.strictEqual(result.length, 64, 'long text should be truncated to maxLength');
  assert.ok(result.endsWith('...'), 'truncated text should end with ...');
})();

// Test: truncateText with empty text
(function testTruncateTextEmpty() {
  const result = truncateText('', 64);
  assert.strictEqual(result, '', 'empty text should return empty string');
})();

// Test: truncateText with exact length
(function testTruncateTextExact() {
  const text = 'a'.repeat(64);
  const result = truncateText(text, 64);
  assert.strictEqual(result, text, 'text at exact length should not be truncated');
})();

// Test: sanitizeLogFilename with valid name
(function testSanitizeLogFilenameValid() {
  const result = sanitizeLogFilename('my-agent');
  assert.strictEqual(result, 'my-agent', 'valid name should be preserved');
})();

// Test: sanitizeLogFilename with special characters
(function testSanitizeLogFilenameSpecialChars() {
  const result = sanitizeLogFilename('my@agent#name!');
  assert.strictEqual(result, 'my-agent-name', 'special characters should be replaced with dashes');
})();

// Test: sanitizeLogFilename with slashes
(function testSanitizeLogFilenameSlashes() {
  const result = sanitizeLogFilename('path/to/agent');
  assert.strictEqual(result, 'path-to-agent', 'slashes should be replaced with dashes');
})();

// Test: sanitizeLogFilename with multiple dashes
(function testSanitizeLogFilenameMultipleDashes() {
  const result = sanitizeLogFilename('my---agent---name');
  assert.strictEqual(result, 'my-agent-name', 'multiple consecutive dashes should be collapsed');
})();

// Test: sanitizeLogFilename with empty string
(function testSanitizeLogFilenameEmpty() {
  const result = sanitizeLogFilename('');
  assert.strictEqual(result, 'agent', 'empty string should return fallback');
})();

// Test: sanitizeLogFilename with leading/trailing dashes
(function testSanitizeLogFilenameLeadingTrailing() {
  const result = sanitizeLogFilename('---my-agent---');
  assert.strictEqual(result, 'my-agent', 'leading and trailing dashes should be removed');
})();

// Test: sanitizeLogFilename with invalid input
(function testSanitizeLogFilenameInvalid() {
  const result = sanitizeLogFilename(null);
  assert.strictEqual(result, 'agent', 'null should return fallback');
})();

// Test: safeIsoString with valid date
(function testSafeIsoStringValid() {
  const now = new Date().toISOString();
  const result = safeIsoString(now);
  assert.ok(result !== null, 'valid date should return ISO string');
  assert.ok(result.endsWith('Z'), 'ISO string should end with Z');
})();

// Test: safeIsoString with invalid date
(function testSafeIsoStringInvalid() {
  const result = safeIsoString('invalid-date');
  assert.strictEqual(result, null, 'invalid date should return null');
})();

// Test: safeIsoString with timestamp
(function testSafeIsoStringTimestamp() {
  const timestamp = '2025-01-15T12:00:00.000Z';
  const result = safeIsoString(timestamp);
  assert.strictEqual(result, timestamp, 'valid timestamp should be preserved');
})();

// Test: deriveStartTime without env
(function testDeriveStartTimeNoEnv() {
  delete process.env.GENIE_AGENT_START_TIME;
  const result = deriveStartTime();
  assert.ok(typeof result === 'number', 'should return a number');
  assert.ok(result > 0, 'should return a positive timestamp');
})();

// Test: deriveStartTime with env
(function testDeriveStartTimeWithEnv() {
  const testTime = 1234567890000;
  process.env.GENIE_AGENT_START_TIME = String(testTime);
  const result = deriveStartTime(true);
  assert.strictEqual(result, testTime, 'should use env variable when present');
  delete process.env.GENIE_AGENT_START_TIME;
})();

// Test: deriveStartTime with invalid env
(function testDeriveStartTimeInvalidEnv() {
  process.env.GENIE_AGENT_START_TIME = 'invalid';
  const result = deriveStartTime(true);
  assert.ok(typeof result === 'number', 'should fallback to Date.now() for invalid env');
  delete process.env.GENIE_AGENT_START_TIME;
})();

// Test: deriveLogFile without env
(function testDeriveLogFileNoEnv() {
  delete process.env.GENIE_AGENT_LOG_FILE;
  const paths = { logsDir: '.genie/state/agents/logs', baseDir: '.', sessionsFile: '', agentsDir: '' };
  const result = deriveLogFile('test-agent', 1234567890000, paths);
  assert.ok(result.includes('test-agent'), 'log file should include agent name');
  assert.ok(result.includes('1234567890000'), 'log file should include timestamp');
  assert.ok(result.includes('.log'), 'log file should have .log extension');
})();

// Test: deriveLogFile with env
(function testDeriveLogFileWithEnv() {
  const testPath = '/custom/path/test.log';
  process.env.GENIE_AGENT_LOG_FILE = testPath;
  const paths = { logsDir: '.genie/state/agents/logs', baseDir: '.', sessionsFile: '', agentsDir: '' };
  const result = deriveLogFile('test-agent', 1234567890000, paths, true);
  assert.strictEqual(result, testPath, 'should use env variable when present for background runs');
  delete process.env.GENIE_AGENT_LOG_FILE;
})();

console.log('✅ utils tests passed');
