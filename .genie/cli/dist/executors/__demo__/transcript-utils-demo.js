"use strict";
/**
 * Demonstration script for transcript utilities
 *
 * This script shows how the shared utilities work with sample data.
 * Run with: node --loader ts-node/esm transcript-utils-demo.ts
 */
Object.defineProperty(exports, "__esModule", { value: true });
const transcript_utils_1 = require("../transcript-utils");
console.log('='.repeat(80));
console.log('TRANSCRIPT UTILITIES DEMONSTRATION');
console.log('='.repeat(80));
console.log('');
// Sample messages
const sampleMessages = [
    { role: 'action', title: 'User Input', body: ['Tell me about transcript utilities'] },
    { role: 'reasoning', title: 'Planning', body: ['I need to explain the utilities...'] },
    { role: 'assistant', title: 'Response 1', body: ['Transcript utilities help slice messages...'] },
    { role: 'tool', title: 'Read File', body: ['Reading transcript-utils.ts...'] },
    { role: 'reasoning', title: 'Analyzing', body: ['The file contains slicing functions...'] },
    { role: 'reasoning', title: 'Synthesizing', body: ['Let me summarize the key features...'] },
    { role: 'assistant', title: 'Response 2', body: ['The utilities provide three main functions...'] }
];
// Test sliceForLatest
console.log('--- sliceForLatest (for --live mode) ---');
console.log('Input: 7 messages');
const latestSlice = (0, transcript_utils_1.sliceForLatest)(sampleMessages);
console.log(`Output: ${latestSlice.length} messages`);
console.log('Messages:');
latestSlice.forEach((msg, i) => {
    console.log(`  ${i + 1}. [${msg.role}] ${msg.title}`);
});
console.log('');
// Test sliceForRecent
console.log('--- sliceForRecent (for default mode) ---');
console.log('Input: 7 messages, count: 5');
const recentSlice = (0, transcript_utils_1.sliceForRecent)(sampleMessages, 5);
console.log(`Output: ${recentSlice.length} messages`);
console.log('Messages:');
recentSlice.forEach((msg, i) => {
    console.log(`  ${i + 1}. [${msg.role}] ${msg.title}`);
});
console.log('');
// Test Codex metrics summarization
console.log('--- summarizeCodexMetrics ---');
const codexMetrics = {
    tokens: { input: 1234, output: 567, total: 1801 },
    mcpCalls: [
        { server: 'forge', tool: 'create', secs: 1.2 },
        { server: 'forge', tool: 'list', secs: 0.5 },
        { server: 'forge', tool: 'update', secs: 0.8 },
        { server: 'gh', tool: 'pr', secs: 2.1 },
        { server: 'gh', tool: 'issue', secs: 1.5 },
        { server: 'slack', tool: 'send', secs: 0.3 }
    ],
    patches: { add: 2, update: 3, move: 0, delete: 1 },
    execs: [
        { cmd: 'ls -la', exit: 0, dur: { secs: 0, nanos: 5000000 } },
        { cmd: 'cat file.txt', exit: 0, dur: { secs: 0, nanos: 3000000 } },
        { cmd: 'grep pattern', exit: 1, dur: { secs: 0, nanos: 8000000 } }
    ],
    rateLimits: { used_percent: 45, resets_in_seconds: 120 }
};
const codexSummary = (0, transcript_utils_1.summarizeCodexMetrics)(codexMetrics);
console.log('Summarized metrics:');
codexSummary.forEach((item) => {
    const toneStr = item.tone ? ` [${item.tone}]` : '';
    console.log(`  ${item.label}: ${item.value}${toneStr}`);
});
console.log('');
// Test Claude metrics summarization
console.log('--- summarizeClaudeMetrics ---');
const claudeMetrics = {
    tokens: { input: 890, output: 234, total: 1124 },
    toolCalls: [
        { name: 'Read', count: 5 },
        { name: 'Bash', count: 3 },
        { name: 'Edit', count: 2 },
        { name: 'Write', count: 1 }
    ],
    model: 'claude-sonnet-4'
};
const claudeSummary = (0, transcript_utils_1.summarizeClaudeMetrics)(claudeMetrics);
console.log('Summarized metrics:');
claudeSummary.forEach((item) => {
    const toneStr = item.tone ? ` [${item.tone}]` : '';
    console.log(`  ${item.label}: ${item.value}${toneStr}`);
});
console.log('');
// Test aggregateToolCalls
console.log('--- aggregateToolCalls ---');
const rawToolCalls = [
    { name: 'Read' },
    { name: 'Bash' },
    { name: 'Read' },
    { name: 'Edit' },
    { name: 'Read' },
    { name: 'Bash' },
    { name: 'Read' },
    { name: 'Write' },
    { name: 'Read' }
];
console.log(`Input: ${rawToolCalls.length} tool calls`);
const aggregated = (0, transcript_utils_1.aggregateToolCalls)(rawToolCalls);
console.log('Output:');
aggregated.forEach((tc) => {
    console.log(`  ${tc.name}: ${tc.count} calls`);
});
console.log('');
console.log('='.repeat(80));
console.log('DEMONSTRATION COMPLETE');
console.log('='.repeat(80));
console.log('');
console.log('Key Takeaways:');
console.log('- sliceForLatest: Returns latest assistant + preceding reasoning');
console.log('- sliceForRecent: Returns last N messages (no type filtering)');
console.log('- summarizeCodexMetrics: Concise single-line summaries for header');
console.log('- summarizeClaudeMetrics: Similar format, Claude-specific data');
console.log('- aggregateToolCalls: Helper to count tools by name');
console.log('');
console.log('Next Steps:');
console.log('1. Group A: Implement Codex log viewer using these utilities');
console.log('2. Group B: Implement Claude log viewer using these utilities');
console.log('3. Group C: Consider using sliceForRecent in fallback logic');
console.log('');
