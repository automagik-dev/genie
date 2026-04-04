/**
 * Frontmatter Writer — Bidirectional YAML frontmatter sync for AGENTS.md files.
 *
 * Reads an existing AGENTS.md, merges updated frontmatter fields into the YAML
 * block (preserving unknown fields and the markdown body), and writes back.
 *
 * Used by agent-directory.ts `edit()` to sync PG changes back to disk.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import * as yaml from 'js-yaml';
import type { SdkDirectoryConfig } from './sdk-directory-types.js';

/**
 * Frontmatter fields that can be written back to AGENTS.md.
 * Mirrors the AgentFrontmatter type from frontmatter.ts without requiring
 * a re-export (avoids touching the parser module).
 */
interface WritableFrontmatter {
  name?: string;
  description?: string;
  model?: string;
  color?: string;
  promptMode?: string;
  provider?: string;
  tools?: string[];
  permissionMode?: string;
  sdk?: Record<string, unknown>;
}

// =========================================================================
// Public API
// =========================================================================

/**
 * Write (merge) frontmatter fields into an AGENTS.md file.
 *
 * - Reads the existing file and extracts current YAML frontmatter.
 * - Merges `updates` into the existing YAML (preserving unknown fields).
 * - If no frontmatter block exists, creates one at the top of the file.
 * - The markdown body below the frontmatter is preserved exactly.
 */
export function writeFrontmatter(filePath: string, updates: Partial<WritableFrontmatter>): void {
  const content = readFileSync(filePath, 'utf-8');

  const { yamlObj, body } = splitFrontmatter(content);

  // Merge updates into existing YAML (shallow merge — updates win)
  const merged = { ...yamlObj, ...stripUndefined(updates) };

  // Serialize back to YAML
  const yamlStr = yaml.dump(merged, {
    lineWidth: -1, // no line wrapping
    noRefs: true, // no YAML anchors/aliases
    sortKeys: false, // preserve insertion order
    quotingType: '"', // use double quotes when quoting
  });

  // Reconstruct file: frontmatter + body
  const output = `---\n${yamlStr}---\n${body}`;
  writeFileSync(filePath, output, 'utf-8');
}

/**
 * Serialize an SdkDirectoryConfig to a YAML-friendly plain object.
 *
 * Omits undefined values and empty arrays/objects to keep the YAML clean.
 */
export function serializeSdkConfig(sdk: SdkDirectoryConfig): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(sdk)) {
    if (value === undefined || value === null) continue;

    // Omit empty arrays
    if (Array.isArray(value) && value.length === 0) continue;

    // Omit empty objects
    if (typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0) continue;

    result[key] = value;
  }

  return result;
}

// =========================================================================
// Helpers
// =========================================================================

/**
 * Split a markdown file into its YAML frontmatter object and the body text.
 * Returns an empty object if no frontmatter is found; body includes everything
 * after the closing `---` delimiter (including the leading newline).
 */
function splitFrontmatter(content: string): { yamlObj: Record<string, unknown>; body: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) {
    // No frontmatter — entire content becomes body
    return { yamlObj: {}, body: content };
  }

  const yamlStr = match[1];
  const body = match[2];

  let yamlObj: Record<string, unknown> = {};
  try {
    const parsed = yaml.load(yamlStr);
    if (typeof parsed === 'object' && parsed !== null) {
      yamlObj = parsed as Record<string, unknown>;
    }
  } catch {
    // Malformed YAML — start fresh
  }

  return { yamlObj, body };
}

/** Remove keys with undefined values from an object. */
function stripUndefined(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined) {
      result[key] = value;
    }
  }
  return result;
}
