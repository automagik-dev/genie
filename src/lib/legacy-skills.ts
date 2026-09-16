/**
 * Recognising genie skill directories that predate the install record.
 *
 * `skills-install.json` is the authority for everything genie wrote through the
 * skills.sh channel, and both `genie update` (retirement) and `genie doctor`
 * (observation) walk it. A directory genie installed BEFORE that record existed
 * — the plugin-era and `--all`-era installs of 2026-07/08 — is named by no
 * record, so on 2026-09-16 a host updated cleanly (`nothing to retire`, every
 * recorded home complete) while `~/.agents/skills` still carried `genie-review`,
 * `pm` and `wizard` from 2026-07-10 and a `.genie-codex-fallback-retirement/`
 * transaction dir from a runtime deleted in August.
 *
 * Ownership of such a directory cannot be proven by bytes: those installs were
 * copied from working trees, so no digest genie ever shipped matches them. It
 * is proven by DESCRIPTION under a GENIE NAME instead. Every retired frontmatter
 * `description` a genie skill ever carried — any name, any ref, minus what the
 * tree ships today — is embedded in `legacy-skills-catalog.ts`; a directory
 * outside the current inventory whose `SKILL.md` carries one of them AND whose
 * name is a retired genie skill name or a `genie-` prefixed one is genie's own,
 * and is retired backup-first like any other retired skill. Either half alone
 * is only reported: `brain` is a live third-party product on the dogfood host
 * today and genie once shipped a `brain` skill too (name alone), and a user's
 * fork of a genie skill under a custom name keeps genie's description
 * (description alone). A fork of a CURRENT skill is never even a candidate,
 * because current descriptions are deliberately absent from the catalog.
 */
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { LEGACY_MARKER_DIRS, LEGACY_SKILL_DESCRIPTIONS, LEGACY_SKILL_NAMES } from './legacy-skills-catalog.js';
import { SKILLS_CLI_AGENTS, agentSkillsHome } from './skills-agents.js';

/**
 * `proven`: a retired genie description under a genie name — retired backup-first.
 * `marker`: a `.genie-*` transaction dir a deleted runtime left — genie's by name.
 * `unproven`: a retired genie NAME or a retired genie DESCRIPTION, not both —
 * reported, never moved.
 */
export type LegacySkillLeftoverKind = 'proven' | 'marker' | 'unproven';

export interface LegacySkillLeftover {
  agentDir: string;
  /** The directory entry name under `agentDir`. */
  entry: string;
  kind: LegacySkillLeftoverKind;
}

const DESCRIPTIONS = new Set(LEGACY_SKILL_DESCRIPTIONS);
const NAMES = new Set(LEGACY_SKILL_NAMES);
const MARKERS = new Set(LEGACY_MARKER_DIRS);

/** A retired genie skill name, or the `genie-` prefix only genie's own plugin-era skills carried. */
function isGenieSkillName(entry: string): boolean {
  return NAMES.has(entry) || entry.startsWith('genie-');
}

/**
 * The frontmatter `description` of one `SKILL.md`, unquoted, or `null` when the
 * file is absent, unreadable, has no frontmatter, or names no description.
 * Deliberately the same narrow parser the catalog generator uses, so a
 * description the generator recorded is one this reader recognises.
 */
export function readSkillDescription(skillDir: string): string | null {
  let markdown: string;
  try {
    markdown = readFileSync(join(skillDir, 'SKILL.md'), 'utf8');
  } catch {
    return null;
  }
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

function isPhysicalDirectory(path: string): boolean {
  try {
    const stat = lstatSync(path);
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Classify one entry of an agent skills home. `null` for the current inventory
 * (delivered skills are the record's business), for symlinks (never genie's —
 * the channel copies), and for everything genie has no claim on.
 */
export function classifyLegacySkillEntry(
  agentDir: string,
  entry: string,
  inventory: readonly string[],
): LegacySkillLeftover | null {
  if (inventory.includes(entry)) return null;
  const path = join(agentDir, entry);
  if (!isPhysicalDirectory(path)) return null;
  if (MARKERS.has(entry)) return { agentDir, entry, kind: 'marker' };
  const description = readSkillDescription(path);
  if (description === null) return null;
  const genieName = isGenieSkillName(entry);
  const genieDescription = DESCRIPTIONS.has(description);
  if (genieName && genieDescription) return { agentDir, entry, kind: 'proven' };
  if (genieName || genieDescription) return { agentDir, entry, kind: 'unproven' };
  return null;
}

/**
 * The homes a legacy scan covers: every directory the record names, plus every
 * skills home in the skills.sh agent registry that exists on disk. The four-row
 * known table is not enough — the `--all` era wrote `~/.openclaw/skills` and
 * fifty more, and a host with no record has nothing else naming them.
 */
export function legacyScanHomes(home: string, recorded: readonly string[]): string[] {
  const homes = new Set(recorded);
  for (const spec of SKILLS_CLI_AGENTS) {
    const dir = agentSkillsHome(home, spec);
    if (isPhysicalDirectory(dir)) homes.add(dir);
  }
  return [...homes].sort();
}

/**
 * Every legacy leftover across the given agent homes, sorted by path so the
 * transcript and the doctor line are stable. A home that cannot be listed
 * contributes nothing — it is the recorded-agent-dirs check's job to say so.
 */
export function findLegacySkillLeftovers(
  agentDirs: readonly string[],
  inventory: readonly string[],
): LegacySkillLeftover[] {
  const found: LegacySkillLeftover[] = [];
  for (const agentDir of [...new Set(agentDirs)].sort()) {
    let entries: string[];
    try {
      entries = readdirSync(agentDir);
    } catch {
      continue;
    }
    for (const entry of entries.sort()) {
      const leftover = classifyLegacySkillEntry(agentDir, entry, inventory);
      if (leftover !== null) found.push(leftover);
    }
  }
  return found;
}
