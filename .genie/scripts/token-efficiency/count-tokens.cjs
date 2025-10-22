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
    rel.startsWith('forge/') ||  // Skip entire forge directory
    rel.includes('/dist/') ||
    rel.includes('/node_modules/') ||
    rel.includes('/.pnpm-store/') ||
    rel.includes('/.pnpm/')
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

function getFileHash(content) {
  // Simple hash: file size + first/last 100 chars
  const len = content.length;
  const sample = content.slice(0, 100) + len + content.slice(-100);
  return Buffer.from(sample).toString('base64').slice(0, 32);
}

function loadCache() {
  try {
    const cachePath = path.join(STATE, 'token-cache.json');
    const cache = JSON.parse(fs.readFileSync(cachePath, 'utf8'));

    // Prune stale entries (files that no longer exist or match skip patterns)
    const validCache = {};
    let prunedCount = 0;

    for (const [relPath, entry] of Object.entries(cache)) {
      // Skip entries that should be excluded
      if (shouldSkip(relPath)) {
        prunedCount++;
        continue;
      }

      // Skip entries for files that no longer exist
      const fullPath = path.join(ROOT, relPath);
      if (!fs.existsSync(fullPath)) {
        prunedCount++;
        continue;
      }

      validCache[relPath] = entry;
    }

    if (prunedCount > 0) {
      console.log(`  🧹 Pruned ${prunedCount} stale cache entries`);
    }

    return validCache;
  } catch {
    return {};
  }
}

function saveCache(cache) {
  try {
    const cachePath = path.join(STATE, 'token-cache.json');
    ensureDir(STATE);
    // Add metadata timestamp for incremental detection
    cache.__meta = { timestamp: Date.now() };
    fs.writeFileSync(cachePath, JSON.stringify(cache, null, 2), 'utf8');
  } catch {}
}

function main() {
  const cache = loadCache();
  const cacheAge = cache.__meta?.timestamp || 0;
  const cacheAgeMinutes = (Date.now() - cacheAge) / 60000;

  // If cache is fresh (<5 min old), trust it entirely without scanning
  if (cacheAge > 0 && cacheAgeMinutes < 5) {
    console.log(`  ⚡ Cache is fresh (${cacheAgeMinutes.toFixed(1)}m old), skipping scan`);

    // Rebuild results from cache
    const results = [];
    let totalTokens = 0;
    let encodingUsed = null;

    for (const [relPath, entry] of Object.entries(cache)) {
      if (relPath === '__meta') continue;
      totalTokens += entry.tokens;
      if (!encodingUsed) encodingUsed = entry.encoding;
      results.push({ path: relPath, tokens: entry.tokens, lines: entry.lines, bytes: entry.bytes, method: entry.method });
    }

    results.sort((a,b)=> b.tokens - a.tokens);
    const meta = {
      generatedAt: new Date().toISOString(),
      encoding: encodingUsed,
      files: results,
      totals: { files: results.length, tokens: totalTokens }
    };

    writeSummary(results, meta);
    return;
  }

  // Cache is stale or missing, do full scan
  console.log(`  🔄 Cache stale (${cacheAgeMinutes.toFixed(1)}m old), scanning...`);
  const files = listMarkdownFiles(ROOT);

  const results = [];
  let totalTokens = 0;
  let encodingUsed = null;
  let cacheHits = 0;

  for (const rel of files) {
    const full = path.join(ROOT, rel);
    let content = '';
    try { content = fs.readFileSync(full, 'utf8'); } catch { continue; }

    const hash = getFileHash(content);
    const cached = cache[rel];

    // Use cached result if hash matches
    if (cached && cached.hash === hash) {
      cacheHits++;
      totalTokens += cached.tokens;
      if (!encodingUsed) encodingUsed = cached.encoding;
      results.push({ path: rel, tokens: cached.tokens, lines: cached.lines, bytes: cached.bytes, method: cached.method });
      continue;
    }

    // Recount this file
    const { tokens, method, encoding } = countTokens(content);
    if (!encodingUsed) encodingUsed = encoding;
    totalTokens += tokens;
    const lines = (content.match(/\n/g) || []).length + 1;
    const bytes = Buffer.byteLength(content, 'utf8');

    results.push({ path: rel, tokens, lines, bytes, method });
    cache[rel] = { hash, tokens, lines, bytes, method, encoding };
  }

  results.sort((a,b)=> b.tokens - a.tokens);
  const meta = {
    generatedAt: new Date().toISOString(),
    encoding: encodingUsed,
    files: results,
    totals: { files: results.length, tokens: totalTokens }
  };

  saveCache(cache);
  writeSummary(results, meta);

  if (cacheHits > 0) {
    console.log(`  ⚡ Cache: ${cacheHits}/${files.length} files unchanged`);
  }
}

try { main(); } catch (e) {
  console.error('❌ Token usage failed:', e?.message || e);
  process.exit(0);
}

