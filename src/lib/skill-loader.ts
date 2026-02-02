/**
 * Skill Loader - Find and load Claude skills
 *
 * Skills are stored in:
 *   1. .claude/skills/<skill-name>/SKILL.md (project local)
 *   2. ~/.claude/skills/<skill-name>/SKILL.md (user global)
 *
 * Skill names are simple (wish, forge, review) and map to directories:
 *   - Direct match: wish -> wish/
 *   - Prefixed: wish -> genie-wish/
 */

import { access, readFile } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';

export interface SkillInfo {
  name: string;
  path: string;
  skillFile: string;
  description?: string;
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
 * Uses prompt injection approach - tells Claude to read and follow the skill.
 *
 * @param skill - SkillInfo from findSkill
 * @param additionalPrompt - Optional additional context/instructions
 * @returns Combined prompt string
 */
export function buildSkillPrompt(
  skill: SkillInfo,
  additionalPrompt?: string
): string {
  const parts = [
    `You are running skill: ${skill.name}`,
    '',
    `Read and follow the skill instructions at: ${skill.skillFile}`,
  ];

  if (additionalPrompt) {
    parts.push('', '---', '', additionalPrompt);
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
  const { readdir } = await import('fs/promises');
  const cwd = projectRoot || process.cwd();
  const skills: string[] = [];

  const searchPaths = [
    join(cwd, '.claude', 'skills'),
    join(homedir(), '.claude', 'skills'),
  ];

  for (const searchPath of searchPaths) {
    try {
      const entries = await readdir(searchPath, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const skillFile = join(searchPath, entry.name, 'SKILL.md');
          if (await pathExists(skillFile)) {
            // Get skill name from frontmatter or convert directory name
            const skillName = await parseSkillName(skillFile, entry.name);
            if (!skills.includes(skillName)) {
              skills.push(skillName);
            }
          }
        }
      }
    } catch {
      // Directory doesn't exist, skip
    }
  }

  return skills.sort();
}
