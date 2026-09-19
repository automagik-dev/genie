import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  CATALOG_CHECK_GAP,
  evaluateCatalogCheck,
  mergeCatalog,
  recordedCatalog,
  render,
} from './legacy-skills-catalog.js';

/**
 * These tests inject a SYNTHETIC catalog Map into `render()`. They never walk git history and never
 * shell out to biome: importing the generator used to run the whole CLI, which is why the additive
 * union — the one property that makes a regenerated catalog safe on a clone missing a ref — had no
 * test at all. `render` still reads `skills/` from disk, which is what proves the subtraction half.
 */
const ROOT = join(import.meta.dir, '..');

/** A description genie really shipped — the 2026-07 `pm` skill's, found as residue on the dogfood host. */
const SHIPPED_PM_DESCRIPTION =
  'Full PM playbook — triage backlog, prioritize, assign, track, report, escalate. Copilot, autopilot, or pair modes.';

function shippedSkillNames(): string[] {
  return readdirSync(join(ROOT, 'skills'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

function frontmatterDescription(name: string): string | null {
  const markdown = readFileSync(join(ROOT, 'skills', name, 'SKILL.md'), 'utf8');
  if (!markdown.startsWith('---\n')) return null;
  const end = markdown.indexOf('\n---', 4);
  if (end === -1) return null;
  for (const line of markdown.slice(4, end).split('\n')) {
    const match = /^description:\s*(.*)$/.exec(line);
    if (!match) continue;
    let value = (match[1] as string).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    return value.length > 0 ? value : null;
  }
  return null;
}

/** The first shipped skill whose frontmatter carries a description — the subtraction fixture. */
function aShippedSkill(): { name: string; description: string } {
  for (const name of shippedSkillNames()) {
    const description = frontmatterDescription(name);
    if (description !== null) return { name, description };
  }
  throw new Error('no shipped skill carries a frontmatter description');
}

describe('render is additive', () => {
  test('a recorded name and description survive a render over an empty collected catalog', () => {
    const rendered = render(new Map(), { names: ['pm'], descriptions: [SHIPPED_PM_DESCRIPTION] });

    expect(rendered).toContain('"pm"');
    expect(rendered).toContain(JSON.stringify(SHIPPED_PM_DESCRIPTION));
  });

  test('history entries join the recorded ones rather than replacing them', () => {
    const collected = new Map<string, Set<string>>([
      ['from-history', new Set(['A description only git history knows.'])],
    ]);
    const rendered = render(collected, { names: ['pm'], descriptions: [SHIPPED_PM_DESCRIPTION] });

    expect(rendered).toContain('"from-history"');
    expect(rendered).toContain(JSON.stringify('A description only git history knows.'));
    expect(rendered).toContain('"pm"');
    expect(rendered).toContain(JSON.stringify(SHIPPED_PM_DESCRIPTION));
  });

  test('a collected-only entry needs no recorded catalog to appear', () => {
    const collected = new Map<string, Set<string>>([['solo', new Set(['Solo description.'])]]);
    const rendered = render(collected, { names: [], descriptions: [] });

    expect(rendered).toContain('"solo"');
    expect(rendered).toContain(JSON.stringify('Solo description.'));
  });

  test('only currently shipped names and descriptions are subtracted, from either source', () => {
    const shipped = aShippedSkill();
    const collected = new Map<string, Set<string>>([[shipped.name, new Set([shipped.description])]]);
    const rendered = render(collected, { names: [shipped.name], descriptions: [shipped.description] });

    expect(rendered).not.toContain(`"${shipped.name}"`);
    expect(rendered).not.toContain(JSON.stringify(shipped.description));
  });
});

describe('--check is an additive-union SUPERSET check', () => {
  const collected = new Map<string, Set<string>>([['pm', new Set([SHIPPED_PM_DESCRIPTION])]]);
  const current = new Set<string>();
  const shipping = new Set<string>();

  /** The verdict for a committed catalog that carries exactly `recorded`. */
  function verdictFor(recorded: { names: string[]; descriptions: string[] }, existing?: string) {
    const expected = render(collected, recorded);
    return evaluateCatalogCheck(existing ?? expected, expected, {
      merged: mergeCatalog(collected, recorded, current, shipping),
      recorded,
    });
  }

  test('a seeded stale catalog — one history entry dropped — is reported and names the gap', () => {
    const verdict = verdictFor({ names: [], descriptions: [] }, '// a hand-truncated catalog\n');

    expect(verdict.stale).toBe(true);
    expect(verdict.lines.join('\n')).toContain('stale');
    expect(verdict.lines.join('\n')).toContain('legacy-skills-catalog.ts --write');
    // The gap the CI job closes: history yields entries the committed file lacks.
    expect(verdict.lines.join('\n')).toContain('1 name(s)');
  });

  test('a catalog that already carries every history entry is current', () => {
    const verdict = verdictFor({ names: ['pm'], descriptions: [SHIPPED_PM_DESCRIPTION] });

    expect(verdict.stale).toBe(false);
    expect(verdict.lines.join('\n')).toContain('current');
  });

  /**
   * The gap itself, stated as a test rather than a comment: the union means
   * `--check` proves the committed catalog is a SUPERSET of what THIS clone's
   * history yields — never an exact match. An entry no history yields rides
   * along silently, which is also why a shallow checkout cannot run it.
   */
  test('an entry no history yields is never reported — the union makes it invisible', () => {
    const verdict = verdictFor({
      names: ['pm', 'never-shipped-by-any-ref'],
      descriptions: [SHIPPED_PM_DESCRIPTION, 'A description no commit ever carried.'],
    });

    expect(verdict.stale).toBe(false);
    expect(verdict.lines.join('\n')).toContain(CATALOG_CHECK_GAP);
  });

  test('every verdict states the gap, so a green check is never read as an exact match', () => {
    expect(verdictFor({ names: [], descriptions: [] }, 'stale\n').lines).toContain(CATALOG_CHECK_GAP);
    expect(verdictFor({ names: ['pm'], descriptions: [SHIPPED_PM_DESCRIPTION] }).lines).toContain(CATALOG_CHECK_GAP);
  });

  test('a text-only difference is stale with no missing entry, and says so', () => {
    const recorded = { names: ['pm'], descriptions: [SHIPPED_PM_DESCRIPTION] };
    const verdict = verdictFor(recorded, `${render(collected, recorded)}\n// hand-edited trailer\n`);

    expect(verdict.stale).toBe(true);
    expect(verdict.lines.join('\n')).toContain('formatting or ordering');
  });
});

describe('recordedCatalog', () => {
  test('reads the committed catalog back, so a regeneration can only ever add to it', async () => {
    const recorded = await recordedCatalog();

    expect(recorded.names.length).toBeGreaterThan(0);
    expect(recorded.descriptions.length).toBeGreaterThan(0);
    expect(recorded.names).toContain('pm');
    expect(recorded.descriptions).toContain(SHIPPED_PM_DESCRIPTION);
  });
});
