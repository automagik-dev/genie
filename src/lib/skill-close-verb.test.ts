/**
 * Skill close-verb contract — every built-in skill must end with a
 * "Turn close" instruction block. This is the counterpart to the
 * GENIE_EXECUTOR_ID spawn env var: the skill tells the agent to call
 * `genie done` / `blocked` / `failed`, and the child env gives it an
 * executor to close.
 *
 * See turn-session-contract wish, Group 3.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SKILLS_WITH_CLOSE_VERB = ['brainstorm', 'work', 'fix', 'review', 'refine', 'trace', 'docs'];

// Repo root relative to this test file: src/lib/ → ../../
const REPO_ROOT = join(import.meta.dir, '..', '..');

describe('skill close-verb contract', () => {
  for (const skill of SKILLS_WITH_CLOSE_VERB) {
    test(`skills/${skill}/SKILL.md contains a Turn close block`, () => {
      const path = join(REPO_ROOT, 'skills', skill, 'SKILL.md');
      const body = readFileSync(path, 'utf-8');
      expect(body).toContain('## Turn close');
      expect(body).toContain('genie done');
      expect(body).toMatch(/genie blocked --reason/);
      expect(body).toMatch(/genie failed --reason/);
    });

    test(`skills/${skill}/SKILL.md close-verb block is near the end`, () => {
      const path = join(REPO_ROOT, 'skills', skill, 'SKILL.md');
      const body = readFileSync(path, 'utf-8');
      const idx = body.indexOf('## Turn close');
      expect(idx).toBeGreaterThan(-1);
      // "Near the end" = no other `## ` heading after Turn close.
      const after = body.slice(idx + '## Turn close'.length);
      expect(after).not.toMatch(/\n## /);
    });
  }
});
