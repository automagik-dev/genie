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

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DB_AVAILABLE, setupTestDatabase } from '../lib/test-db.js';
import * as wishState from '../lib/wish-state.js';
import {
  buildContextPrompt,
  detectWorkMode,
  extractGroup,
  extractWishContext,
  parseExecutionStrategy,
  parseWishGroups,
  writeContextFile,
} from './dispatch.js';
import { parseRef } from './state.js';

let cleanupSchema: () => Promise<void>;

beforeAll(async () => {
  if (!DB_AVAILABLE) return;
  cleanupSchema = await setupTestDatabase();
});

afterAll(async () => {
  if (cleanupSchema) await cleanupSchema();
});

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

describe.skipIf(!DB_AVAILABLE)('dispatch commands - state machine integration', () => {
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

// ============================================================================
// parseWishGroups — case-insensitive parsing
// ============================================================================

describe('parseWishGroups()', () => {
  it('should parse standard Group headings', () => {
    const groups = parseWishGroups(SAMPLE_WISH);
    expect(groups.length).toBe(3);
    expect(groups[0].name).toBe('1');
    expect(groups[1].name).toBe('2');
    expect(groups[2].name).toBe('3');
  });

  it('should parse lowercase group headings (case-insensitive)', () => {
    const content = '### group 1: Test\n**depends-on:** none\n\n### group 2: Next\n**depends-on:** Group 1';
    const groups = parseWishGroups(content);
    expect(groups.length).toBe(2);
    expect(groups[0].name).toBe('1');
    expect(groups[0].dependsOn).toEqual([]);
    expect(groups[1].name).toBe('2');
    expect(groups[1].dependsOn).toEqual(['1']);
  });

  it('should parse mixed case group headings', () => {
    const content = '### GROUP 1: Loud\n**depends-on:** none\n\n### Group 2: Normal\n**depends-on:** Group 1';
    const groups = parseWishGroups(content);
    expect(groups.length).toBe(2);
  });

  it('should parse depends-on with Group prefix', () => {
    const groups = parseWishGroups(SAMPLE_WISH);
    expect(groups[1].dependsOn).toEqual(['1']);
    expect(groups[2].dependsOn).toEqual(['2']);
  });

  it('should handle depends-on: none', () => {
    const groups = parseWishGroups(SAMPLE_WISH);
    expect(groups[0].dependsOn).toEqual([]);
  });

  it('should strip parenthetical comments from depends-on values', () => {
    const content =
      '### Group 1: First\n**depends-on:** none (this is the start)\n\n### Group 2: Second\n**depends-on:** 1 (must be done first)\n\n### Group 3: Third\n**depends-on:** Group 1 (setup), Group 2 (core work)';
    const groups = parseWishGroups(content);
    expect(groups[0].dependsOn).toEqual([]);
    expect(groups[1].dependsOn).toEqual(['1']);
    expect(groups[2].dependsOn).toEqual(['1', '2']);
  });

  it('should handle parenthetical descriptions containing commas (#752)', () => {
    const content =
      '### Group 1: Components\n**depends-on:** none\n\n### Group 2: Integration\n**depends-on:** Group 1 (GlassCard, StatusDot, ProgressBar)';
    const groups = parseWishGroups(content);
    expect(groups[0].dependsOn).toEqual([]);
    expect(groups[1].dependsOn).toEqual(['1']);
  });

  it('should handle multiple groups with parenthetical descriptions containing commas (#752)', () => {
    const content =
      '### Group 1: A\n**depends-on:** none\n\n### Group 2: B\n**depends-on:** none\n\n### Group 3: C\n**depends-on:** Group 1, Group 2 (after review)';
    const groups = parseWishGroups(content);
    expect(groups[2].dependsOn).toEqual(['1', '2']);
  });

  it('should parse depends-on: none as empty array', () => {
    const content = '### Group 1: Solo\n**depends-on:** none';
    const groups = parseWishGroups(content);
    expect(groups[0].dependsOn).toEqual([]);
  });
});

// ============================================================================
// parseExecutionStrategy — wave parsing
// ============================================================================

const WISH_WITH_STRATEGY = `# Wish: Auto-Orchestrate

## Summary

Auto-orchestrate wish execution.

## Execution Groups

### Group 1: Parse Strategy

**depends-on:** none

---

### Group 2: Orchestrator

**depends-on:** Group 1

---

### Group 3: Engineer done

**depends-on:** none

---

### Group 4: Team-lead prompt

**depends-on:** Group 2

---

### Group 5: Validate

**depends-on:** Group 1, Group 2, Group 3, Group 4

---

## Execution Strategy

### Wave 1 (parallel)
| Group | Agent | Description |
|-------|-------|-------------|
| 1 | engineer | Parse Execution Strategy |
| 3 | engineer | Engineer reports completion |

### Wave 2 (after Wave 1)
| Group | Agent | Description |
|-------|-------|-------------|
| 2 | engineer | Auto-orchestration loop |

### Wave 3 (after Wave 2)
| Group | Agent | Description |
|-------|-------|-------------|
| 4 | engineer | Team-lead prompt update |

### Wave 4 (after Wave 3)
| Group | Agent | Description |
|-------|-------|-------------|
| 5 | reviewer | Full validation |

---

## Assumptions / Risks
`;

describe('parseExecutionStrategy()', () => {
  it('should parse waves from Execution Strategy section', () => {
    const waves = parseExecutionStrategy(WISH_WITH_STRATEGY);
    expect(waves.length).toBe(4);
  });

  it('should parse wave names', () => {
    const waves = parseExecutionStrategy(WISH_WITH_STRATEGY);
    expect(waves[0].name).toBe('Wave 1 (parallel)');
    expect(waves[1].name).toBe('Wave 2 (after Wave 1)');
    expect(waves[2].name).toBe('Wave 3 (after Wave 2)');
    expect(waves[3].name).toBe('Wave 4 (after Wave 3)');
  });

  it('should parse groups in Wave 1', () => {
    const waves = parseExecutionStrategy(WISH_WITH_STRATEGY);
    expect(waves[0].groups.length).toBe(2);
    expect(waves[0].groups[0]).toEqual({ group: '1', agent: 'engineer' });
    expect(waves[0].groups[1]).toEqual({ group: '3', agent: 'engineer' });
  });

  it('should parse single-group waves', () => {
    const waves = parseExecutionStrategy(WISH_WITH_STRATEGY);
    expect(waves[1].groups.length).toBe(1);
    expect(waves[1].groups[0]).toEqual({ group: '2', agent: 'engineer' });
  });

  it('should parse reviewer agent', () => {
    const waves = parseExecutionStrategy(WISH_WITH_STRATEGY);
    expect(waves[3].groups[0]).toEqual({ group: '5', agent: 'reviewer' });
  });

  it('should fall back to single wave when no Execution Strategy section', () => {
    const waves = parseExecutionStrategy(SAMPLE_WISH);
    expect(waves.length).toBe(1);
    expect(waves[0].name).toContain('fallback');
    expect(waves[0].groups.length).toBe(3);
    expect(waves[0].groups[0]).toEqual({ group: '1', agent: 'engineer' });
    expect(waves[0].groups[1]).toEqual({ group: '2', agent: 'engineer' });
    expect(waves[0].groups[2]).toEqual({ group: '3', agent: 'engineer' });
  });

  it('should return empty array for content with no groups', () => {
    const waves = parseExecutionStrategy('# Just a title\n\nNo groups here.');
    expect(waves).toEqual([]);
  });

  it('should fall back when Execution Strategy section has no wave headings', () => {
    const content = `## Execution Groups

### Group 1: Only group

**depends-on:** none

## Execution Strategy

No waves defined here, just text.
`;
    const waves = parseExecutionStrategy(content);
    expect(waves.length).toBe(1);
    expect(waves[0].name).toContain('fallback');
    expect(waves[0].groups[0]).toEqual({ group: '1', agent: 'engineer' });
  });
});

// ============================================================================
// detectWorkMode — auto vs manual mode detection
// ============================================================================

describe('detectWorkMode()', () => {
  it('should detect auto mode from single slug (no #)', () => {
    const result = detectWorkMode('my-wish');
    expect(result).toEqual({ mode: 'auto', slug: 'my-wish' });
  });

  it('should detect manual mode — new style: ref#group then agent', () => {
    const result = detectWorkMode('my-wish#2', 'engineer');
    expect(result).toEqual({ mode: 'manual', ref: 'my-wish#2', agent: 'engineer' });
  });

  it('should detect manual mode — old style: agent then ref#group (backwards compatible)', () => {
    const result = detectWorkMode('engineer', 'my-wish#2');
    expect(result).toEqual({ mode: 'manual', ref: 'my-wish#2', agent: 'engineer' });
  });

  it('should throw when single arg contains # (no agent for manual dispatch)', () => {
    expect(() => detectWorkMode('my-wish#2')).toThrow('requires an agent');
  });

  it('should throw when neither arg contains #', () => {
    expect(() => detectWorkMode('something', 'other')).toThrow('must contain "#"');
  });

  it('should handle complex slug with # in new style', () => {
    const result = detectWorkMode('auto-orchestrate#5', 'reviewer');
    expect(result).toEqual({ mode: 'manual', ref: 'auto-orchestrate#5', agent: 'reviewer' });
  });

  it('should handle complex slug with # in old style', () => {
    const result = detectWorkMode('reviewer', 'auto-orchestrate#5');
    expect(result).toEqual({ mode: 'manual', ref: 'auto-orchestrate#5', agent: 'reviewer' });
  });
});

// ============================================================================
// autoOrchestrateCommand parallel dispatch resilience (issue #1207)
// ============================================================================

describe('autoOrchestrateCommand parallel dispatch (issue #1207)', () => {
  it('uses Promise.allSettled — not Promise.all — for wave dispatch', async () => {
    // Regression guard: Promise.all aborts the whole batch on the first failed
    // post-dispatch SQL write (CONNECTION_ENDED from the singleton client race).
    // Promise.allSettled lets sibling dispatches complete reporting even when
    // one fails after its state mutation already landed.
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(join(__dirname, 'dispatch.ts'), 'utf-8');

    const fnStart = source.indexOf('async function autoOrchestrateCommand');
    expect(fnStart).toBeGreaterThan(-1);
    // Find the end of the function — next function definition or end of file
    const nextFnIdx = source.indexOf('\nasync function ', fnStart + 1);
    const fnEnd = nextFnIdx !== -1 ? nextFnIdx : source.length;
    const body = source.slice(fnStart, fnEnd);

    // Must use allSettled
    expect(body).toContain('Promise.allSettled');
    // Must NOT use bare Promise.all on the wave-dispatch loop
    expect(body).not.toMatch(/await\s+Promise\.all\s*\(\s*nextWave/);
  });

  it('reports per-group failures and sets non-zero exit code', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(join(__dirname, 'dispatch.ts'), 'utf-8');
    const fnStart = source.indexOf('async function autoOrchestrateCommand');
    const nextFnIdx = source.indexOf('\nasync function ', fnStart + 1);
    const body = source.slice(fnStart, nextFnIdx !== -1 ? nextFnIdx : source.length);

    // Must surface per-group failures with the group name
    expect(body).toMatch(/failed/i);
    expect(body).toContain('process.exitCode');
    // Must still print success summary for groups that did dispatch
    expect(body).toContain('Agents dispatched for');
  });

  it('does not abort the success print on partial failure', async () => {
    // If any group succeeds we print the success line for those groups even
    // when others failed. Reads back the same function source and checks
    // there is no `throw` or early-exit between the success-list build and
    // the console.log of the success summary.
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(join(__dirname, 'dispatch.ts'), 'utf-8');
    const fnStart = source.indexOf('async function autoOrchestrateCommand');
    const nextFnIdx = source.indexOf('\nasync function ', fnStart + 1);
    const body = source.slice(fnStart, nextFnIdx !== -1 ? nextFnIdx : source.length);

    const allSettledIdx = body.indexOf('Promise.allSettled');
    const successPrintIdx = body.indexOf('Agents dispatched for');
    expect(allSettledIdx).toBeGreaterThan(-1);
    expect(successPrintIdx).toBeGreaterThan(allSettledIdx);
    const between = body.slice(allSettledIdx, successPrintIdx);
    // No early `throw` or `process.exit(` between allSettled and the success print
    expect(between).not.toContain('throw ');
    expect(between).not.toContain('process.exit(');
  });
});

/**
 * P1 regression guard — team-routing fix for spawn-wrong-window bug.
 *
 * `workDispatchCommand` (group dispatch) and `reviewCommand` are both
 * called from WITHIN a team-lead's tmux pane. If they don't forward the
 * `team` option to `handleWorkerSpawn`, `teamWasExplicit` becomes false
 * in agents.ts, which flips `spawnIntoCurrentWindow=true`, which causes
 * `tmux split-window` to run with no `-t` target — tmux then picks the
 * most-recently-active client (usually the operator's pane), silently
 * misrouting the engineer/reviewer into the wrong window.
 *
 * Authority: ~/.genie/reports/trace-genie-spawn-wrong-window.md
 *
 * Regression guard: source-grep the two dispatchers to confirm they
 * forward `team: process.env.GENIE_TEAM`. If this test breaks, the bug
 * is back.
 */
describe('spawn-wrong-window regression guard (trace-genie-spawn-wrong-window.md)', () => {
  let source: string;

  beforeAll(async () => {
    const { readFileSync } = await import('node:fs');
    source = readFileSync(join(__dirname, 'dispatch.ts'), 'utf-8');
  });

  it('workDispatchCommand forwards team: process.env.GENIE_TEAM to handleWorkerSpawn', () => {
    // workDispatchCommand delegates to runWorkDispatch, which holds the actual
    // handleWorkerSpawn call. Walk the delegation to assert team is forwarded.
    const fnStart = source.indexOf('async function workDispatchCommand');
    expect(fnStart).toBeGreaterThan(-1);
    const wdcEnd = source.indexOf('\nasync function ', fnStart + 1);
    const wdcBody = source.slice(fnStart, wdcEnd !== -1 ? wdcEnd : source.length);
    // Regression guard: workDispatchCommand must delegate to runWorkDispatch.
    expect(wdcBody).toContain('runWorkDispatch(');
    const rwdStart = source.indexOf('async function runWorkDispatch');
    expect(rwdStart).toBeGreaterThan(-1);
    const rwdEnd = source.indexOf('\nasync function ', rwdStart + 1);
    const rwdBody = source.slice(rwdStart, rwdEnd !== -1 ? rwdEnd : source.length);
    const callIdx = rwdBody.indexOf('await handleWorkerSpawn(agentName, {');
    expect(callIdx).toBeGreaterThan(-1);
    const nextCloseIdx = rwdBody.indexOf('});', callIdx);
    const callBlock = rwdBody.slice(callIdx, nextCloseIdx);
    expect(callBlock).toContain('team: process.env.GENIE_TEAM');
  });

  it('reviewCommand forwards team: process.env.GENIE_TEAM to handleWorkerSpawn', () => {
    const fnStart = source.indexOf('async function reviewCommand');
    expect(fnStart).toBeGreaterThan(-1);
    const nextFnIdx = source.indexOf('\nasync function ', fnStart + 1);
    const body = source.slice(fnStart, nextFnIdx !== -1 ? nextFnIdx : source.length);
    const callIdx = body.indexOf('await handleWorkerSpawn(agentName, {');
    expect(callIdx).toBeGreaterThan(-1);
    const nextCloseIdx = body.indexOf('});', callIdx);
    const callBlock = body.slice(callIdx, nextCloseIdx);
    expect(callBlock).toContain('team: process.env.GENIE_TEAM');
  });

  it('brainstormCommand does NOT forward team (operator-initiated dispatches should spawn in current window)', () => {
    const fnStart = source.indexOf('async function brainstormCommand');
    expect(fnStart).toBeGreaterThan(-1);
    const nextFnIdx = source.indexOf('\nasync function ', fnStart + 1);
    const body = source.slice(fnStart, nextFnIdx !== -1 ? nextFnIdx : source.length);
    const callIdx = body.indexOf('await handleWorkerSpawn(agentName, {');
    expect(callIdx).toBeGreaterThan(-1);
    const nextCloseIdx = body.indexOf('});', callIdx);
    const callBlock = body.slice(callIdx, nextCloseIdx);
    // brainstorm/wish are operator-initiated (no team context in env);
    // they should NOT forward team — spawning in operator's current
    // window is correct behavior.
    expect(callBlock).not.toContain('team: process.env.GENIE_TEAM');
  });
});

/**
 * Companion regression guard — agents.ts's spawnIntoCurrentWindow must
 * be defensive against callers that have GENIE_TEAM set but didn't pass
 * --team. Without this, a team-lead's own env leaks to tmux's
 * "most-recently-active client" fallback and misroutes the pane.
 */
describe('agents.ts spawnIntoCurrentWindow regression guard', () => {
  it('spawnIntoCurrentWindow assignment respects process.env.GENIE_TEAM', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(join(__dirname, 'agents.ts'), 'utf-8');
    // Anchor on the RUNTIME assignment (`!teamWasExplicit` is unique to it),
    // not the interface declaration `spawnIntoCurrentWindow: boolean;`.
    const anchor = source.indexOf('spawnIntoCurrentWindow: !teamWasExplicit');
    expect(anchor).toBeGreaterThan(-1);
    // Assignment line must mention GENIE_TEAM as a guard against operator
    // env leak via team-lead's spawn shell.
    const lineEnd = source.indexOf('\n', anchor);
    const line = source.slice(anchor, lineEnd);
    expect(line).toContain('GENIE_TEAM');
  });
});

/**
 * Companion regression guard — createTmuxPane must refuse to split
 * without a target. Prevents the root-cause failure mode (tmux picks
 * most-recently-active client) even if some future callsite forgets to
 * forward team and GENIE_TEAM is also unset.
 */
describe('agents.ts createTmuxPane refuse-no-target regression guard', () => {
  it('createTmuxPane throws when both teamWindow and TMUX_PANE are absent', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(join(__dirname, 'agents.ts'), 'utf-8');
    // Grep for the refusal block inside the createTmuxPane body.
    expect(source).toContain('refusing to split with no target');
    expect(source).toContain('trace-genie-spawn-wrong-window');
  });
});
