/**
 * Wish Editor - Read-only wish document parsing
 *
 * Enables agents to read and inspect wish documents by section.
 * File-based, works across processes, no HTTP needed.
 *
 * Design principles:
 *   - Read-only (edits use filesystem directly)
 *   - Section-level parsing by markdown headings
 *   - Partial-match section lookup
 */

import { readFile, readdir, access, stat } from 'fs/promises';
import { join } from 'path';

// ============================================================================
// Types
// ============================================================================

/**
 * Represents a parsed wish document with sections
 */
export interface WishDocument {
  /** Raw markdown content */
  raw: string;
  /** Wish slug */
  slug: string;
  /** Parsed sections (keyed by heading text) */
  sections: WishSection[];
  /** File modification time */
  mtime: number;
  /** File path */
  path: string;
}

/**
 * A section in a wish document (delimited by headings)
 */
export interface WishSection {
  /** Section heading (without #) */
  heading: string;
  /** Section content (including the heading line and nested subsections) */
  content: string;
  /** Line offset in the document */
  startLine: number;
  /** End line (exclusive) */
  endLine: number;
  /** Nesting level (1 = #, 2 = ##, 3 = ###) */
  level: number;
}

// ============================================================================
// Slug Validation
// ============================================================================

/**
 * Validate a slug to prevent path traversal attacks.
 * Slugs must be simple directory names — no slashes, backslashes, or ".." sequences.
 */
export function validateSlug(slug: string): void {
  if (slug.includes('..') || slug.includes('/') || slug.includes('\\') || slug.includes('\0')) {
    throw new Error(`Invalid wish slug "${slug}": must not contain path traversal characters (.. / \\)`);
  }
}

// ============================================================================
// Path Utilities
// ============================================================================

export function getWishPath(repoPath: string, slug: string): string {
  validateSlug(slug);
  return join(repoPath, '.genie', 'wishes', slug, 'wish.md');
}

export function getWishDir(repoPath: string, slug: string): string {
  validateSlug(slug);
  return join(repoPath, '.genie', 'wishes', slug);
}

// ============================================================================
// Parsing
// ============================================================================

/**
 * Parse markdown content into sections by headings.
 * Handles # through #### levels. Code blocks with # are ignored.
 *
 * Section boundaries: a section runs from its heading until the next heading
 * of the same or higher level (lower number). Child headings (deeper nesting)
 * are included in the parent section's content.
 *
 * Example: ## Overview ... ### Details ... ## Next
 *   → "Overview" section includes "### Details" content
 *   → "Details" section is its own entry too
 */
export function parseSections(content: string): WishSection[] {
  const lines = content.split('\n');
  const headings: Array<{ heading: string; level: number; startLine: number }> = [];
  let inCodeBlock = false;

  // First pass: find all headings
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.trimStart().startsWith('```')) {
      inCodeBlock = !inCodeBlock;
      continue;
    }
    if (inCodeBlock) continue;

    const headingMatch = line.match(/^(#{1,4})\s+(.+)$/);
    if (headingMatch) {
      headings.push({
        heading: headingMatch[2].trim(),
        level: headingMatch[1].length,
        startLine: i,
      });
    }
  }

  // Second pass: compute end lines based on same-or-higher-level boundaries
  const sections: WishSection[] = headings.map((h, idx) => {
    // Find next heading at same or higher level (lower number = higher level)
    let endLine = lines.length;
    for (let j = idx + 1; j < headings.length; j++) {
      if (headings[j].level <= h.level) {
        endLine = headings[j].startLine;
        break;
      }
    }

    return {
      heading: h.heading,
      level: h.level,
      startLine: h.startLine,
      endLine,
      content: lines.slice(h.startLine, endLine).join('\n'),
    };
  });

  return sections;
}

/**
 * Read and parse a wish document
 */
export async function readWish(repoPath: string, slug: string): Promise<WishDocument | null> {
  const wishPath = getWishPath(repoPath, slug);

  try {
    const [content, fileStat] = await Promise.all([
      readFile(wishPath, 'utf-8'),
      stat(wishPath),
    ]);

    return {
      raw: content,
      slug,
      sections: parseSections(content),
      mtime: fileStat.mtimeMs,
      path: wishPath,
    };
  } catch {
    return null;
  }
}

/**
 * Find a section by heading (case-insensitive, partial match)
 */
export function findSection(document: WishDocument, heading: string): WishSection | null {
  const lower = heading.toLowerCase();

  // Exact match first
  const exact = document.sections.find(s => s.heading.toLowerCase() === lower);
  if (exact) return exact;

  // Partial match
  const partial = document.sections.find(s => s.heading.toLowerCase().includes(lower));
  return partial || null;
}

/**
 * List all section headings
 */
export function listSections(document: WishDocument): Array<{ heading: string; level: number; lineCount: number }> {
  return document.sections.map(s => ({
    heading: s.heading,
    level: s.level,
    lineCount: s.endLine - s.startLine,
  }));
}

/**
 * Check if a wish exists
 */
export async function wishExists(repoPath: string, slug: string): Promise<boolean> {
  try {
    await access(getWishPath(repoPath, slug));
    return true;
  } catch {
    return false;
  }
}

/**
 * List all wish slugs in a repository
 */
export async function listWishSlugs(repoPath: string): Promise<string[]> {
  const wishesDir = join(repoPath, '.genie', 'wishes');

  try {
    const entries = await readdir(wishesDir, { withFileTypes: true });

    const results = await Promise.all(
      entries
        .filter(entry => entry.isDirectory())
        .map(async (entry) => {
          try {
            await access(join(wishesDir, entry.name, 'wish.md'));
            return entry.name;
          } catch {
            return null;
          }
        })
    );

    return results.filter((slug): slug is string => slug !== null).sort();
  } catch {
    return [];
  }
}
