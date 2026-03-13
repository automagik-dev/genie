/**
 * Skill Loader - Find and load Claude skills
 *
 * Skills are stored in:
 *   1. .claude/skills/<skill-name>/SKILL.md (project local)
 *   2. ~/.claude/skills/<skill-name>/SKILL.md (user global)
 *   3. ~/.claude/plugins/<plugin-name>/skills/<skill>/SKILL.md (plugins)
 *
 * Skill names are simple (wish, forge, review) and map to directories:
 *   - Direct match: wish -> wish/
 *   - Prefixed: wish -> genie-wish/
 */

import { access, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type SkillSource = 'local' | 'user' | 'plugin';

export interface SkillInfo {
  name: string;
  path: string;
  skillFile: string;
  description?: string;
  source?: SkillSource;
  pluginName?: string;
}

/**
 * Get possible directory names for a skill
 * e.g., "wish" -> ["wish", "genie-wish"]
 */
function skillNameToDirs(skillName: string): string[] {
  return [skillName, `genie-${skillName}`];
}

/**
 * Check if a path exists
 */
async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Find a skill by name
 *
 * Search order:
 * 1. .claude/skills/<skill-dir>/SKILL.md (project local)
 * 2. ~/.claude/skills/<skill-dir>/SKILL.md (user global)
 *
 * For each location, tries both exact name and genie-prefixed name.
 *
 * @param skillName - Skill name (e.g., "wish", "forge", "review")
 * @param projectRoot - Project root directory (defaults to cwd)
 * @returns SkillInfo if found, null otherwise
 */
async function parseSkillDescription(filePath: string): Promise<string | undefined> {
  try {
    const content = await readFile(filePath, 'utf-8');
    const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
    if (!frontmatterMatch) return undefined;
    const descMatch = frontmatterMatch[1].match(/description:\s*["']?([^"'\n]+)["']?/);
    return descMatch ? descMatch[1] : undefined;
  } catch {
    return undefined;
  }
}

export async function findSkill(skillName: string, projectRoot?: string): Promise<SkillInfo | null> {
  const dirNames = skillNameToDirs(skillName);
  const cwd = projectRoot || process.cwd();
  const searchLocations = [join(cwd, '.claude', 'skills'), join(homedir(), '.claude', 'skills')];

  for (const location of searchLocations) {
    for (const dirName of dirNames) {
      const skillPath = join(location, dirName);
      const skillFile = join(skillPath, 'SKILL.md');

      if (await pathExists(skillFile)) {
        return {
          name: skillName,
          path: skillPath,
          skillFile,
          description: await parseSkillDescription(skillFile),
        };
      }
    }
  }

  return null;
}
