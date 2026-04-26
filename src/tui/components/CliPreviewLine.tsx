/** @jsxImportSource @opentui/react */
/**
 * CliPreviewLine — renders the exact `genie …` command that a spawn/team
 * modal is about to execute.
 *
 * The component is purely presentational: it calls `buildSpawnInvocation`
 * (the single source of truth from Group 3) and displays the resulting
 * `.cli` string. Parent modals (Groups 4, 5, 6) pass an `intent` and use
 * the SAME intent to execute the command — guaranteeing the preview and
 * the executed argv cannot drift.
 *
 * If the intent is malformed (empty name, unsafe branch chars, unknown
 * kind), `buildSpawnInvocation` throws. We catch the error inline and
 * render a red error row, so a bad intent in one modal field never
 * crashes the surrounding modal.
 */

import { type SpawnIntent, buildSpawnInvocation } from '../../lib/spawn-invocation.js';
import { palette } from '../theme.js';

/**
 * @public - consumed by spawn/team modals in Groups 4, 5, 6 (tui-spawn-dx wish).
 */
export interface CliPreviewLineProps {
  intent: SpawnIntent;
  /** Optional hint override; defaults to "Enter to run · Esc to cancel". */
  hint?: string;
}

const DEFAULT_HINT = 'Enter to run \u00b7 Esc to cancel';

export function CliPreviewLine({ intent, hint = DEFAULT_HINT }: CliPreviewLineProps) {
  let cli: string | null = null;
  let errorMessage: string | null = null;
  try {
    cli = buildSpawnInvocation(intent).cli;
  } catch (err) {
    errorMessage = err instanceof Error ? err.message : String(err);
  }

  if (errorMessage !== null) {
    return (
      <box flexDirection="column" paddingX={1}>
        <text>
          <span fg={palette.error}>{`\u26a0 ${errorMessage}`}</span>
        </text>
        <text>
          <span fg={palette.textMuted}>{hint}</span>
        </text>
      </box>
    );
  }

  return (
    <box flexDirection="column" paddingX={1}>
      <text>
        <span fg={palette.accent}>{'\u25b6 '}</span>
        <span fg={palette.text}>{cli}</span>
      </text>
      <text>
        <span fg={palette.textMuted}>{hint}</span>
      </text>
    </box>
  );
}
