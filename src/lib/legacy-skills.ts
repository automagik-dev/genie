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
 * is proven by DESCRIPTION instead. Every frontmatter `description` a genie
 * skill ever carried, under any name on any ref, is embedded in
 * `legacy-skills-catalog.ts`; a directory outside the current inventory whose
 * `SKILL.md` carries one of them is genie's own — a third party does not copy
 * genie's description verbatim — and is retired backup-first like any other
 * retired skill. A directory that merely carries a NAME genie once shipped is
 * reported for a human and never moved: `brain` is a live third-party product
 * on the dogfood host today, and genie once shipped a `brain` skill too.
 */
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { GENIE_SKILL_DESCRIPTIONS, LEGACY_MARKER_DIRS, LEGACY_SKILL_NAMES } from './legacy-skills-catalog.js';

/**
 * `proven`: a `SKILL.md` description genie shipped — retired backup-first.
 * `marker`: a `.genie-*` transaction dir a deleted runtime left — genie's by name.
 * `name-only`: a retired genie skill NAME with a description genie never shipped
 * — reported, never moved.
 */
export type LegacySkillLeftoverKind = 'proven' | 'marker' | 'name-only';

export interface LegacySkillLeftover {
  agentDir: string;
  /** The directory entry name under `agentDir`. */
  entry: string;
  kind: LegacySkillLeftoverKind;
}

const DESCRIPTIONS = new Set(GENIE_SKILL_DESCRIPTIONS);
const NAMES = new Set(LEGACY_SKILL_NAMES);
const MARKERS = new Set(LEGACY_MARKER_DIRS);

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
  if (description !== null && DESCRIPTIONS.has(description)) return { agentDir, entry, kind: 'proven' };
  if (NAMES.has(entry) && description !== null) return { agentDir, entry, kind: 'name-only' };
  return null;
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
