/**
 * Scaffold templates — embedded as string constants for single-file bundle compatibility.
 *
 * Source .md files in this directory are the human-editable originals.
 * Keep these constants in sync with the .md files.
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BUILTIN_DEFAULTS, type AgentDefaults, computeEffectiveDefaults } from '../lib/defaults.js';

export const SOUL_TEMPLATE = `# Soul

You are an AI assistant. Define your role, personality, and approach here.

Replace this with your agent's identity — who they are, how they communicate, and what they care about.
`;

export const HEARTBEAT_TEMPLATE = `# Heartbeat

Run this checklist on every iteration. Exit early if nothing actionable.

## Checklist

### 1. Check Assignments
Review your task queue. What's assigned to you? Prioritize by urgency and impact.

### 2. Do Work
Execute on your current tasks. Focus on the highest-priority item first.

### 3. Report Progress
Update status on completed or blocked items. Keep it factual.

### 4. Exit If Nothing Actionable
If all work is done and no new tasks exist — exit. Don't create busywork.
`;

/**
 * AGENTS.md template — zero active fields in frontmatter.
 *
 * Two comment categories:
 *   1. Freeform placeholders: fields with no built-in default (only `description` in v1).
 *   2. Inherited defaults: fields with effective defaults computed at scaffold time.
 *      Values are substituted by scaffoldAgentFiles() via {{FIELD}} placeholders.
 *
 * Parsing this frontmatter yields {} — no active values.
 */
export const AGENTS_TEMPLATE = `---
# ── Freeform (no default, fill in as needed) ──
# description: Describe what this agent does.

# ── Inherited defaults (effective values shown, uncomment to override) ──
# model: {{model}}
# promptMode: {{promptMode}}
# color: {{color}}
# effort: {{effort}}
# thinking: {{thinking}}
# permissionMode: {{permissionMode}}
---

@HEARTBEAT.md

<mission>
Define your agent's mission here. What is their primary goal? What do they own?
</mission>

<principles>
- **Clarity over ambiguity.** Be specific about expectations and outcomes.
- **Quality over speed.** Do it right the first time.
</principles>

<constraints>
- List any hard constraints or rules this agent must follow.
</constraints>
`;

/**
 * Render the AGENTS_TEMPLATE with effective default values substituted into
 * the comment placeholders. Optionally prepends an active `name:` field.
 */
function renderAgentsTemplate(
  agentName?: string,
  workspaceDefaults?: Partial<AgentDefaults>,
): string {
  const effective = computeEffectiveDefaults(workspaceDefaults);

  let rendered = AGENTS_TEMPLATE;
  for (const key of Object.keys(BUILTIN_DEFAULTS) as (keyof AgentDefaults)[]) {
    rendered = rendered.replace(`{{${key}}}`, effective[key]);
  }

  // Prepend active name field if provided (after opening ---)
  if (agentName) {
    rendered = rendered.replace('---\n#', `---\nname: ${agentName}\n#`);
  }

  return rendered;
}

/**
 * Write scaffold templates (SOUL.md, HEARTBEAT.md, AGENTS.md) into the target directory.
 * If `agentName` is provided, adds it as an active frontmatter field.
 * If `workspaceDefaults` is provided, computes effective defaults for commented values.
 */
export function scaffoldAgentFiles(
  targetDir: string,
  agentName?: string,
  workspaceDefaults?: Partial<AgentDefaults>,
): void {
  writeFileSync(join(targetDir, 'SOUL.md'), SOUL_TEMPLATE);
  writeFileSync(join(targetDir, 'HEARTBEAT.md'), HEARTBEAT_TEMPLATE);
  writeFileSync(join(targetDir, 'AGENTS.md'), renderAgentsTemplate(agentName, workspaceDefaults));
}
