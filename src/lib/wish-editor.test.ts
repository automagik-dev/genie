import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  parseSections,
  readWish,
  findSection,
  listSections,
  wishExists,
  listWishSlugs,
  getWishPath,
  validateSlug,
} from './wish-editor.js';

// ============================================================================
// Test fixtures
// ============================================================================

const SAMPLE_WISH = `# Forge Resilience

**Status:** IN_PROGRESS
**Priority:** P0
**Created:** 2026-02-10

## Overview

This wish addresses three bugs found during Sofia's field report.

## Success Criteria

- [ ] term work handles missing tasks.json
- [x] beads LEGACY DATABASE fallback
- [ ] actionable error messages

## Execution Groups

### Group 1: Core Fixes

Fix the bugs.

### Group 2: Tests

Write comprehensive tests.

## Review Results

Pending review.
`;

const WISH_WITH_CODE = `# My Wish

## Description

Here's some code:

\`\`\`bash
# This is a comment, not a heading
## Also not a heading
echo "hello"
\`\`\`

## Real Section

This is real.
`;

// ============================================================================
// parseSections
// ============================================================================

describe('parseSections', () => {
  test('parses top-level and nested headings', () => {
    const sections = parseSections(SAMPLE_WISH);
    const headings = sections.map(s => s.heading);

    expect(headings).toContain('Forge Resilience');
    expect(headings).toContain('Overview');
    expect(headings).toContain('Success Criteria');
    expect(headings).toContain('Execution Groups');
    expect(headings).toContain('Group 1: Core Fixes');
    expect(headings).toContain('Group 2: Tests');
    expect(headings).toContain('Review Results');
  });

  test('assigns correct levels', () => {
    const sections = parseSections(SAMPLE_WISH);

    const h1 = sections.find(s => s.heading === 'Forge Resilience');
    expect(h1?.level).toBe(1);

    const h2 = sections.find(s => s.heading === 'Overview');
    expect(h2?.level).toBe(2);

    const h3 = sections.find(s => s.heading === 'Group 1: Core Fixes');
    expect(h3?.level).toBe(3);
  });

  test('section content includes heading line', () => {
    const sections = parseSections(SAMPLE_WISH);
    const overview = sections.find(s => s.heading === 'Overview');

    expect(overview?.content).toContain('## Overview');
    expect(overview?.content).toContain("Sofia's field report");
  });

  test('handles empty content', () => {
    const sections = parseSections('');
    expect(sections).toEqual([]);
  });

  test('handles content with no headings', () => {
    const sections = parseSections('Just some text\nwith no headings.\n');
    expect(sections).toEqual([]);
  });

  test('parent sections include nested subsections', () => {
    const sections = parseSections(SAMPLE_WISH);

    // "Execution Groups" (##) should include "Group 1" (###) and "Group 2" (###)
    const execGroups = sections.find(s => s.heading === 'Execution Groups');
    expect(execGroups).not.toBeNull();
    expect(execGroups!.content).toContain('### Group 1: Core Fixes');
    expect(execGroups!.content).toContain('Fix the bugs.');
    expect(execGroups!.content).toContain('### Group 2: Tests');
    expect(execGroups!.content).toContain('Write comprehensive tests.');
  });

  test('child sections have their own entries too', () => {
    const sections = parseSections(SAMPLE_WISH);

    const group1 = sections.find(s => s.heading === 'Group 1: Core Fixes');
    expect(group1).not.toBeNull();
    expect(group1!.content).toContain('Fix the bugs.');
    // Group 1 should NOT include Group 2 content (same level)
    expect(group1!.content).not.toContain('Write comprehensive tests.');
  });

  test('h1 section includes all nested content until EOF', () => {
    const sections = parseSections(SAMPLE_WISH);
    const h1 = sections.find(s => s.heading === 'Forge Resilience');
    expect(h1).not.toBeNull();
    // h1 has no sibling, so it runs to EOF — includes everything
    expect(h1!.content).toContain('## Overview');
    expect(h1!.content).toContain('## Review Results');
  });

  test('ignores headings inside code blocks', () => {
    const sections = parseSections(WISH_WITH_CODE);
    const headings = sections.map(s => s.heading);

    expect(headings).toContain('My Wish');
    expect(headings).toContain('Description');
    expect(headings).toContain('Real Section');
    // Should NOT contain the code block comments
    expect(headings).not.toContain('This is a comment, not a heading');
    expect(headings).not.toContain('Also not a heading');
  });
});

// ============================================================================
// readWish + findSection + listSections (filesystem tests)
// ============================================================================

describe('wish-editor filesystem operations', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'wish-editor-test-'));
    const wishDir = join(tmpDir, '.genie', 'wishes', 'test-wish');
    await mkdir(wishDir, { recursive: true });
    await writeFile(join(wishDir, 'wish.md'), SAMPLE_WISH);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test('readWish returns parsed document', async () => {
    const doc = await readWish(tmpDir, 'test-wish');

    expect(doc).not.toBeNull();
    expect(doc!.slug).toBe('test-wish');
    expect(doc!.raw).toBe(SAMPLE_WISH);
    expect(doc!.sections.length).toBeGreaterThan(0);
    expect(doc!.mtime).toBeGreaterThan(0);
  });

  test('readWish returns null for nonexistent wish', async () => {
    const doc = await readWish(tmpDir, 'nonexistent');
    expect(doc).toBeNull();
  });

  test('findSection exact match', async () => {
    const doc = await readWish(tmpDir, 'test-wish');
    const section = findSection(doc!, 'Success Criteria');

    expect(section).not.toBeNull();
    expect(section!.heading).toBe('Success Criteria');
    expect(section!.content).toContain('tasks.json');
  });

  test('findSection case-insensitive', async () => {
    const doc = await readWish(tmpDir, 'test-wish');
    const section = findSection(doc!, 'success criteria');

    expect(section).not.toBeNull();
    expect(section!.heading).toBe('Success Criteria');
  });

  test('findSection partial match', async () => {
    const doc = await readWish(tmpDir, 'test-wish');
    const section = findSection(doc!, 'criteria');

    expect(section).not.toBeNull();
    expect(section!.heading).toBe('Success Criteria');
  });

  test('findSection returns null for no match', async () => {
    const doc = await readWish(tmpDir, 'test-wish');
    const section = findSection(doc!, 'nonexistent section');
    expect(section).toBeNull();
  });

  test('listSections returns heading info', async () => {
    const doc = await readWish(tmpDir, 'test-wish');
    const sections = listSections(doc!);

    expect(sections.length).toBeGreaterThan(0);
    expect(sections[0]).toHaveProperty('heading');
    expect(sections[0]).toHaveProperty('level');
    expect(sections[0]).toHaveProperty('lineCount');
  });

  test('wishExists returns true for existing wish', async () => {
    expect(await wishExists(tmpDir, 'test-wish')).toBe(true);
  });

  test('wishExists returns false for nonexistent wish', async () => {
    expect(await wishExists(tmpDir, 'nope')).toBe(false);
  });

  test('listWishSlugs finds wish directories', async () => {
    // Add a second wish
    const wish2Dir = join(tmpDir, '.genie', 'wishes', 'another-wish');
    await mkdir(wish2Dir, { recursive: true });
    await writeFile(join(wish2Dir, 'wish.md'), '# Another\n');

    const slugs = await listWishSlugs(tmpDir);
    expect(slugs).toContain('test-wish');
    expect(slugs).toContain('another-wish');
    expect(slugs).toEqual(['another-wish', 'test-wish']); // sorted
  });

  test('listWishSlugs ignores dirs without wish.md', async () => {
    const emptyDir = join(tmpDir, '.genie', 'wishes', 'empty-dir');
    await mkdir(emptyDir, { recursive: true });

    const slugs = await listWishSlugs(tmpDir);
    expect(slugs).toContain('test-wish');
    expect(slugs).not.toContain('empty-dir');
  });

  test('getWishPath returns correct path', () => {
    const path = getWishPath('/repo', 'my-wish');
    expect(path).toBe('/repo/.genie/wishes/my-wish/wish.md');
  });

  test('validateSlug accepts safe slugs', () => {
    expect(() => validateSlug('my-wish')).not.toThrow();
    expect(() => validateSlug('wish_2026-02-11')).not.toThrow();
  });

  test('validateSlug rejects path traversal patterns', () => {
    expect(() => validateSlug('../etc/passwd')).toThrow();
    expect(() => validateSlug('..')).toThrow();
    expect(() => validateSlug('a/b')).toThrow();
    expect(() => validateSlug('a\\b')).toThrow();
  });

  test('getWishPath throws on invalid slug', () => {
    expect(() => getWishPath('/repo', '../../etc/passwd')).toThrow();
  });

  test('readWish throws on invalid slug', async () => {
    await expect(readWish(tmpDir, '../../etc/passwd')).rejects.toThrow();
  });
});
