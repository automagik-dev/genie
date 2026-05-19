// Text-import ambient: `import sql from './x.sql' with { type: 'text' }`.
// Bun's `text` loader returns the file contents as a string and embeds it
// into `bun build --compile` output. See scripts/gen-migrations-manifest.ts.
declare module '*.sql' {
  const content: string;
  export default content;
}
