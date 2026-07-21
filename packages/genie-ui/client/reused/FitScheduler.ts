// ===========================================================================
// REUSED VERBATIM from dash (syv-ai/dash, MIT) — origin: src/renderer/terminal/FitScheduler.ts
// (salvaged via ~/prod/genie-ui-ab/dash-fork/fleet/web/reused/FitScheduler.ts).
// Unmodified except this provenance header.
// ===========================================================================
/**
 * Debounced fit scheduling for terminal containers that animate and collapse.
 *
 * The drawer collapse/expand animates over ~200ms, so resize events arrive in
 * bursts and the fit must wait out the transition. The trap: when the
 * container reaches a hidden height, any fit scheduled by an earlier
 * (still-visible) event must be CANCELLED — if it fires against a hidden
 * container, FitAddon clamps to its 1-row minimum and squashes the PTY,
 * leaving an extra prompt line behind after every collapse/expand cycle.
 */
const HIDDEN_HEIGHT_PX = 10;

export class FitScheduler {
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private fit: () => void,
    private delayMs: number,
  ) {}

  onResize(height: number): void {
    this.cancel();
    if (height < HIDDEN_HEIGHT_PX) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.fit();
    }, this.delayMs);
  }

  cancel(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
