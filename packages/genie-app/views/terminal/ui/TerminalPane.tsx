import { useEffect, useRef } from 'react';
import { invoke, onEvent } from '../../../lib/ipc';

// ============================================================================
// Types
// ============================================================================

interface TerminalPaneProps {
  sessionId: string;
  active: boolean;
}

// ============================================================================
// Theme
// ============================================================================

const t = {
  bg: '#1a1028',
  text: '#e2e8f0',
  textMuted: '#64748b',
} as const;

// ============================================================================
// TerminalPane — Renders a single terminal session
//
// Uses a simple <pre> buffer for output. xterm.js can be layered in later
// via the same lifecycle hooks (mount → subscribe → write → unmount).
// ============================================================================

export function TerminalPane({ sessionId, active }: TerminalPaneProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const bufferRef = useRef<string[]>([]);
  const preRef = useRef<HTMLPreElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Subscribe to PTY data
  useEffect(() => {
    const unsub = onEvent('pty-data', (payload) => {
      if (payload.sessionId !== sessionId) return;
      const text = payload.data as string;
      bufferRef.current.push(text);
      // Limit buffer to last 5000 lines
      if (bufferRef.current.length > 5000) {
        bufferRef.current = bufferRef.current.slice(-4000);
      }
      if (preRef.current) {
        preRef.current.textContent = bufferRef.current.join('');
        preRef.current.scrollTop = preRef.current.scrollHeight;
      }
    });

    return unsub;
  }, [sessionId]);

  // Focus input when tab becomes active
  useEffect(() => {
    if (active && inputRef.current) {
      inputRef.current.focus();
    }
  }, [active]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      const value = inputRef.current?.value ?? '';
      invoke('write_terminal', { sessionId, data: `${value}\n` });
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  return (
    <div
      ref={containerRef}
      style={{
        display: active ? 'flex' : 'none',
        flexDirection: 'column',
        height: '100%',
        backgroundColor: t.bg,
        fontFamily: "'JetBrains Mono', 'Fira Code', 'SF Mono', monospace",
      }}
    >
      <pre
        ref={preRef}
        style={{
          flex: 1,
          margin: 0,
          padding: '12px',
          overflow: 'auto',
          color: t.text,
          fontSize: '13px',
          lineHeight: 1.5,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-all',
        }}
      />
      <div
        style={{
          padding: '8px 12px',
          borderTop: '1px solid #414868',
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
        }}
      >
        <span style={{ color: t.textMuted, fontSize: '13px' }}>$</span>
        <input
          ref={inputRef}
          type="text"
          style={{
            flex: 1,
            background: 'none',
            border: 'none',
            outline: 'none',
            color: t.text,
            fontSize: '13px',
            fontFamily: 'inherit',
          }}
          onKeyDown={handleKeyDown}
          placeholder="Type command..."
        />
      </div>
    </div>
  );
}
