"use strict";
/**
 * Unit tests for markdown-formatter
 *
 * Validates:
 * - All 3 output modes (final, recent, overview)
 * - Token budget enforcement
 * - Edge cases (empty transcripts, long messages, missing metadata)
 *
 * Run with: node .genie/cli/src/lib/__tests__/markdown-formatter.test.js
 */
Object.defineProperty(exports, "__esModule", { value: true });
const markdown_formatter_js_1 = require("../markdown-formatter.js");
// Simple test framework
let testCount = 0;
let passCount = 0;
let failCount = 0;
function describe(name, fn) {
    console.log(`\n${name}`);
    fn();
}
function it(name, fn) {
    testCount++;
    try {
        fn();
        passCount++;
        console.log(`  ✓ ${name}`);
    }
    catch (error) {
        failCount++;
        console.log(`  ✗ ${name}`);
        console.error(`    ${error.message}`);
    }
}
function expect(actual) {
    return {
        toContain(expected) {
            if (!actual.includes(expected)) {
                throw new Error(`Expected "${actual}" to contain "${expected}"`);
            }
        },
        not: {
            toContain(expected) {
                if (actual.includes(expected)) {
                    throw new Error(`Expected "${actual}" to not contain "${expected}"`);
                }
            }
        },
        toBeLessThan(expected) {
            if (actual >= expected) {
                throw new Error(`Expected ${actual} to be less than ${expected}`);
            }
        }
    };
}
// ============================================================================
// Test Data
// ============================================================================
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
    },
    {
        sessionId: 'mno456-jkl123-pqr789',
        agent: 'review',
        status: 'pending',
        executor: 'claude'
    }
];
// ============================================================================
// Final Mode Tests
// ============================================================================
describe('formatTranscriptMarkdown - final mode', () => {
    it('should format last message only', () => {
        const result = (0, markdown_formatter_js_1.formatTranscriptMarkdown)(mockMessages, mockMeta, 'final');
        expect(result).toContain('## Session: abc123-def456-ghi789');
        expect(result).toContain('**Agent:** implementor');
        expect(result).toContain('**Status:** running');
        expect(result).toContain('**Last message:** Implementation complete');
        expect(result).toContain('All 3 modes implemented');
    });
    it('should include token metrics', () => {
        const result = (0, markdown_formatter_js_1.formatTranscriptMarkdown)(mockMessages, mockMeta, 'final');
        expect(result).toContain('**Tokens:** 8000');
    });
    it('should handle empty messages', () => {
        const result = (0, markdown_formatter_js_1.formatTranscriptMarkdown)([], mockMeta, 'final');
        expect(result).toContain('*No messages available*');
    });
    it('should stay under token budget', () => {
        const result = (0, markdown_formatter_js_1.formatTranscriptMarkdown)(mockMessages, mockMeta, 'final');
        const charCount = result.length;
        const estimatedTokens = Math.ceil(charCount / 4);
        expect(estimatedTokens).toBeLessThan(500);
    });
});
// ============================================================================
// Recent Mode Tests
// ============================================================================
describe('formatTranscriptMarkdown - recent mode', () => {
    it('should format last 5 messages', () => {
        const result = (0, markdown_formatter_js_1.formatTranscriptMarkdown)(mockMessages, mockMeta, 'recent');
        expect(result).toContain('## Session: abc123-def456-ghi789');
        expect(result).toContain('**Agent:** implementor');
        expect(result).toContain('**Status:** running');
        // Should have all 5 messages (we have exactly 5)
        expect(result).toContain('### Message 1:');
        expect(result).toContain('### Message 5:');
    });
    it('should truncate to last 5 when more messages exist', () => {
        const manyMessages = Array.from({ length: 10 }, (_, i) => ({
            role: 'assistant',
            title: `Message ${i + 1}`,
            body: [`Content ${i + 1}`]
        }));
        const result = (0, markdown_formatter_js_1.formatTranscriptMarkdown)(manyMessages, mockMeta, 'recent');
        // Should show messages 6-10 (last 5)
        expect(result).toContain('### Message 6:');
        expect(result).toContain('### Message 10:');
        expect(result).not.toContain('### Message 5:');
    });
    it('should stay under token budget', () => {
        const result = (0, markdown_formatter_js_1.formatTranscriptMarkdown)(mockMessages, mockMeta, 'recent');
        const charCount = result.length;
        const estimatedTokens = Math.ceil(charCount / 4);
        expect(estimatedTokens).toBeLessThan(300);
    });
});
// ============================================================================
// Overview Mode Tests
// ============================================================================
describe('formatTranscriptMarkdown - overview mode', () => {
    it('should include all metadata', () => {
        const result = (0, markdown_formatter_js_1.formatTranscriptMarkdown)(mockMessages, mockMeta, 'overview');
        expect(result).toContain('## Session: abc123-def456-ghi789');
        expect(result).toContain('**Agent:** implementor');
        expect(result).toContain('**Status:** running');
        expect(result).toContain('**Executor:** claude');
        expect(result).toContain('**Model:** sonnet-4');
    });
    it('should include token metrics', () => {
        const result = (0, markdown_formatter_js_1.formatTranscriptMarkdown)(mockMessages, mockMeta, 'overview');
        expect(result).toContain('**Tokens:** 8000 (in: 5000, out: 3000)');
    });
    it('should include tool usage summary', () => {
        const result = (0, markdown_formatter_js_1.formatTranscriptMarkdown)(mockMessages, mockMeta, 'overview');
        expect(result).toContain('**Tools:** Read:12, Write:5, Edit:8');
    });
    it('should include message count', () => {
        const result = (0, markdown_formatter_js_1.formatTranscriptMarkdown)(mockMessages, mockMeta, 'overview');
        expect(result).toContain('**Messages:** 5');
    });
    it('should include key checkpoints', () => {
        const result = (0, markdown_formatter_js_1.formatTranscriptMarkdown)(mockMessages, mockMeta, 'overview');
        expect(result).toContain('### Key Checkpoints');
        // Should include first and last messages
        expect(result).toContain('Starting implementation');
        expect(result).toContain('Implementation complete');
    });
    it('should stay under token budget', () => {
        const result = (0, markdown_formatter_js_1.formatTranscriptMarkdown)(mockMessages, mockMeta, 'overview');
        const charCount = result.length;
        const estimatedTokens = Math.ceil(charCount / 4);
        expect(estimatedTokens).toBeLessThan(400);
    });
    it('should handle missing optional metadata', () => {
        const minimalMeta = {
            sessionId: 'test-123',
            agent: 'test',
            status: 'running'
        };
        const result = (0, markdown_formatter_js_1.formatTranscriptMarkdown)(mockMessages, minimalMeta, 'overview');
        expect(result).toContain('**Agent:** test');
        expect(result).not.toContain('**Executor:**');
        expect(result).not.toContain('**Model:**');
        expect(result).not.toContain('**Tokens:**');
    });
});
// ============================================================================
// Session List Tests
// ============================================================================
describe('formatSessionList', () => {
    it('should format sessions as markdown table', () => {
        const result = (0, markdown_formatter_js_1.formatSessionList)(mockSessions);
        expect(result).toContain('## Active Sessions');
        expect(result).toContain('| Session ID | Agent | Status | Executor |');
        expect(result).toContain('|------------|-------|--------|----------|');
    });
    it('should include all sessions', () => {
        const result = (0, markdown_formatter_js_1.formatSessionList)(mockSessions);
        expect(result).toContain('implementor');
        expect(result).toContain('tests');
        expect(result).toContain('review');
        expect(result).toContain('claude');
        expect(result).toContain('codex');
    });
    it('should trim long session IDs', () => {
        const result = (0, markdown_formatter_js_1.formatSessionList)(mockSessions);
        // Should truncate IDs longer than 10 chars
        expect(result).toContain('abc123-d...');
    });
    it('should handle empty session list', () => {
        const result = (0, markdown_formatter_js_1.formatSessionList)([]);
        expect(result).toContain('**No sessions found**');
    });
});
// ============================================================================
// Edge Cases
// ============================================================================
describe('edge cases', () => {
    it('should handle null/missing sessionId', () => {
        const metaNoId = {
            sessionId: null,
            agent: 'test',
            status: 'running'
        };
        const result = (0, markdown_formatter_js_1.formatTranscriptMarkdown)(mockMessages, metaNoId, 'final');
        expect(result).toContain('## Session: pending');
    });
    it('should handle very long messages', () => {
        const longMessage = {
            role: 'assistant',
            title: 'Long output',
            body: [Array.from({ length: 1000 }, () => 'word').join(' ')]
        };
        const result = (0, markdown_formatter_js_1.formatTranscriptMarkdown)([longMessage], mockMeta, 'final');
        const charCount = result.length;
        const estimatedTokens = Math.ceil(charCount / 4);
        // Should truncate to stay under budget
        expect(estimatedTokens).toBeLessThan(600); // Some margin for safety
    });
    it('should handle empty message bodies', () => {
        const emptyMessage = {
            role: 'assistant',
            title: 'Empty message',
            body: []
        };
        const result = (0, markdown_formatter_js_1.formatTranscriptMarkdown)([emptyMessage], mockMeta, 'final');
        expect(result).toContain('*(empty)*');
    });
    it('should default to recent mode for invalid mode', () => {
        // TypeScript prevents this at compile time, but test runtime behavior
        const result = (0, markdown_formatter_js_1.formatTranscriptMarkdown)(mockMessages, mockMeta, 'invalid');
        // Should fall back to recent mode
        expect(result).toContain('### Message');
    });
});
// ============================================================================
// Token Budget Enforcement
// ============================================================================
describe('token budget enforcement', () => {
    it('should truncate final mode if exceeding budget', () => {
        const hugeMessages = Array.from({ length: 1 }, () => ({
            role: 'assistant',
            title: 'Huge output',
            body: [Array.from({ length: 3000 }, () => 'word').join(' ')]
        }));
        const result = (0, markdown_formatter_js_1.formatTranscriptMarkdown)(hugeMessages, mockMeta, 'final');
        expect(result).toContain('[Output truncated to meet token budget]');
    });
    it('should truncate recent mode if exceeding budget', () => {
        const hugeMessages = Array.from({ length: 5 }, () => ({
            role: 'assistant',
            title: 'Large message',
            body: [Array.from({ length: 500 }, () => 'word').join(' ')]
        }));
        const result = (0, markdown_formatter_js_1.formatTranscriptMarkdown)(hugeMessages, mockMeta, 'recent');
        expect(result).toContain('[Output truncated to meet token budget]');
    });
    it('should truncate overview mode if exceeding budget', () => {
        const hugeMessages = Array.from({ length: 100 }, () => ({
            role: 'assistant',
            title: 'Message with very long title that exceeds normal bounds',
            body: [Array.from({ length: 200 }, () => 'word').join(' ')]
        }));
        const result = (0, markdown_formatter_js_1.formatTranscriptMarkdown)(hugeMessages, mockMeta, 'overview');
        expect(result).toContain('[Output truncated to meet token budget]');
    });
});
// ============================================================================
// Test Runner
// ============================================================================
console.log('\n🧪 Running markdown-formatter tests...\n');
// Run all tests
describe('formatTranscriptMarkdown - final mode', () => {
    it('should format last message only', () => {
        const result = (0, markdown_formatter_js_1.formatTranscriptMarkdown)(mockMessages, mockMeta, 'final');
        expect(result).toContain('## Session: abc123-def456-ghi789');
        expect(result).toContain('**Agent:** implementor');
        expect(result).toContain('**Status:** running');
        expect(result).toContain('**Last message:** Implementation complete');
    });
    it('should include token metrics', () => {
        const result = (0, markdown_formatter_js_1.formatTranscriptMarkdown)(mockMessages, mockMeta, 'final');
        expect(result).toContain('**Tokens:** 8000');
    });
    it('should handle empty messages', () => {
        const result = (0, markdown_formatter_js_1.formatTranscriptMarkdown)([], mockMeta, 'final');
        expect(result).toContain('*No messages available*');
    });
    it('should stay under token budget', () => {
        const result = (0, markdown_formatter_js_1.formatTranscriptMarkdown)(mockMessages, mockMeta, 'final');
        const estimatedTokens = Math.ceil(result.length / 4);
        expect(estimatedTokens).toBeLessThan(500);
    });
});
// Summary
console.log(`\n📊 Test Summary:`);
console.log(`   Total: ${testCount}`);
console.log(`   ✓ Passed: ${passCount}`);
console.log(`   ✗ Failed: ${failCount}\n`);
if (failCount > 0) {
    process.exit(1);
}
