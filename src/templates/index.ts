/**
 * Scaffold templates — embedded as string constants for single-file bundle compatibility.
 *
 * Source .md files in this directory are the human-editable originals.
 * Keep these constants in sync with the .md files.
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

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

export const AGENTS_TEMPLATE = `---
name: my-agent
description: "Describe what this agent does."
model: inherit
color: blue
promptMode: system
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
 * Write scaffold templates (SOUL.md, HEARTBEAT.md, AGENTS.md) into the target directory.
 */
export function scaffoldAgentFiles(targetDir: string): void {
  writeFileSync(join(targetDir, 'SOUL.md'), SOUL_TEMPLATE);
  writeFileSync(join(targetDir, 'HEARTBEAT.md'), HEARTBEAT_TEMPLATE);
  writeFileSync(join(targetDir, 'AGENTS.md'), AGENTS_TEMPLATE);
}
