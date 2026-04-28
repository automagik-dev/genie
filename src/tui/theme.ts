/**
 * TUI theme — Severance Lumon-MDR palette.
 *
 * Hard re-export of the workspace `genie-tokens` package. No backward-compat
 * aliases for the old purple/violet/cyan/emerald names; every call site has
 * been migrated to semantic tokens (accent, accentBright, success, info,
 * etc.). See packages/genie-tokens/palette.ts for the source of truth.
 */

export { palette } from '../../packages/genie-tokens';
export type { PaletteKey } from '../../packages/genie-tokens';
export { tokens } from '../../packages/genie-tokens';
export type { TokenKey } from '../../packages/genie-tokens';

/** Icons for tree node types */
export const icons = {
  org: '◆', // ◆
  project: '▸', // ▸
  projectOpen: '▾', // ▾
  board: '≡', // ≡
  boardOpen: '≡',
  column: '│', // │
  task: '○', // ○
  taskActive: '●', // ●
  taskDone: '✓', // ✓
  agent: '▶', // ▶
  collapsed: '▸', // ▸
  expanded: '▾', // ▾
} as const;
