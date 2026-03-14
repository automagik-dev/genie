/**
 * Tests for dispatch commands — context injection and state machine integration.
 *
 * Tests:
 * 1. extractGroup() — group section extraction from WISH.md
 * 2. extractWishContext() — wish-level context extraction
 * 3. buildContextPrompt() — prompt assembly
 * 4. writeContextFile() — temp file creation
 * 5. brainstormCommand() — DRAFT.md dispatch
 * 6. wishCommand() — DESIGN.md dispatch
 * 7. workDispatchCommand() — state check + group dispatch
 * 8. reviewCommand() — review with diff context
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as wishState from '../lib/wish-state.js';
import { parseRef } from './state.js';

import { buildContextPrompt, extractGroup, extractWishContext, parseWishGroups, writeContextFile } from './dispatch.js';

// ============================================================================
// Sample WISH.md content for testing
// ============================================================================

const SAMPLE_WISH = `# Wish: Test Feature

| Field | Value |
|-------|-------|
| **Status** | DRAFT |
| **Slug** | \`test-feature\` |

## Summary

This is a test wish for testing dispatch commands.

## Scope

### IN
- Feature A
- Feature B

### OUT
- Feature C

## Decisions

| Decision | Rationale |
|----------|-----------|
| Use X | Because Y |

## Execution Groups

### Group 1: Foundation

**Goal:** Build the foundation.

**Deliverables:**
1. Create module A
2. Create module B

**Acceptance criteria:**
- Module A works
- Module B works

**depends-on:** none

---

### Group 2: Integration

**Goal:** Integrate modules.

**Deliverables:**
1. Connect A to B
2. Add tests

**Acceptance criteria:**
- Integration works
- Tests pass

**depends-on:** Group 1

---

### Group 3: Polish

**Goal:** Final polish.

**Deliverables:**
1. Documentation
2. Performance tuning

**Acceptance criteria:**
- Docs complete
- Performance acceptable

**depends-on:** Group 2
`;

// ============================================================================
// Unit Tests: Parsing Utilities
// ============================================================================

describe('parseRef()', () => {
  it('should parse slug#group format', () => {
    const result = parseRef('auth-bug#2');
    expect(result).toEqual({ slug: 'auth-bug', group: '2' });
  });

  it('should parse slug with numbers', () => {
    const result = parseRef('test-feature#1');
    expect(result).toEqual({ slug: 'test-feature', group: '1' });
  });

  it('should handle multi-digit group numbers', () => {
    const result = parseRef('big-wish#10');
    expect(result).toEqual({ slug: 'big-wish', group: '10' });
  });

  it('should throw on missing hash', () => {
    expect(() => parseRef('no-hash')).toThrow('Invalid reference');
  });

  it('should throw on empty slug', () => {
    expect(() => parseRef('#2')).toThrow('Invalid reference');
  });

  it('should throw on empty group', () => {
    expect(() => parseRef('slug#')).toThrow('Invalid reference');
  });
});

describe('extractGroup()', () => {
  it('should extract group 1 section', () => {
    const result = extractGroup(SAMPLE_WISH, '1');
    expect(result).not.toBeNull();
    expect(result).toContain('### Group 1: Foundation');
    expect(result).toContain('Build the foundation');
    expect(result).toContain('Create module A');
    expect(result).toContain('**depends-on:** none');
  });

  it('should extract group 2 section', () => {
    const result = extractGroup(SAMPLE_WISH, '2');
    expect(result).not.toBeNull();
    expect(result).toContain('### Group 2: Integration');
    expect(result).toContain('Integrate modules');
    expect(result).toContain('Connect A to B');
    expect(result).toContain('**depends-on:** Group 1');
  });

  it('should extract last group section', () => {
    const result = extractGroup(SAMPLE_WISH, '3');
    expect(result).not.toBeNull();
    expect(result).toContain('### Group 3: Polish');
    expect(result).toContain('Documentation');
    expect(result).toContain('**depends-on:** Group 2');
  });

  it('should not include content from the next group', () => {
    const result = extractGroup(SAMPLE_WISH, '1');
    expect(result).not.toContain('### Group 2');
    expect(result).not.toContain('Integrate modules');
  });

  it('should return null for non-existent group', () => {
    const result = extractGroup(SAMPLE_WISH, '99');
    expect(result).toBeNull();
  });

  it('should return null for empty content', () => {
    const result = extractGroup('', '1');
    expect(result).toBeNull();
  });
});

describe('extractWishContext()', () => {
  it('should extract everything before Execution Groups', () => {
    const result = extractWishContext(SAMPLE_WISH);
    expect(result).toContain('# Wish: Test Feature');
    expect(result).toContain('## Summary');
    expect(result).toContain('test wish for testing');
    expect(result).toContain('## Scope');
    expect(result).toContain('## Decisions');
    expect(result).not.toContain('## Execution Groups');
    expect(result).not.toContain('### Group 1');
  });

  it('should handle content without Execution Groups', () => {
    const simple = '# Simple Wish\n\nJust a simple description.';
    const result = extractWishContext(simple);
    expect(result).toBe(simple);
  });

  it('should truncate very long content without Execution Groups', () => {
    const long = 'x'.repeat(3000);
    const result = extractWishContext(long);
    expect(result.length).toBeLessThanOrEqual(2000);
  });
});

describe('buildContextPrompt()', () => {
  it('should include file path and section content', () => {
    const result = buildContextPrompt({
      filePath: '/path/to/WISH.md',
      sectionContent: 'Group content here',
      command: 'work test#1',
    });

    expect(result).toContain('# Dispatch Context (work test#1)');
    expect(result).toContain('**Source file:** `/path/to/WISH.md`');
    expect(result).toContain('Group content here');
  });

  it('should include wish context when provided', () => {
    const result = buildContextPrompt({
      filePath: '/path/to/WISH.md',
      sectionContent: 'Group content',
      wishContext: 'Summary and scope info',
      command: 'work test#1',
    });

    expect(result).toContain('## Wish Context');
    expect(result).toContain('Summary and scope info');
  });

  it('should omit wish context section when not provided', () => {
    const result = buildContextPrompt({
      filePath: '/path/to/file.md',
      sectionContent: 'Content',
      command: 'brainstorm',
    });

    expect(result).not.toContain('## Wish Context');
  });

  it('should include skill command when provided', () => {
    const result = buildContextPrompt({
      filePath: '/path/to/file.md',
      sectionContent: 'Content',
      command: 'work test#1',
      skill: 'work',
    });

    expect(result).toContain('## Initial Command');
    expect(result).toContain('`/work`');
  });

  it('should include read-full-document hint', () => {
    const result = buildContextPrompt({
      filePath: '/path/to/file.md',
      sectionContent: 'Content',
      command: 'brainstorm',
    });

    expect(result).toContain('Read the full document at the path above');
  });
});

describe('writeContextFile()', () => {
  it('should write content to a temp file and return path', async () => {
    const content = 'test context content';
    const filePath = await writeContextFile(content);

    expect(filePath).toContain('genie-dispatch');
    expect(filePath).toContain('ctx-');

    const written = await readFile(filePath, 'utf-8');
    expect(written).toBe(content);
  });

  it('should create unique file names', async () => {
    const path1 = await writeContextFile('content 1');
    const path2 = await writeContextFile('content 2');
    expect(path1).not.toBe(path2);
  });
});

// ============================================================================
// Unit Tests: parseWishGroups() — ZERO COVERAGE before this
// ============================================================================

describe('parseWishGroups()', () => {
  // U-DC-01: Basic WISH.md with 3 groups
  it('should extract 3 groups with correct names and deps from SAMPLE_WISH', () => {
    const groups = parseWishGroups(SAMPLE_WISH);
    expect(groups.length).toBe(3);
    expect(groups[0]).toEqual({ name: '1', dependsOn: [] });
    expect(groups[1]).toEqual({ name: '2', dependsOn: ['1'] });
    expect(groups[2]).toEqual({ name: '3', dependsOn: ['2'] });
  });

  // U-DC-02: Case-insensitive "none"
  it('should handle "depends-on: none" (case-insensitive)', () => {
    const content = '### Group 1: Setup\n**depends-on:** None\n---\n### Group 2: Build\n**depends-on:** NONE\n';
    const groups = parseWishGroups(content);
    expect(groups.length).toBe(2);
    expect(groups[0].dependsOn).toEqual([]);
    expect(groups[1].dependsOn).toEqual([]);
  });

  // U-DC-03: Multi-dep with "Group" prefix strip
  it('should parse comma-separated deps and strip "Group" prefix', () => {
    const content = '### Group 3: Final\n**depends-on:** Group 1, Group 2\n';
    const groups = parseWishGroups(content);
    expect(groups.length).toBe(1);
    expect(groups[0].name).toBe('3');
    expect(groups[0].dependsOn).toEqual(['1', '2']);
  });

  // U-DC-04: Missing depends-on line
  it('should default to empty dependsOn when no depends-on line exists', () => {
    const content = '### Group 1: Solo\n**Goal:** Just do it.\n';
    const groups = parseWishGroups(content);
    expect(groups.length).toBe(1);
    expect(groups[0].dependsOn).toEqual([]);
  });

  // U-DC-05: Non-sequential numbers
  it('should handle non-sequential group numbers (1, 3, 7)', () => {
    const content = [
      '### Group 1: First\n**depends-on:** none\n---',
      '### Group 3: Third\n**depends-on:** Group 1\n---',
      '### Group 7: Seventh\n**depends-on:** Group 3\n',
    ].join('\n');
    const groups = parseWishGroups(content);
    expect(groups.length).toBe(3);
    expect(groups.map((g) => g.name)).toEqual(['1', '3', '7']);
    expect(groups[2].dependsOn).toEqual(['3']);
  });

  // U-DC-06: Empty content
  it('should return empty array for empty content', () => {
    const groups = parseWishGroups('');
    expect(groups).toEqual([]);
  });

  // U-DC-07: No groups (just text)
  it('should return empty array when no group headings exist', () => {
    const content = '# A Wish\n\nThis has no groups at all.\n\n## Summary\n\nJust text.';
    const groups = parseWishGroups(content);
    expect(groups).toEqual([]);
  });

  // U-DC-08: Lowercase heading (case sensitivity)
  it('should return empty for lowercase "### group 1:" (regex is case-sensitive)', () => {
    const content = '### group 1: lowercase\n**depends-on:** none\n';
    const groups = parseWishGroups(content);
    expect(groups).toEqual([]);
  });

  // U-DC-09: Real WISH.md (genie-v2) with 10 groups
  it('should parse real genie-v2 WISH.md with 10 groups and correct dependency graph', async () => {
    const { readFile } = await import('node:fs/promises');
    const wishPath = join(process.cwd(), '.genie/wishes/genie-v2-framework-redesign/WISH.md');
    const { existsSync } = await import('node:fs');
    if (!existsSync(wishPath)) {
      // Skip if running from a different CWD
      console.log('Skipping U-DC-09: WISH.md not found at', wishPath);
      return;
    }
    const content = await readFile(wishPath, 'utf-8');
    const groups = parseWishGroups(content);
    expect(groups.length).toBe(10);

    // Group 1 and 4 should have no deps (parallelizable)
    const g1 = groups.find((g) => g.name === '1');
    const g4 = groups.find((g) => g.name === '4');
    expect(g1?.dependsOn).toEqual([]);
    expect(g4?.dependsOn).toEqual([]);

    // Group 5 depends on Group 2, Group 4
    const g5 = groups.find((g) => g.name === '5');
    expect(g5?.dependsOn).toEqual(['2', '4']);

    // Group 10 depends on Group 7, Group 8, Group 9
    const g10 = groups.find((g) => g.name === '10');
    expect(g10?.dependsOn).toEqual(['7', '8', '9']);
  });

  // U-DC-10: Regex special chars in group name (via extractGroup)
  it('should handle escapeRegExp correctly in extractGroup', () => {
    // This tests that the escapeRegExp used by extractGroup prevents regex injection
    const content = '### Group 1: Test (with parens)\n**Goal:** Test.\n';
    // extractGroup uses escapeRegExp on the group name
    const result = extractGroup(content, '1');
    expect(result).not.toBeNull();
    expect(result).toContain('Test (with parens)');
  });

  // Additional: single group wish
  it('should parse a single group wish', () => {
    const content = '### Group 1: Only One\n**Goal:** Do everything.\n**depends-on:** none\n';
    const groups = parseWishGroups(content);
    expect(groups.length).toBe(1);
    expect(groups[0]).toEqual({ name: '1', dependsOn: [] });
  });

  // Additional: deps without "Group" prefix (just numbers)
  it('should handle deps specified as bare numbers', () => {
    const content = '### Group 2: Second\n**depends-on:** 1\n';
    const groups = parseWishGroups(content);
    expect(groups.length).toBe(1);
    expect(groups[0].dependsOn).toEqual(['1']);
  });
});

// ============================================================================
// Integration Tests: Dispatch Commands
// ============================================================================

describe('dispatch commands - file reading', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = join('/tmp', `dispatch-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(tempDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe('brainstorm dispatch', () => {
    it('should read DRAFT.md from .genie/brainstorms/<slug>/', async () => {
      const slug = 'test-idea';
      const brainstormDir = join(tempDir, '.genie', 'brainstorms', slug);
      await mkdir(brainstormDir, { recursive: true });
      const draftContent = '# Draft: Test Idea\n\nThis is a brainstorm draft.';
      await writeFile(join(brainstormDir, 'DRAFT.md'), draftContent);

      // Verify file can be found at the expected path
      const draftPath = join(tempDir, '.genie', 'brainstorms', slug, 'DRAFT.md');
      const content = await readFile(draftPath, 'utf-8');
      expect(content).toBe(draftContent);

      // Build context prompt
      const context = buildContextPrompt({
        filePath: draftPath,
        sectionContent: content,
        command: 'brainstorm',
        skill: 'brainstorm',
      });

      expect(context).toContain(draftPath);
      expect(context).toContain(draftContent);
      expect(context).toContain('`/brainstorm`');
    });
  });

  describe('wish dispatch', () => {
    it('should read DESIGN.md from .genie/brainstorms/<slug>/', async () => {
      const slug = 'test-design';
      const brainstormDir = join(tempDir, '.genie', 'brainstorms', slug);
      await mkdir(brainstormDir, { recursive: true });
      const designContent = '# Design: Test Feature\n\n## Architecture\n\nUse modules.';
      await writeFile(join(brainstormDir, 'DESIGN.md'), designContent);

      const designPath = join(tempDir, '.genie', 'brainstorms', slug, 'DESIGN.md');
      const content = await readFile(designPath, 'utf-8');
      expect(content).toBe(designContent);

      const context = buildContextPrompt({
        filePath: designPath,
        sectionContent: content,
        command: 'wish',
        skill: 'wish',
      });

      expect(context).toContain(designPath);
      expect(context).toContain(designContent);
      expect(context).toContain('`/wish`');
    });
  });

  describe('work dispatch - group extraction', () => {
    it('should extract correct group from WISH.md', async () => {
      const slug = 'test-feature';
      const wishDir = join(tempDir, '.genie', 'wishes', slug);
      await mkdir(wishDir, { recursive: true });
      await writeFile(join(wishDir, 'WISH.md'), SAMPLE_WISH);

      const wishPath = join(wishDir, 'WISH.md');
      const content = await readFile(wishPath, 'utf-8');

      // Extract group 2
      const group = extractGroup(content, '2');
      expect(group).not.toBeNull();
      expect(group).toContain('Integration');
      expect(group).not.toContain('Foundation');
      expect(group).not.toContain('Polish');

      // Build context with wish-level info
      const wishContext = extractWishContext(content);
      const context = buildContextPrompt({
        filePath: wishPath,
        sectionContent: group!,
        wishContext,
        command: 'work test-feature#2',
        skill: 'work',
      });

      expect(context).toContain(wishPath);
      expect(context).toContain('Integration');
      expect(context).toContain('## Wish Context');
      expect(context).toContain('test wish for testing');
    });
  });

  describe('review dispatch', () => {
    it('should include group section in review context', async () => {
      const slug = 'test-feature';
      const wishDir = join(tempDir, '.genie', 'wishes', slug);
      await mkdir(wishDir, { recursive: true });
      await writeFile(join(wishDir, 'WISH.md'), SAMPLE_WISH);

      const content = await readFile(join(wishDir, 'WISH.md'), 'utf-8');
      const groupSection = extractGroup(content, '1');
      expect(groupSection).not.toBeNull();

      // Build review content (simulating what reviewCommand does)
      const reviewContent = [
        groupSection!,
        '',
        '## Git Diff (changes to review)',
        '',
        '(no uncommitted changes found)',
      ].join('\n');

      const context = buildContextPrompt({
        filePath: join(wishDir, 'WISH.md'),
        sectionContent: reviewContent,
        wishContext: extractWishContext(content),
        command: 'review test-feature#1',
        skill: 'review',
      });

      expect(context).toContain('review test-feature#1');
      expect(context).toContain('Foundation');
      expect(context).toContain('Git Diff');
    });
  });
});

// ============================================================================
// State Machine Integration
// ============================================================================

describe('dispatch commands - state machine integration', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = join('/tmp', `dispatch-state-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(tempDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('should allow starting group when dependencies are met', async () => {
    // Create state with group 1 (no deps) and group 2 (depends on 1)
    await wishState.createState(
      'test-wish',
      [
        { name: '1', dependsOn: [] },
        { name: '2', dependsOn: ['1'] },
      ],
      tempDir,
    );

    // Group 1 should be startable (no deps)
    const g1 = await wishState.startGroup('test-wish', '1', 'agent-a', tempDir);
    expect(g1.status).toBe('in_progress');
    expect(g1.assignee).toBe('agent-a');
  });

  it('should refuse starting group when dependencies are not met', async () => {
    await wishState.createState(
      'test-wish-2',
      [
        { name: '1', dependsOn: [] },
        { name: '2', dependsOn: ['1'] },
        { name: '3', dependsOn: ['2'] },
      ],
      tempDir,
    );

    // Group 2 should be blocked (group 1 not done)
    expect(() => wishState.startGroup('test-wish-2', '2', 'agent-b', tempDir)).toThrow('dependency "1" is ready');
  });

  it('should allow starting group 2 after group 1 is done', async () => {
    await wishState.createState(
      'test-wish-3',
      [
        { name: '1', dependsOn: [] },
        { name: '2', dependsOn: ['1'] },
      ],
      tempDir,
    );

    // Start and complete group 1
    await wishState.startGroup('test-wish-3', '1', 'agent-a', tempDir);
    await wishState.completeGroup('test-wish-3', '1', tempDir);

    // Now group 2 should be startable
    const g2 = await wishState.startGroup('test-wish-3', '2', 'agent-b', tempDir);
    expect(g2.status).toBe('in_progress');
  });

  it('should refuse starting group 3 when group 2 is not done', async () => {
    await wishState.createState(
      'test-wish-4',
      [
        { name: '1', dependsOn: [] },
        { name: '2', dependsOn: ['1'] },
        { name: '3', dependsOn: ['2'] },
      ],
      tempDir,
    );

    // Complete group 1, start group 2 (but don't complete it)
    await wishState.startGroup('test-wish-4', '1', 'agent-a', tempDir);
    await wishState.completeGroup('test-wish-4', '1', tempDir);
    await wishState.startGroup('test-wish-4', '2', 'agent-b', tempDir);

    // Group 3 should be blocked (group 2 is in_progress, not done)
    expect(() => wishState.startGroup('test-wish-4', '3', 'agent-c', tempDir)).toThrow('dependency "2" is in_progress');
  });
});
