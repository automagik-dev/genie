/** @jsxImportSource @opentui/react */

import { useActiveKeys } from '@opentui/keymap/react';
import { useTimeline } from '@opentui/react';
import { useEffect, useState } from 'react';
import { palette } from '../theme.js';

interface HelpOverlayProps {
  onClose: () => void;
}

export function HelpOverlay(_: HelpOverlayProps) {
  const activeKeys = useActiveKeys({ includeMetadata: true });

  // Slide-in animation: paddingY ramps from 0 → 1 over 180ms when the
  // overlay mounts. Pure visual polish; the binding list is fully usable
  // throughout the animation. Uses the OpenTUI Timeline engine instead of
  // setInterval so the renderer drives it via requestLive().
  const [paddingY, setPaddingY] = useState(0);
  const timeline = useTimeline({ duration: 180, autoplay: true });
  useEffect(() => {
    const target = { paddingY: 0 };
    timeline.add(target, {
      paddingY: 1,
      duration: 180,
      ease: 'linear',
      onUpdate: (animation) => {
        const next = animation.targets[0]?.paddingY;
        if (typeof next === 'number') setPaddingY(next);
      },
    });
  }, [timeline]);

  const rows = activeKeys
    .map((entry) => {
      const stroke = entry.display ?? entry.tokenName ?? '';
      const attrs = (entry.commandAttrs ?? entry.bindingAttrs ?? {}) as Record<string, unknown>;
      const title = pickString(attrs.title) ?? pickString(attrs.desc) ?? formatCommand(entry.command) ?? '';
      const group = pickString(attrs.category) ?? pickString(attrs.namespace) ?? '';
      return { stroke, title, group };
    })
    .filter((r) => r.stroke.length > 0)
    .sort((a, b) => a.group.localeCompare(b.group) || a.stroke.localeCompare(b.stroke));

  return (
    <box
      position="absolute"
      width="100%"
      height="100%"
      justifyContent="center"
      alignItems="center"
      backgroundColor={palette.bgOverlay}
    >
      <box
        border
        borderStyle="rounded"
        borderColor={palette.borderActive}
        backgroundColor={palette.bgRaised}
        flexDirection="column"
        paddingX={2}
        paddingY={paddingY}
        gap={1}
      >
        <text>
          <span fg={palette.accent}>Keyboard shortcuts</span>
          <span fg={palette.textDim}> — press F1 again to close</span>
        </text>
        {rows.length === 0 ? (
          <text>
            <span fg={palette.textDim}>No active bindings.</span>
          </text>
        ) : (
          <box flexDirection="column">
            {rows.map((r) => (
              <text key={`${r.group}:${r.stroke}`}>
                <span fg={palette.accentBright}>{r.stroke.padEnd(14, ' ')}</span>
                <span fg={palette.text}>{r.title}</span>
                {r.group ? <span fg={palette.textMuted}>{`  (${r.group})`}</span> : null}
              </text>
            ))}
          </box>
        )}
        <text>
          <span fg={palette.textMuted}>Bindings update live as focus changes.</span>
        </text>
      </box>
    </box>
  );
}

function pickString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function formatCommand(cmd: unknown): string | undefined {
  if (typeof cmd === 'string') return cmd;
  if (cmd && typeof cmd === 'object' && 'name' in cmd) {
    const name = (cmd as { name?: unknown }).name;
    return typeof name === 'string' ? name : undefined;
  }
  return undefined;
}
