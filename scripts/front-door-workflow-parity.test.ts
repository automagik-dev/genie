import { describe, expect, test } from 'bun:test';
import { expectExplicitScriptPathRule } from './workflow-front-door-parity.js';

// The seven front-door parity tests all delegate to one assertion, so that
// assertion is now the single thing standing between a front door and a bare
// saved name. A guard nothing guards is a guard nobody can trust: these tests
// prove it REJECTS each way the rule can be broken, one way at a time.
//
// The first case is the review finding this file exists for. While the project
// half asserted a bare `.claude/workflows/<name>.js`, it was a substring of the
// user-scope path asserted on the next line, so a skill that named ONLY
// `~/.claude/workflows/council.js` satisfied both halves and the rule silently
// lost its project-first clause.

const CANONICAL =
  'Run the script at `<repository root>/.claude/workflows/council.js` when that file exists, otherwise ' +
  '`~/.claude/workflows/council.js` (delivered by `genie install` / `genie update`); pass it as the ' +
  'explicit script path, never a bare name.';

describe('the shared front-door rule rejects every way of breaking it', () => {
  test('the canonical sentence passes', () => {
    expect(() => expectExplicitScriptPathRule(CANONICAL, 'council')).not.toThrow();
  });

  test('a text naming ONLY the user-scope path fails', () => {
    const userScopeOnly = 'Run `~/.claude/workflows/council.js` as the explicit script path, never a bare name.';
    expect(() => expectExplicitScriptPathRule(userScopeOnly, 'council')).toThrow();
  });

  test('a text naming ONLY the project path fails', () => {
    const projectOnly =
      'Run the script at `<repository root>/.claude/workflows/council.js` as the explicit script path.';
    expect(() => expectExplicitScriptPathRule(projectOnly, 'council')).toThrow();
  });

  test('a text that states both paths but not the rule fails', () => {
    const noRule = CANONICAL.replace('explicit script path', 'path');
    expect(() => expectExplicitScriptPathRule(noRule, 'council')).toThrow();
  });

  test('a text that still instructs a bare-name run fails', () => {
    const bareName = `${CANONICAL} On Claude Code, run the native Workflow tool with the saved name \`council\`.`;
    expect(() => expectExplicitScriptPathRule(bareName, 'council')).toThrow();
  });

  test('prose that merely discusses saved names is not a bare-name instruction', () => {
    // `skills/workfly/SKILL.md` legitimately tells authors that a saved name has
    // to be free in both namespaces. The rule bans the INSTRUCTION, not the noun.
    const discussion = `${CANONICAL} A saved name has to be free in both namespaces a runtime resolves from one list.`;
    expect(() => expectExplicitScriptPathRule(discussion, 'council')).not.toThrow();
  });
});
