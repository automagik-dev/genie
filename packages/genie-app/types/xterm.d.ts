/**
 * Ambient type declarations for @xterm/* packages.
 *
 * These packages are declared as dependencies in package.json and will be
 * resolved once installed. Until then, these declarations provide compile-time
 * types for the terminal view.
 */

declare module '@xterm/xterm' {
  export interface ITerminalOptions {
    cursorBlink?: boolean;
    fontSize?: number;
    fontFamily?: string;
    theme?: ITheme;
    allowProposedApi?: boolean;
  }

  export interface ITheme {
    background?: string;
    foreground?: string;
    cursor?: string;
    selectionBackground?: string;
  }

  export interface ITerminalAddon {
    dispose(): void;
  }

  export class Terminal {
    constructor(options?: ITerminalOptions);
    loadAddon(addon: ITerminalAddon): void;
    open(container: HTMLElement): void;
    write(data: string | Uint8Array): void;
    focus(): void;
    dispose(): void;
    onData(handler: (data: string) => void): { dispose(): void };
    onResize(handler: (size: { cols: number; rows: number }) => void): { dispose(): void };
  }
}

declare module '@xterm/addon-webgl' {
  import type { ITerminalAddon } from '@xterm/xterm';

  export class WebglAddon implements ITerminalAddon {
    constructor();
    onContextLoss(handler: () => void): void;
    dispose(): void;
  }
}

declare module '@xterm/addon-fit' {
  import type { ITerminalAddon } from '@xterm/xterm';

  export class FitAddon implements ITerminalAddon {
    constructor();
    fit(): void;
    dispose(): void;
  }
}
