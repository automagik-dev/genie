#!/usr/bin/env node
/**
 * Token Quality Gate
 * Compares current token usage (token-usage.json) with baseline and prints a minimal summary.
 */
const fs = require('fs');
const path = require('path');

const ROOT = process.cwd();
const STATE = path.join(ROOT, '.genie', 'state');
const CURRENT_PATH = path.join(STATE, 'token-usage.json');
const BASELINE_PATH = path.join(STATE, 'token-usage-baseline.json');
const TOP_MD = path.join(STATE, 'token-usage.md');

function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }
function writeJson(p, obj) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(obj, null, 2), 'utf8'); }

function print(lines) { lines.forEach(l => console.log(l)); }

function summarize(current, baseline) {
  if (!current || !current.totals) {
    return ['- Result: ⚠️ Token usage data missing', '- Reinforcer: Ensure count-tokens script runs before commit'];
  }
  const currentTokens = current.totals.tokens;
  if (!baseline || !baseline.totals) {
    writeJson(BASELINE_PATH, current);
    return [
      `- Result: 🧭 Baseline initialized (tokens=${currentTokens})`,
      '- Reinforcer: Keep outputs concise; prefer @ references over duplication'
    ];
  }
  const prevTokens = baseline.totals.tokens;
  const delta = currentTokens - prevTokens;
  const pct = prevTokens ? ((delta / prevTokens) * 100).toFixed(1) : '0.0';
  const statusEmoji = delta > 0 ? '⚠️' : '✅';
  writeJson(BASELINE_PATH, current);
  return [
    `- Result: ${statusEmoji} Token usage ${delta >= 0 ? '+' : ''}${delta} (${delta >= 0 ? '+' : ''}${pct}%)`,
    '- Reinforcer: Split large docs; link via @ to re-use content'
  ];
}

function topGrowth(current, baseline, limit = 3) {
  if (!current || !current.files) return [];
  const prior = new Map();
  if (baseline && baseline.files) baseline.files.forEach(f => prior.set(f.path, f.tokens));
  return current.files
    .map(f => ({ path: f.path, delta: f.tokens - (prior.get(f.path) || 0) }))
    .filter(f => f.delta > 0)
    .sort((a,b)=> b.delta - a.delta)
    .slice(0, limit);
}

function sampleTop(mdPath, limit = 3) {
  try {
    const lines = fs.readFileSync(mdPath, 'utf8').split(/\r?\n/);
    const start = lines.findIndex(l => l.startsWith('## Top'));
    if (start !== -1) {
      const picks = [];
      for (let i = start + 1; i < lines.length && picks.length < limit; i++) {
        const line = lines[i];
        if (line.startsWith('- ')) picks.push(line);
        else if (!line.trim()) break;
      }
      return picks;
    }
  } catch {}
  return [];
}

function main() {
  const current = readJson(CURRENT_PATH);
  const baseline = readJson(BASELINE_PATH);

  console.log('- Notes: Token quality');
  print(summarize(current, baseline));

  const growth = topGrowth(current, baseline);
  if (growth.length) {
    console.log('- Notes: Top growth files');
    growth.forEach(g => console.log(`  - +${g.delta} | ${g.path}`));
  }

  const heavy = sampleTop(TOP_MD);
  if (heavy.length) {
    console.log('- Notes: Current heavy files');
    heavy.forEach(line => console.log(`  ${line}`));
  }

  try { require('child_process').execSync(`git add ${BASELINE_PATH}`, { stdio: 'ignore' }); } catch {}
}

try { main(); } catch (e) {
  console.error('❌ Token quality gate failed:', e?.message || e);
}

