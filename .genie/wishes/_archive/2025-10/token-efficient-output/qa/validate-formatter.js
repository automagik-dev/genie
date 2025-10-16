#!/usr/bin/env node

/**
 * Validation script for markdown-formatter
 *
 * Demonstrates all 3 output modes and measures token counts
 */

import {
  formatTranscriptMarkdown,
  formatSessionList
} from '../../../cli/dist/lib/markdown-formatter.js';

// Test data
const mockMessages = [
  {
    role: 'assistant',
    title: 'Starting implementation',
    body: ['Creating markdown-formatter.ts with 3 output modes...']
  },
  {
    role: 'reasoning',
    title: 'Analyzing requirements',
    body: ['Need to support final, recent, and overview modes', 'Token budgets: 500, 300, 400']
  },
  {
    role: 'tool',
    title: 'Read file',
    body: ['Read transcript-utils.ts (379 lines)', 'Found ChatMessage[] structure']
  },
  {
    role: 'assistant',
    title: 'Types defined',
    body: ['Added OutputMode, SessionMeta, SessionEntry types']
  },
  {
    role: 'assistant',
    title: 'Implementation complete',
    body: [
      'All 3 modes implemented:',
      '- final: last message only',
      '- recent: last 5 messages',
      '- overview: metadata + checkpoints'
    ]
  }
];

const mockMeta = {
  sessionId: 'abc123-def456-ghi789',
  agent: 'implementor',
  status: 'running',
  executor: 'claude',
  tokens: { input: 5000, output: 3000, total: 8000 },
  toolCalls: [
    { name: 'Read', count: 12 },
    { name: 'Write', count: 5 },
    { name: 'Edit', count: 8 }
  ],
  model: 'sonnet-4'
};

const mockSessions = [
  {
    sessionId: 'abc123-def456-ghi789',
    agent: 'implementor',
    status: 'running',
    executor: 'claude'
  },
  {
    sessionId: 'xyz789-uvw456-rst123',
    agent: 'tests',
    status: 'completed',
    executor: 'codex'
  }
];

console.log('🧪 Markdown Formatter Validation\n');

// Test Mode 1: final
console.log('='.repeat(60));
console.log('MODE 1: FINAL (Last message only)');
console.log('='.repeat(60));
const finalOutput = formatTranscriptMarkdown(mockMessages, mockMeta, 'final');
console.log(finalOutput);
console.log(`\nCharacters: ${finalOutput.length}`);
console.log(`Estimated tokens: ~${Math.ceil(finalOutput.length / 4)}`);
console.log(`Budget: 500 tokens`);
console.log(`Status: ${Math.ceil(finalOutput.length / 4) < 500 ? '✅ PASS' : '❌ FAIL'}\n`);

// Test Mode 2: recent
console.log('='.repeat(60));
console.log('MODE 2: RECENT (Last 5 messages)');
console.log('='.repeat(60));
const recentOutput = formatTranscriptMarkdown(mockMessages, mockMeta, 'recent');
console.log(recentOutput);
console.log(`\nCharacters: ${recentOutput.length}`);
console.log(`Estimated tokens: ~${Math.ceil(recentOutput.length / 4)}`);
console.log(`Budget: 300 tokens`);
console.log(`Status: ${Math.ceil(recentOutput.length / 4) < 300 ? '✅ PASS' : '❌ FAIL'}\n`);

// Test Mode 3: overview
console.log('='.repeat(60));
console.log('MODE 3: OVERVIEW (Metadata + checkpoints)');
console.log('='.repeat(60));
const overviewOutput = formatTranscriptMarkdown(mockMessages, mockMeta, 'overview');
console.log(overviewOutput);
console.log(`\nCharacters: ${overviewOutput.length}`);
console.log(`Estimated tokens: ~${Math.ceil(overviewOutput.length / 4)}`);
console.log(`Budget: 400 tokens`);
console.log(`Status: ${Math.ceil(overviewOutput.length / 4) < 400 ? '✅ PASS' : '❌ FAIL'}\n`);

// Test Session List
console.log('='.repeat(60));
console.log('SESSION LIST');
console.log('='.repeat(60));
const listOutput = formatSessionList(mockSessions);
console.log(listOutput);
console.log(`\nCharacters: ${listOutput.length}`);
console.log(`Estimated tokens: ~${Math.ceil(listOutput.length / 4)}\n`);

// Summary
console.log('='.repeat(60));
console.log('SUMMARY');
console.log('='.repeat(60));
console.log(`Final mode:    ${Math.ceil(finalOutput.length / 4)} tokens (budget: 500) - ${Math.ceil(finalOutput.length / 4) < 500 ? '✅' : '❌'}`);
console.log(`Recent mode:   ${Math.ceil(recentOutput.length / 4)} tokens (budget: 300) - ${Math.ceil(recentOutput.length / 4) < 300 ? '✅' : '❌'}`);
console.log(`Overview mode: ${Math.ceil(overviewOutput.length / 4)} tokens (budget: 400) - ${Math.ceil(overviewOutput.length / 4) < 400 ? '✅' : '❌'}`);
console.log(`Session list:  ${Math.ceil(listOutput.length / 4)} tokens (no budget)\n`);

const allPassed =
  Math.ceil(finalOutput.length / 4) < 500 &&
  Math.ceil(recentOutput.length / 4) < 300 &&
  Math.ceil(overviewOutput.length / 4) < 400;

if (allPassed) {
  console.log('✅ All validations PASSED\n');
  process.exit(0);
} else {
  console.log('❌ Some validations FAILED\n');
  process.exit(1);
}
