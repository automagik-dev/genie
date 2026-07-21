// ===========================================================================
// REUSED VERBATIM from dash (syv-ai/dash, MIT) — origin: src/main/services/TerminalMirror.ts
// (salvaged via ~/prod/genie-ui-ab/dash-fork/fleet/server/reused/TerminalMirror.ts).
// The headless-xterm snapshot/scrollback engine — the core 'why fork' machinery.
//
// Unmodified EXCEPT the two import lines below use createRequire instead of
// `import { Terminal } from '@xterm/headless'`. dash builds these through
// esbuild/tsc (CJS output); Lane A ran under raw Node ESM (tsx). This copy runs
// under BUN — verified (G1 / design R4) that createRequire loads the CJS
// module.exports (which carries the classes) and SerializeAddon.serialize()
// round-trips correctly under bun, styles preserved, so NO loader change beyond
// the createRequire the salvage already carried. The class bodies are unchanged.
//
// Imported ONLY by pty-session (the single node-pty importer): this is the replay
// path, replacing fresh's 256 KB raw-byte ring.
// ===========================================================================
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { Terminal } = require('@xterm/headless') as typeof import('@xterm/headless');
const { SerializeAddon } = require('@xterm/addon-serialize') as typeof import('@xterm/addon-serialize');

const SCROLLBACK = 1000;

/**
 * Headless xterm mirror of a PTY's output, owned by the server (the VS Code
 * pty-host pattern). The mirror is the single source of truth for "what this
 * terminal looks like" — serialized on every client (re)attach and on kill.
 * Replaces the renderer-side beforeunload/debounce snapshot saves, which raced
 * the reload they were trying to survive.
 */
export class TerminalMirror {
  // Field types use InstanceType<> because Terminal/SerializeAddon now arrive as
  // runtime values via createRequire rather than as merged class type+value
  // imports. Behavior is identical; this is purely a type-position adaptation.
  private term: InstanceType<typeof Terminal>;
  private addon: InstanceType<typeof SerializeAddon>;

  constructor(cols: number, rows: number) {
    this.term = new Terminal({ cols, rows, scrollback: SCROLLBACK, allowProposedApi: true });
    this.addon = new SerializeAddon();
    // SerializeAddon is typed against the renderer Terminal; headless exposes
    // the same surface the addon needs.
    this.term.loadAddon(this.addon as never);
  }

  write(data: string): void {
    this.term.write(data);
  }

  resize(cols: number, rows: number): void {
    this.term.resize(cols, rows);
  }

  /** Flush the async parse queue, then serialize buffer + styles. */
  serialize(): Promise<string> {
    return new Promise((resolve) => {
      this.term.write('', () => resolve(this.addon.serialize()));
    });
  }

  /**
   * Serialize without flushing the parse queue — synchronous, for quit-time
   * persistence where an async flush would race app exit. May miss a chunk
   * still in the parser; acceptable for best-effort persistence.
   */
  serializeNow(): string {
    return this.addon.serialize();
  }

  dims(): { cols: number; rows: number } {
    return { cols: this.term.cols, rows: this.term.rows };
  }

  dispose(): void {
    this.term.dispose();
  }
}
