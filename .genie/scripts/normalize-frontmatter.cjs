#!/usr/bin/env node

/**
 * Normalize agent front matter across all collectives.
 *
 * - Removes legacy genie keys (model, permissionMode, executors, etc.)
 * - Renames executorProfile -> executorVariant
 * - Uppercases executorVariant values for consistency
 * - Drops empty genie blocks
 *
 * Usage:
 *   node .genie/scripts/normalize-frontmatter.js [--dry-run]
 */

const fs = require('fs');
const path = require('path');
const YAML = require('yaml');

const DRY_RUN = process.argv.includes('--dry-run');

const COLLECTIVE_AGENT_DIRS = [
  path.join(process.cwd(), '.genie', 'agents'),
  path.join(process.cwd(), '.genie', 'code', 'agents'),
  path.join(process.cwd(), '.genie', 'create', 'agents')
];

const ALLOWED_GENIE_KEYS = ['executor', 'executorVariant', 'executionMode', 'model', 'background'];
const ORDER = ['executor', 'executorVariant', 'model', 'executionMode', 'background'];

let modifiedCount = 0;
const touchedFiles = [];

function walk(dir, visitor) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.git')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, visitor);
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      visitor(full);
    }
  }
}

function extractFrontMatter(file, content) {
  const lines = content.split(/\n/);
  let start = -1;
  let end = -1;

  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      start = i;
      break;
    }
  }
  if (start === -1) return null;

  for (let j = start + 1; j < lines.length; j++) {
    if (lines[j].trim() === '---') {
      end = j;
      break;
    }
  }
  if (end === -1) return null;

  const block = lines.slice(start + 1, end).join('\n');
  if (!block.trim().includes(':')) return null; // most likely not YAML front matter

  let data;
  try {
    data = YAML.parse(block) || {};
  } catch (err) {
    console.warn(`⚠️  Skipping ${path.relative(process.cwd(), file)}: ${err.message}`);
    return null;
  }

  return { data, lines, start, end };
}

function reorderGenie(genie) {
  const ordered = {};
  for (const key of ORDER) {
    if (Object.prototype.hasOwnProperty.call(genie, key)) {
      ordered[key] = genie[key];
    }
  }
  for (const key of Object.keys(genie)) {
    if (!Object.prototype.hasOwnProperty.call(ordered, key)) {
      ordered[key] = genie[key];
    }
  }
  return ordered;
}

function cleanGenieBlock(genie) {
  let changed = false;
  const cleaned = {};

  for (const [rawKey, value] of Object.entries(genie)) {
    let key = rawKey;
    let val = value;

    if (key === 'executorProfile') {
      key = 'executorVariant';
      changed = true;
    }

    if (!ALLOWED_GENIE_KEYS.includes(key)) {
      changed = true;
      continue;
    }

    if (key === 'executorVariant' && typeof val === 'string') {
      const upper = val.toUpperCase();
      if (upper !== val) changed = true;
      val = upper;
    }

    cleaned[key] = val;
  }

  if (Object.keys(cleaned).length === 0) {
    return { cleaned: null, changed: changed || Object.keys(genie).length > 0 };
  }

  const reordered = reorderGenie(cleaned);
  if (JSON.stringify(reordered) !== JSON.stringify(genie)) changed = true;

  return { cleaned: reordered, changed };
}

for (const dir of COLLECTIVE_AGENT_DIRS) {
  walk(dir, (file) => {
    const content = fs.readFileSync(file, 'utf8');
    const ctx = extractFrontMatter(file, content);
    if (!ctx) return;

    const { data, lines, start, end } = ctx;
    if (!data.genie || typeof data.genie !== 'object') return;

    const { cleaned, changed } = cleanGenieBlock(data.genie);
    if (!changed) return;

    if (cleaned) data.genie = cleaned;
    else delete data.genie;

    let newYaml = YAML.stringify(data, { lineWidth: 0 }).trimEnd();
    if (newYaml.length) newYaml += '\n';

    const before = lines.slice(0, start + 1).join('\n');
    const after = lines.slice(end).join('\n');
    const newContent = `${before}\n${newYaml}${after}`;

    if (!DRY_RUN) {
      fs.writeFileSync(file, newContent.endsWith('\n') ? newContent : `${newContent}\n`, 'utf8');
    }

    modifiedCount += 1;
    touchedFiles.push(path.relative(process.cwd(), file));
  });
}

if (modifiedCount === 0) {
  console.log('✅ Front matter already normalized.');
} else {
  const mode = DRY_RUN ? '[dry-run]' : '[updated]';
  console.log(`${mode} normalized genie block in ${modifiedCount} file(s).`);
  if (touchedFiles.length) {
    console.log('');
    touchedFiles.forEach((f) => console.log(`- ${f}`));
  }
}
