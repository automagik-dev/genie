/**
 * Mosaic Layout — Default tiled layout for tmux worker panes.
 *
 * Provides mosaic/tiled layout as the default (DEC-6), with vertical
 * layout available only when explicitly requested.
 */

// ============================================================================
// Types
// ============================================================================

export type LayoutMode = 'mosaic' | 'vertical';

// ============================================================================
// Layout Application
// ============================================================================

/**
 * Build a tmux command to apply the desired layout to a window.
 *
 * - "mosaic" → `select-layout tiled` (default, DEC-6)
 * - "vertical" → `select-layout even-horizontal`
 *
 * @param windowTarget — tmux window target (e.g., "session:0" or "@4")
 * @param mode — Layout mode. Defaults to "mosaic".
 */
export function buildLayoutCommand(
  windowTarget: string,
  mode: LayoutMode = 'mosaic',
): string {
  const layout = mode === 'vertical' ? 'even-horizontal' : 'tiled';
  return `select-layout -t '${windowTarget}' ${layout}`;
}

/**
 * Determine the layout mode from CLI flags.
 *
 * If `--layout vertical` is specified, use vertical.
 * Otherwise default to mosaic (DEC-6).
 */
export function resolveLayoutMode(layoutFlag?: string): LayoutMode {
  if (layoutFlag === 'vertical') return 'vertical';
  return 'mosaic';
}
