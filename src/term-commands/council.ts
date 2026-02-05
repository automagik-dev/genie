/**
 * Council command - Spawn dual Claude instances for multi-model deliberation
 *
 * Usage:
 *   term council                    - Use default preset
 *   term council --preset <name>    - Use specific preset
 *   term council --skill <skill>    - Override skill (default: council)
 *
 * Options:
 *   -s, --session <name>     - Target tmux session
 *   --preset <name>          - Council preset to use
 *   --skill <skill>          - Skill to load on both instances
 *   --no-focus               - Don't focus the new window
 *
 * Creates a tmux window with two vertical panes, each running Claude
 * with a different model profile for diverse pair programming.
 */

import * as tmux from '../lib/tmux.js';
import * as skillLoader from '../lib/skill-loader.js';
import { buildSpawnCommand } from '../lib/spawn-command.js';
import {
  loadGenieConfig,
  getWorkerProfile,
  getCouncilPreset,
  getDefaultCouncilPreset,
  getFallbackCouncilPreset,
  getSessionName,
} from '../lib/genie-config.js';
import type { WorkerProfile, CouncilPreset } from '../types/genie-config.js';

// ============================================================================
// Types
// ============================================================================

export interface CouncilOptions {
  session?: string;
  preset?: string;
  skill?: string;
  focus?: boolean;
}

// ============================================================================
// Council Command
// ============================================================================

/**
 * Main council command - spawn dual Claude instances
 */
export async function councilCommand(options: CouncilOptions = {}): Promise<void> {
  const config = await loadGenieConfig();

  // 1. Resolve session
  const session = options.session || getSessionName();

  // 2. Resolve council preset
  let preset: CouncilPreset;

  if (options.preset) {
    // Explicit preset requested
    const found = getCouncilPreset(config, options.preset);
    if (!found) {
      const available = Object.keys(config.councilPresets || {});
      console.error(`\x1b[31m✗ Council preset '${options.preset}' not found.\x1b[0m`);
      if (available.length > 0) {
        console.log(`Available presets: ${available.join(', ')}`);
      } else {
        console.log('No presets configured. Add councilPresets to ~/.genie/config.json');
      }
      process.exit(1);
    }
    preset = found;
  } else {
    // Use default preset, or fallback
    preset = getDefaultCouncilPreset(config) || getFallbackCouncilPreset(config);
  }

  // Allow skill override via flag
  const skillName = options.skill || preset.skill;

  // 3. Validate both worker profiles exist
  const leftProfile = getWorkerProfile(config, preset.left);
  const rightProfile = getWorkerProfile(config, preset.right);

  if (!leftProfile) {
    console.error(`\x1b[31m✗ Left profile '${preset.left}' not found.\x1b[0m`);
    console.log(`Run: genie profiles add ${preset.left}`);
    process.exit(1);
  }

  if (!rightProfile) {
    console.error(`\x1b[31m✗ Right profile '${preset.right}' not found.\x1b[0m`);
    console.log(`Run: genie profiles add ${preset.right}`);
    process.exit(1);
  }

  // 4. Check if skill exists (optional - will skip warmup if not found)
  let skill: skillLoader.SkillInfo | null = null;
  if (skillName) {
    skill = await skillLoader.findSkill(skillName);
    if (!skill) {
      console.log(`\x1b[33m⚠ Skill '${skillName}' not found - spawning without warmup\x1b[0m`);
    }
  }

  // 5. Ensure session exists
  const sessions = await tmux.listSessions();
  const sessionExists = sessions.some(s => s.name === session);
  if (!sessionExists) {
    console.log(`Creating tmux session: ${session}`);
    await tmux.executeTmux(`new-session -d -s '${session}'`);
  }

  // 6. Find unique window name
  const windows = await tmux.listWindows(session);
  const windowNames = windows.map(w => w.name);
  let windowName = 'council';
  let counter = 1;
  while (windowNames.includes(windowName)) {
    windowName = `council-${counter}`;
    counter++;
  }

  // 7. Create new window with left pane
  console.log(`\nCreating council window: ${windowName}`);
  await tmux.executeTmux(`new-window -t '${session}' -n '${windowName}'`);

  const leftPaneId = `${session}:${windowName}.0`;

  // 8. Split horizontally for right pane (50/50)
  await tmux.executeTmux(`split-window -h -t '${leftPaneId}'`);
  const rightPaneId = `${session}:${windowName}.1`;

  // 9. Get working directory
  const cwd = process.cwd();
  const escapedCwd = cwd.replace(/'/g, "'\\''");

  // 10. Build spawn commands
  const leftCmd = buildSpawnCommand(leftProfile, {});
  const rightCmd = buildSpawnCommand(rightProfile, {});

  // 11. Start Claude in both panes
  console.log(`   Left pane:  ${preset.left}`);
  console.log(`   Right pane: ${preset.right}`);
  if (skill) {
    console.log(`   Skill:      ${skillName}`);
  }

  await tmux.executeCommand(leftPaneId, `cd '${escapedCwd}' && ${leftCmd}`, true, false);
  await tmux.executeCommand(rightPaneId, `cd '${escapedCwd}' && ${rightCmd}`, true, false);

  // 12. Wait for Claude instances to start, then send skill if available
  if (skill) {
    await new Promise(resolve => setTimeout(resolve, 2500));

    // 13. Send skill to both panes
    const slashCommand = `/${skillName}`;
    const escapedSlash = slashCommand.replace(/'/g, "'\\''");

    await tmux.executeTmux(`send-keys -t '${leftPaneId}' '${escapedSlash}' Enter`);
    await tmux.executeTmux(`send-keys -t '${rightPaneId}' '${escapedSlash}' Enter`);
  }

  // 14. Focus left pane (unless disabled)
  if (options.focus !== false) {
    await tmux.executeTmux(`select-pane -t '${leftPaneId}'`);
  }

  // 15. Summary
  console.log(`\n\x1b[32m✓ Council ready\x1b[0m`);
  console.log(`\n  Window: ${session}:${windowName}`);
  console.log(`  Switch panes: Ctrl-B + arrow keys`);
  console.log(`  Attach: term attach ${session}:${windowName}`);
  console.log('');
}
