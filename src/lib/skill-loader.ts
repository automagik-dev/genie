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

import { access, readFile, readdir } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';

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
export async function findSkill(
  skillName: string,
  projectRoot?: string
): Promise<SkillInfo | null> {
  const dirNames = skillNameToDirs(skillName);
  const cwd = projectRoot || process.cwd();

  // Search locations in order of precedence
  const searchLocations = [
    join(cwd, '.claude', 'skills'),
    join(homedir(), '.claude', 'skills'),
  ];

  for (const location of searchLocations) {
    for (const dirName of dirNames) {
      const skillPath = join(location, dirName);
      const skillFile = join(skillPath, 'SKILL.md');

      if (await pathExists(skillFile)) {
        // Parse description from frontmatter if available
        let description: string | undefined;
        try {
          const content = await readFile(skillFile, 'utf-8');
          const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
          if (frontmatterMatch) {
            const descMatch = frontmatterMatch[1].match(/description:\s*["']?([^"'\n]+)["']?/);
            if (descMatch) {
              description = descMatch[1];
            }
          }
        } catch {
          // Ignore parse errors
        }

        return {
          name: skillName,
          path: skillPath,
          skillFile,
          description,
        };
      }
    }
  }

  return null;
}

/**
 * Validate that a skill exists and has required files
 *
 * @param skillPath - Path to skill directory
 * @returns true if valid, false otherwise
 */
export async function validateSkill(skillPath: string): Promise<boolean> {
  const skillFile = join(skillPath, 'SKILL.md');
  return pathExists(skillFile);
}

/**
 * Read skill content from SKILL.md
 *
 * @param skillFile - Path to SKILL.md
 * @returns Skill content as string
 */
export async function readSkillContent(skillFile: string): Promise<string> {
  return readFile(skillFile, 'utf-8');
}

/**
 * Build a prompt that loads a skill
 *
 * Reads the skill file and includes its content directly in the prompt.
 *
 * @param skill - SkillInfo from findSkill
 * @param additionalPrompt - Optional additional context/instructions
 * @returns Combined prompt string
 */
export async function buildSkillPrompt(
  skill: SkillInfo,
  additionalPrompt?: string
): Promise<string> {
  // Read the skill content
  const skillContent = await readFile(skill.skillFile, 'utf-8');

  const parts = [
    `You are running skill: ${skill.name}`,
    '',
    '## Skill Instructions',
    '',
    skillContent,
  ];

  if (additionalPrompt) {
    parts.push('', '---', '', '## Additional Context', '', additionalPrompt);
  }

  return parts.join('\n');
}

/**
 * Parse skill name from SKILL.md frontmatter
 * Falls back to directory name conversion if no frontmatter name
 */
async function parseSkillName(skillFile: string, dirName: string): Promise<string> {
  try {
    const content = await readFile(skillFile, 'utf-8');
    const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
    if (frontmatterMatch) {
      const nameMatch = frontmatterMatch[1].match(/name:\s*["']?([^"'\n]+)["']?/);
      if (nameMatch) {
        return nameMatch[1].trim();
      }
    }
  } catch {
    // Ignore errors
  }
  // Fallback: convert first hyphen to colon (genie-wish -> genie:wish)
  // but leave subsequent hyphens as-is for multi-word names
  return dirName.replace(/-/, ':');
}

/**
 * List all available skills
 *
 * @param projectRoot - Project root directory (defaults to cwd)
 * @returns Array of skill names found
 */
export async function listSkills(projectRoot?: string): Promise<string[]> {
  const skills = await listSkillsDetailed(projectRoot);
  return skills.map(s => s.name).sort();
}

/**
 * Detailed skill info for listing
 */
export interface DetailedSkillInfo {
  name: string;
  source: SkillSource;
  pluginName?: string;
  path: string;
  description?: string;
}

/**
 * List all available skills with detailed info
 *
 * Searches:
 * 1. Local: .claude/skills/
 * 2. User: ~/.claude/skills/
 * 3. Plugins: ~/.claude/plugins/<plugin>/skills/
 *
 * @param projectRoot - Project root directory (defaults to cwd)
 * @returns Array of detailed skill info
 */
export async function listSkillsDetailed(projectRoot?: string): Promise<DetailedSkillInfo[]> {
  const cwd = projectRoot || process.cwd();
  const skills: DetailedSkillInfo[] = [];
  const seenNames = new Set<string>();

  // Helper to add skill if not already seen
  const addSkill = async (
    skillFile: string,
    dirName: string,
    source: SkillSource,
    pluginName?: string
  ) => {
    const skillName = await parseSkillName(skillFile, dirName);
    const fullName = pluginName ? `${pluginName}:${skillName}` : skillName;

    if (!seenNames.has(fullName)) {
      seenNames.add(fullName);
      const description = await parseSkillDescription(skillFile);
      skills.push({
        name: fullName,
        source,
        pluginName,
        path: skillFile,
        description,
      });
    }
  };

  // 1. Local skills (.claude/skills/)
  const localPath = join(cwd, '.claude', 'skills');
  await scanSkillsDir(localPath, 'local', addSkill);

  // 2. User skills (~/.claude/skills/)
  const userPath = join(homedir(), '.claude', 'skills');
  await scanSkillsDir(userPath, 'user', addSkill);

  // 3. Plugin skills (~/.claude/plugins/<plugin>/skills/)
  const pluginsPath = join(homedir(), '.claude', 'plugins');
  try {
    const pluginEntries = await readdir(pluginsPath, { withFileTypes: true });
    for (const entry of pluginEntries) {
      // Skip cache, marketplaces, and non-directories/symlinks
      if (entry.name === 'cache' || entry.name === 'marketplaces') {
        continue;
      }
      // Check for directory OR symlink (symlinks to plugin dirs are common)
      if (!entry.isDirectory() && !entry.isSymbolicLink()) {
        continue;
      }

      const pluginSkillsPath = join(pluginsPath, entry.name, 'skills');
      await scanSkillsDir(pluginSkillsPath, 'plugin', addSkill, entry.name);
    }
  } catch {
    // Plugins directory doesn't exist
  }

  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Parse description from skill file frontmatter
 */
async function parseSkillDescription(skillFile: string): Promise<string | undefined> {
  try {
    const content = await readFile(skillFile, 'utf-8');
    const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
    if (frontmatterMatch) {
      const descMatch = frontmatterMatch[1].match(/description:\s*["']?([^"'\n]+)["']?/);
      if (descMatch) {
        return descMatch[1];
      }
    }
  } catch {
    // Ignore parse errors
  }
  return undefined;
}

/**
 * Scan a skills directory and call addSkill for each found skill
 */
async function scanSkillsDir(
  dirPath: string,
  source: SkillSource,
  addSkill: (skillFile: string, dirName: string, source: SkillSource, pluginName?: string) => Promise<void>,
  pluginName?: string
): Promise<void> {
  try {
    const entries = await readdir(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const skillFile = join(dirPath, entry.name, 'SKILL.md');
        if (await pathExists(skillFile)) {
          await addSkill(skillFile, entry.name, source, pluginName);
        }
      }
    }
  } catch {
    // Directory doesn't exist, skip
  }
}

