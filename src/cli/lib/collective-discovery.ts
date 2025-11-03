import fs from 'fs/promises';
import path from 'path';
import YAML from 'yaml';

export interface Collective {
  id: string;
  name: string;
  description: string;
  label?: string;
}

/**
 * Auto-discover collectives by scanning .genie/ for directories with AGENTS.md
 * Collectives are detected by presence of root AGENTS.md file with frontmatter
 */
export async function discoverCollectives(genieRoot: string): Promise<Collective[]> {
  const collectives: Collective[] = [];

  try {
    const entries = await fs.readdir(genieRoot, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      // Skip known system directories
      const skipDirs = ['agents', 'workflows', 'skills', 'backups', 'cli', 'mcp', 'product',
                        'reports', 'scripts', 'specs', 'state', 'teams', 'wishes', 'qa', 'discovery'];
      if (skipDirs.includes(entry.name)) continue;

      // Check for AGENTS.md
      const agentsPath = path.join(genieRoot, entry.name, 'AGENTS.md');
      const exists = await fs.access(agentsPath).then(() => true).catch(() => false);

      if (exists) {
        // Extract metadata from frontmatter
        const content = await fs.readFile(agentsPath, 'utf8');
        const metadata = extractFrontmatter(content);

        collectives.push({
          id: entry.name,
          name: metadata.name || entry.name,
          description: metadata.description || `${entry.name} collective`,
          label: metadata.label || formatLabel(metadata.name || entry.name)
        });
      }
    }

    return collectives.sort((a, b) => a.id.localeCompare(b.id));
  } catch (error) {
    console.error(`Failed to discover collectives: ${error}`);
    return [];
  }
}

/**
 * Extract frontmatter from markdown file
 */
function extractFrontmatter(content: string): Record<string, any> {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};

  try {
    return YAML.parse(match[1]) || {};
  } catch {
    return {};
  }
}

/**
 * Format collective name into display label with emoji
 */
function formatLabel(name: string): string {
  const emojiMap: Record<string, string> = {
    code: '💻',
    create: '✍️',
    utilities: '🔧',
    default: '📦'
  };

  const emoji = emojiMap[name.toLowerCase()] || emojiMap.default;
  const displayName = name.charAt(0).toUpperCase() + name.slice(1);

  return `${emoji} ${displayName}`;
}

/**
 * Get default collective ID (fallback when discovery fails)
 */
export function getDefaultCollectiveId(): string {
  return 'code';
}
