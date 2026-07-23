# K dot-matrix loader — vendored reference (visual-only port source)

Vendored 2026-07-23 from the old KhalOS desktop app (`https://git.namastex.io/khal/desktop`,
`src/desktop/main.tsx:131-202` + `src/desktop/index.css:58-105`) so group-5 of the
`khal-native-theme` wish has a durable source — the session clone was ephemeral.
Port the VISUAL matrix + CSS only; the source's `useRetryStore`/`/auth/reset` wiring is
explicitly OUT (design decision #6). Felipe verbatim: "I absolutely LOVE the loading K
made of dots."

## The matrix (13 rows × 14 columns; 1 = lit/pulse, 0 = off/transparent)

```ts
const K_MATRIX = [
  [1,1,0,0,0,0,0,0,0,0,1,1,1,0],
  [1,1,0,0,0,0,0,0,0,1,1,1,0,0],
  [1,1,0,0,0,0,0,0,1,1,1,0,0,0],
  [1,1,0,0,0,0,0,0,1,1,0,0,0,0],
  [1,1,0,0,0,0,0,1,1,1,0,0,0,0],
  [1,1,0,0,0,0,1,1,1,0,0,0,0,0],
  [1,1,1,1,1,1,1,1,0,0,0,0,0,0],
  [1,1,1,1,1,1,1,1,1,0,0,0,0,0],
  [1,1,0,0,0,0,0,1,1,1,0,0,0,0],
  [1,1,0,0,0,0,0,0,1,1,1,0,0,0],
  [1,1,0,0,0,0,0,0,0,1,1,1,0,0],
  [1,1,0,0,0,0,0,0,0,0,1,1,1,0],
  [1,1,0,0,0,0,0,0,0,0,1,1,1,1],
];
```

## Render pattern (JSX, from `ConnectingScreen`)

```tsx
<div className="connecting-dot-matrix">
  {K_MATRIX.flat().map((lit, i) => (
    <div
      key={i}
      className={lit ? 'connecting-dot pulse' : 'connecting-dot off'}
      style={lit ? { animationDelay: `${Math.floor(i / 14) * 0.07}s` } : undefined}
    />
  ))}
</div>
```

Row-staggered pulse: every dot in row `r` starts its pulse at `r * 0.07s`.

## CSS (verbatim source; adapt colors to KHAL bridge tokens at port time)

```css
.connecting-screen {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100vh;
  width: 100vw;
  background: #0d0d14;        /* → var(--khal-bg) equivalent at port time */
  color: #888;
  gap: 32px;
}

.connecting-status {
  text-align: center;
  font-family: "SF Mono", "Fira Code", "Cascadia Code", "Consolas", monospace; /* → Geist Mono */
  font-size: 13px;
  color: #8B92A5;
  letter-spacing: 0.5px;
}

.connecting-dot-matrix {
  display: grid;
  grid-template-columns: repeat(14, 7px);
  grid-template-rows: repeat(13, 7px);
  gap: 5px;
}

.connecting-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: #1E2330;
  transition: background 0.4s ease-out, box-shadow 0.4s ease-out;
}

.connecting-dot.off {
  background: transparent;
  animation: none;
}

.connecting-dot.pulse {
  animation: connecting-dot-pulse 1.6s ease-in-out infinite;
}

@keyframes connecting-dot-pulse {
  0%, 100% { background: #1E2330; box-shadow: none; }
  50% { background: oklch(0.74 0.11 65); box-shadow: 0 0 8px oklch(0.74 0.11 65 / 0.2); }
}
```

Note the pulse peak is already KHAL copper (`oklch(0.74 0.11 65)` ≈ the `--khal-accent`
copper `oklch(71.49% 0.1112 63.09)`); align exactly to the imported `--khal-accent` token
at port time. Dot base `#1E2330` maps to a KHAL surface token. Loader CSS should live in
its own file (or the component), NOT in `index.css`, to keep group-5 conflict-free with
groups 3/4.
