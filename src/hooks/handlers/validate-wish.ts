/**
 * Wish Validation Handler — PreToolUse:Write
 *
 * Validates wish document structure before writing.
 * Warns (does not block) if required sections are missing.
 *
 * Priority: 5 (after orchestration guards, before identity-inject)
 */

import { existsSync, readFileSync } from 'node:fs';
import type { HandlerResult, HookPayload } from '../types.js';

const REQUIRED_SECTIONS = [
  { pattern: /^##\s+Summary/m, name: '## Summary' },
  { pattern: /^##\s+Scope/m, name: '## Scope' },
  { pattern: /^###\s+IN/m, name: '### IN (under Scope)' },
  { pattern: /^###\s+OUT/m, name: '### OUT (under Scope)' },
  { pattern: /^##\s+Success Criteria/m, name: '## Success Criteria' },
  { pattern: /^##\s+Execution Groups/m, name: '## Execution Groups' },
];

function checkSections(content: string): string[] {
  const issues: string[] = [];
  for (const { pattern, name } of REQUIRED_SECTIONS) {
    if (!pattern.test(content)) issues.push(`Missing required section: ${name}`);
  }
  return issues;
}

function checkGroups(content: string): string[] {
  const issues: string[] = [];
  if (!/^###\s+Group\s+[A-Z]:/m.test(content)) {
    issues.push('Missing execution group (need at least one ### Group X: section)');
  }
  const execIdx = content.indexOf('## Execution Groups');
  if (execIdx >= 0) {
    const afterExec = content.slice(execIdx);
    if (!afterExec.includes('**Acceptance Criteria:**'))
      issues.push('Execution groups should have **Acceptance Criteria:** sections');
    if (!afterExec.includes('**Validation:**'))
      issues.push('Execution groups should have **Validation:** command sections');
  }
  return issues;
}

function checkScopeAndCriteria(content: string): string[] {
  const issues: string[] = [];
  const outMatch = content.match(/^###\s+OUT\s*\n([\s\S]*?)(?=^##|^###|\n---)/m);
  if (outMatch) {
    const outContent = outMatch[1].trim();
    if (!outContent || outContent === '-' || /^-\s*$/.test(outContent)) issues.push('OUT scope should not be empty');
  }
  const successSection = content.match(/^##\s+Success Criteria\s*\n([\s\S]*?)(?=^##|\n---)/m);
  if (successSection && (successSection[1].match(/^-\s+\[\s*\]/gm) || []).length === 0) {
    issues.push('Success Criteria should have checkbox items (- [ ])');
  }
  return issues;
}

function validateWishContent(content: string): string[] {
  return [...checkSections(content), ...checkGroups(content), ...checkScopeAndCriteria(content)];
}

export async function validateWish(payload: HookPayload): Promise<HandlerResult> {
  const filePath = payload.tool_input?.file_path;
  if (typeof filePath !== 'string') return undefined;

  // Only validate wish files
  if (!filePath.includes('.genie/wishes/') || !filePath.endsWith('.md')) return undefined;

  // Skip new files (being created for the first time)
  if (!existsSync(filePath)) return undefined;

  const content = readFileSync(filePath, 'utf-8');
  const issues = validateWishContent(content);

  if (issues.length === 0) return undefined;

  // Warn but don't block — return reason as advisory
  console.error(`⚠ Wish validation issues:\n${issues.map((i) => `  - ${i}`).join('\n')}`);
  return undefined;
}
