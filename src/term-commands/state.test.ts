/**
 * Tests for state commands — wave detection, push enforcement, pane auto-kill.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { execSync } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as wishState from '../lib/wish-state.js';
import { detectWaveCompletion, ensureWorkPushed, parseRef } from './state.js';

// ============================================================================
// Sample WISH.md with Execution Strategy for wave detection tests
// ============================================================================

const WISH_WITH_WAVES = `# Wish: Test Waves

## Summary

Test wish for wave detection.

## Execution Groups

### Group 1: First task

**depends-on:** none

---

### Group 2: Second task

**depends-on:** none

---

### Group 3: Third task

**depends-on:** Group 1

---

### Group 4: Fourth task

**depends-on:** Group 1

---

### Group 5: Fifth task

**depends-on:** Group 3, Group 4

## Execution Strategy

### Wave 1 (parallel)
| Group | Agent | Description |
|-------|-------|-------------|
| 1 | engineer | First task |
| 2 | engineer | Second task |

### Wave 2 (after Wave 1)
| Group | Agent | Description |
|-------|-------|-------------|
| 3 | engineer | Third task |
| 4 | engineer | Fourth task |

### Wave 3 (after Wave 2)
| Group | Agent | Description |
|-------|-------|-------------|
| 5 | reviewer | Fifth task |
`;

// ============================================================================
// parseRef (basic)
// ============================================================================

describe('parseRef()', () => {
  it('should parse slug#group', () => {
    expect(parseRef('test#3')).toEqual({ slug: 'test', group: '3' });
  });

  it('should throw on missing hash', () => {
    expect(() => parseRef('nohash')).toThrow('Invalid reference');
  });
});

// ============================================================================
// detectWaveCompletion
// ============================================================================

describe('detectWaveCompletion()', () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = join('/tmp', `wave-detect-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(cwd, { recursive: true });

    // Create WISH.md
    const wishDir = join(cwd, '.genie', 'wishes', 'test-waves');
    await mkdir(wishDir, { recursive: true });
    await writeFile(join(wishDir, 'WISH.md'), WISH_WITH_WAVES);

    // Initialize wish state
    await wishState.createState(
      'test-waves',
      [
        { name: '1', dependsOn: [] },
        { name: '2', dependsOn: [] },
        { name: '3', dependsOn: ['1'] },
        { name: '4', dependsOn: ['1'] },
        { name: '5', dependsOn: ['3', '4'] },
      ],
      cwd,
    );
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it('should return null when not all wave groups are done', async () => {
    // Only complete group 1 — group 2 is still in Wave 1
    await wishState.startGroup('test-waves', '1', 'agent-a', cwd);
    await wishState.completeGroup('test-waves', '1', cwd);

    const result = await detectWaveCompletion('test-waves', '1', cwd);
    expect(result).toBeNull();
  });

  it('should detect wave completion when all wave groups are done', async () => {
    // Complete both groups in Wave 1
    await wishState.startGroup('test-waves', '1', 'agent-a', cwd);
    await wishState.completeGroup('test-waves', '1', cwd);
    await wishState.startGroup('test-waves', '2', 'agent-b', cwd);
    await wishState.completeGroup('test-waves', '2', cwd);

    const result = await detectWaveCompletion('test-waves', '2', cwd);
    expect(result).not.toBeNull();
    expect(result!.waveName).toBe('Wave 1 (parallel)');
    expect(result!.waveGroups).toEqual(['1', '2']);
  });

  it('should detect wave completion when called from any group in the wave', async () => {
    // Complete both groups in Wave 1
    await wishState.startGroup('test-waves', '1', 'agent-a', cwd);
    await wishState.completeGroup('test-waves', '1', cwd);
    await wishState.startGroup('test-waves', '2', 'agent-b', cwd);
    await wishState.completeGroup('test-waves', '2', cwd);

    // Call from group 1 — wave should be detected as complete
    const result = await detectWaveCompletion('test-waves', '1', cwd);
    expect(result).not.toBeNull();
    expect(result!.waveGroups).toEqual(['1', '2']);
  });

  it('should not trigger premature wave-complete for different waves', async () => {
    // Complete Wave 1
    await wishState.startGroup('test-waves', '1', 'agent-a', cwd);
    await wishState.completeGroup('test-waves', '1', cwd);
    await wishState.startGroup('test-waves', '2', 'agent-b', cwd);
    await wishState.completeGroup('test-waves', '2', cwd);

    // Start only group 3 in Wave 2 (group 4 not done)
    await wishState.startGroup('test-waves', '3', 'agent-c', cwd);
    await wishState.completeGroup('test-waves', '3', cwd);

    const result = await detectWaveCompletion('test-waves', '3', cwd);
    expect(result).toBeNull();
  });

  it('should detect Wave 2 completion', async () => {
    // Complete Wave 1
    await wishState.startGroup('test-waves', '1', 'agent-a', cwd);
    await wishState.completeGroup('test-waves', '1', cwd);
    await wishState.startGroup('test-waves', '2', 'agent-b', cwd);
    await wishState.completeGroup('test-waves', '2', cwd);

    // Complete Wave 2
    await wishState.startGroup('test-waves', '3', 'agent-c', cwd);
    await wishState.completeGroup('test-waves', '3', cwd);
    await wishState.startGroup('test-waves', '4', 'agent-d', cwd);
    await wishState.completeGroup('test-waves', '4', cwd);

    const result = await detectWaveCompletion('test-waves', '4', cwd);
    expect(result).not.toBeNull();
    expect(result!.waveName).toBe('Wave 2 (after Wave 1)');
    expect(result!.waveGroups).toEqual(['3', '4']);
  });

  it('should return null for nonexistent wish', async () => {
    const result = await detectWaveCompletion('nonexistent', '1', cwd);
    expect(result).toBeNull();
  });

  it('should detect single-group wave completion', async () => {
    // Complete Wave 1 and Wave 2
    await wishState.startGroup('test-waves', '1', 'a', cwd);
    await wishState.completeGroup('test-waves', '1', cwd);
    await wishState.startGroup('test-waves', '2', 'b', cwd);
    await wishState.completeGroup('test-waves', '2', cwd);
    await wishState.startGroup('test-waves', '3', 'c', cwd);
    await wishState.completeGroup('test-waves', '3', cwd);
    await wishState.startGroup('test-waves', '4', 'd', cwd);
    await wishState.completeGroup('test-waves', '4', cwd);

    // Complete Wave 3 (single group)
    await wishState.startGroup('test-waves', '5', 'e', cwd);
    await wishState.completeGroup('test-waves', '5', cwd);

    const result = await detectWaveCompletion('test-waves', '5', cwd);
    expect(result).not.toBeNull();
    expect(result!.waveName).toBe('Wave 3 (after Wave 2)');
    expect(result!.waveGroups).toEqual(['5']);
  });
});

// ============================================================================
// ensureWorkPushed
// ============================================================================

describe('ensureWorkPushed()', () => {
  let repoDir: string;
  let originalCwd: string;

  beforeEach(async () => {
    originalCwd = process.cwd();
    repoDir = join('/tmp', `push-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(repoDir, { recursive: true });

    // Initialize a git repo — ensureWorkPushed uses execSync which operates in process.cwd()
    execSync('git init', { cwd: repoDir, encoding: 'utf-8' });
    execSync('git config user.email "test@test.com"', { cwd: repoDir, encoding: 'utf-8' });
    execSync('git config user.name "Test"', { cwd: repoDir, encoding: 'utf-8' });

    // Create initial commit
    await writeFile(join(repoDir, 'README.md'), '# Test');
    execSync('git add -A && git commit -m "init"', { cwd: repoDir, encoding: 'utf-8' });

    // ensureWorkPushed uses execSync with no cwd, so we must chdir
    process.chdir(repoDir);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await rm(repoDir, { recursive: true, force: true });
  });

  it('should commit dirty working tree as WIP', async () => {
    // Create a dirty file
    await writeFile(join(repoDir, 'dirty.txt'), 'dirty content');

    await ensureWorkPushed('test-slug', '3');

    // Verify the commit was made
    const log = execSync('git log --oneline -1', { cwd: repoDir, encoding: 'utf-8' }).trim();
    expect(log).toContain('wip: test-slug#3');
  });

  it('should not commit when working tree is clean', async () => {
    const logBefore = execSync('git log --oneline -1', { cwd: repoDir, encoding: 'utf-8' }).trim();

    await ensureWorkPushed('test-slug', '3');

    const logAfter = execSync('git log --oneline -1', { cwd: repoDir, encoding: 'utf-8' }).trim();
    expect(logAfter).toBe(logBefore);
  });

  it('should handle repos without remote gracefully', async () => {
    // Create a dirty file and commit it
    await writeFile(join(repoDir, 'file.txt'), 'content');
    execSync('git add -A && git commit -m "test"', { cwd: repoDir, encoding: 'utf-8' });

    // Should not throw — push will fail but be handled gracefully
    await ensureWorkPushed('test-slug', '3');
  });
});
