/** @jsxImportSource @opentui/react */
/**
 * Genie boot shell. Mounts the real `<App>` from frame 0 (so it boots
 * underneath while the user watches the animation) and overlays the
 * `<GenieSplash>` on top via `position="absolute"`. When the splash's
 * scene-6 fade-out completes it unmounts itself, revealing the now-ready
 * app.
 *
 *   ┌───────────────────────────────┐         ┌───────────────────────────────┐
 *   │     GenieSplash overlay       │         │    (overlay unmounted)        │
 *   │    (position: absolute,       │   →     │                               │
 *   │     covers whole screen)      │         │     real <App> visible        │
 *   ├───────────────────────────────┤   t→    │                               │
 *   │   real <App> loading silently │         │                               │
 *   │   (keymap, db, tmux scan)     │         │                               │
 *   └───────────────────────────────┘         └───────────────────────────────┘
 *
 * Wire-up recipe for src/tui/render.tsx:
 *
 *   import { GenieAppShell } from './components/GenieAppShell.js';
 *
 *   createRoot(renderer).render(
 *     <KeymapProvider keymap={keymap}>
 *       <GenieAppShell skipSplash={process.env.GENIE_NO_SPLASH === '1'}>
 *         <App rightPane={rightPane} workspaceRoot={workspaceRoot} initialAgent={initialAgent} />
 *       </GenieAppShell>
 *     </KeymapProvider>,
 *   );
 *
 * Notes:
 *   - The splash sits at `zIndex` above the children but renders no input
 *     handler, so global ^C still flows to the renderer (exitOnCtrlC).
 *   - The app is mounted from frame 0 — useEffects fire and async work
 *     starts immediately. By the time the splash dismisses (~2 s) async
 *     boot work is typically done.
 *   - If you need to prevent the app from grabbing focus while the splash
 *     is up, plumb a context or prop down to disable input handlers.
 */

import { type ReactNode, useState } from 'react';
import { GenieSplash } from './GenieSplash.js';

export interface GenieAppShellProps {
  /** The real app — mounted from frame 0; loads behind the splash. */
  children: ReactNode;
  /** Splash duration in ms. Default 2000. */
  splashDuration?: number;
  /** Skip the splash entirely (e.g., when GENIE_NO_SPLASH=1). */
  skipSplash?: boolean;
  /** Optional status text passed through to the splash. */
  status?: string;
}

export function GenieAppShell({ children, splashDuration = 2000, skipSplash = false, status }: GenieAppShellProps) {
  const [showSplash, setShowSplash] = useState(!skipSplash);

  return (
    <box width="100%" height="100%">
      {children}
      {showSplash && (
        <box position="absolute" width="100%" height="100%">
          <GenieSplash duration={splashDuration} status={status} onComplete={() => setShowSplash(false)} />
        </box>
      )}
    </box>
  );
}
