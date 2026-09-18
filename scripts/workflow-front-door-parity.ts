/**
 * The Decision 7 rule every front-door skill states, asserted in ONE place.
 *
 * Until 2026-09-18 the workflow catalog existed only in this repository's
 * project scope, so a front door could tell the runtime a bare saved name and
 * be sure which file it meant. `genie install` / `genie update` now deliver the
 * same catalog to `~/.claude/workflows/`, so both scopes legitimately carry
 * every name — and the order a runtime resolves a bare name in is undocumented
 * (a stale user-scope `council.js` shadowed the project copy on 2026-09-15).
 *
 * The rule is therefore the PATH, not the name: the project file when the
 * repository carries it, the user-scope file otherwise, passed as the explicit
 * script path. Seven parity tests pin it; this is the single assertion they
 * share, so the rule cannot drift between six skills and seven tests.
 */
import { expect } from 'bun:test';

/**
 * A phrasing that sends the runtime at a bare name. Matched as a rule, not as
 * a spelling of one skill's sentence: it fails against the pre-2026-09-18 text
 * ("run the native Workflow tool with the saved name `council`") in every
 * front door at once, while prose that merely discusses saved names — workfly's
 * own note that a name has to be free in both namespaces — stays legal.
 */
const BARE_NAME_INSTRUCTION = /\b(?:with|run|running|by|under|using) the saved name\b/;

/** Assert the front door `skill` states the explicit-script-path rule for `name`. */
export function expectExplicitScriptPathRule(skill: string, name: string): void {
  // The project catalog, which stays the single source of truth.
  expect(skill).toContain(`.claude/workflows/${name}.js`);
  // The user-scope copy the workflows channel installs, named as the fallback.
  expect(skill).toContain(`~/.claude/workflows/${name}.js`);
  // The rule itself, in the words the runtime's operator reads.
  expect(skill).toContain('explicit script path');
  expect(skill).not.toMatch(BARE_NAME_INSTRUCTION);
}
