#!/usr/bin/env node
/**
 * Count tokens for all Markdown files and produce reports under .genie/state/.
 */
const fs = require('fs');
const path = require('path');

const ROOT = process.cwd();
const STATE = path.join(ROOT, '.genie', 'state');
const JSON_OUT = path.join(STATE, 'token-usage.json');
const MD_OUT = path.join(STATE, 'token-usage.md');

function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); }
function readDir(p) { try { return fs.readdirSync(p, { withFileTypes: true }); } catch { return []; } }
function isDir(p) { try { return fs.statSync(p).isDirectory(); } catch { return false; } }

function shouldSkip(rel) {
  return (
    rel.startsWith('.git/') ||
    rel.startsWith('node_modules/') ||
    rel.includes('/dist/') ||
    rel.includes('/.pnpm-store/')
  );
}

function listMarkdownFiles(root) {
  const files = [];
  function walk(dir) {
    for (const entry of readDir(dir)) {
      const full = path.join(dir, entry.name);
      const rel = path.relative(root, full).replace(/\\/g, '/');
      if (entry.isDirectory()) {
        if (!shouldSkip(rel + '/')) walk(full);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
        if (!shouldSkip(rel)) files.push(rel);
      }
    }
  }
  walk(root);
  return files.sort((a,b)=>a.localeCompare(b));
}

function countTokens(text) {
  try {
    const { get_encoding } = require('js-tiktoken');
    const encName = process.env.TOKEN_ENCODING || 'cl100k_base';
    const encoder = get_encoding(encName);
    const count = encoder.encode(text).length;
    try { encoder.free && encoder.free(); } catch {}
    return { tokens: count, method: 'tiktoken', encoding: encName };
  } catch {
    const approx = (text || '').trim().split(/\s+/).filter(Boolean).length;
    return { tokens: approx, method: 'approx', encoding: 'approx-words' };
  }
}

function writeSummary(results, meta) {
  ensureDir(STATE);
  fs.writeFileSync(JSON_OUT, JSON.stringify(meta, null, 2), 'utf8');

  const top = parseInt(process.env.TOKEN_TOP || '30', 10);
  const lines = [];
  lines.push('# Token Usage');
  lines.push(`Generated: ${meta.generatedAt} | Encoding: ${meta.encoding}`);
  lines.push(`Total Files: ${meta.totals.files} | Total Tokens: ${meta.totals.tokens}`);
  lines.push('');
  lines.push(`## Top ${Math.min(top, results.length)} Files by Tokens`);
  results.slice(0, top).forEach(r => {
    lines.push(`- ${r.tokens.toString().padStart(6, ' ')} | ${r.path}`);
  });
  lines.push('');
  lines.push('> Tip: Keep large docs lean; use @ references instead of duplicating content.');
  fs.writeFileSync(MD_OUT, lines.join('\n'), 'utf8');

  try { require('child_process').execSync(`git add ${JSON_OUT} ${MD_OUT}`, { stdio: 'ignore' }); } catch {}
  console.log(`- Notes: Token usage updated (${results.length} files)`);
}

function main() {
  const files = listMarkdownFiles(ROOT);
  const results = [];
  let totalTokens = 0;
  let encodingUsed = null;

  for (const rel of files) {
    const full = path.join(ROOT, rel);
    let content = '';
    try { content = fs.readFileSync(full, 'utf8'); } catch { continue; }
    const { tokens, method, encoding } = countTokens(content);
    if (!encodingUsed) encodingUsed = encoding;
    totalTokens += tokens;
    results.push({ path: rel, tokens, lines: (content.match(/\n/g) || []).length + 1, bytes: Buffer.byteLength(content, 'utf8'), method });
  }

  results.sort((a,b)=> b.tokens - a.tokens);
  const meta = {
    generatedAt: new Date().toISOString(),
    encoding: encodingUsed,
    files: results,
    totals: { files: results.length, tokens: totalTokens }
  };

  writeSummary(results, meta);
}

try { main(); } catch (e) {
  console.error('❌ Token usage failed:', e?.message || e);
  process.exit(0);
}

