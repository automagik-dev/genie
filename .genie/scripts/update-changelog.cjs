#!/usr/bin/env node

/**
 * CHANGELOG Manager (Node port)
 *
 * Modes:
 * - rc <version>: move [Unreleased] entries into a new version section
 * - stable <version>: promote RC section to stable version
 * - default: ensure [Unreleased] section exists (generate from commits if missing)
 */

const fs = require('fs');
const path = require('path');
const { execSync, spawnSync } = require('child_process');

const ACTION = process.argv[2]; // rc|stable|undefined
const VERSION = process.argv[3];
const REPO_ROOT = path.join(__dirname, '..', '..');
const CHANGELOG_PATH = path.join(REPO_ROOT, 'CHANGELOG.md');

function log(color, emoji, message) {
  const colors = {
    reset: '\x1b[0m', red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', blue: '\x1b[34m'
  };
  console.log(`${colors[color] || ''}${emoji} ${message}${colors.reset}`);
}

function todayISO() {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
    .toISOString().slice(0, 10);
}

function readLines(filePath) {
  const text = fs.readFileSync(filePath, 'utf8');
  return text.split(/\r?\n/);
}

function writeLines(filePath, lines) {
  let content = lines.join('\n');
  if (!content.endsWith('\n')) content += '\n';
  fs.writeFileSync(filePath, content, 'utf8');
}

function indexOfNextVersionHeader(lines, startIdx) {
  for (let i = startIdx; i < lines.length; i++) {
    if (lines[i].startsWith('## [')) return i;
  }
  return -1;
}

function ensureChangelogFile() {
  if (!fs.existsSync(CHANGELOG_PATH)) {
    throw new Error(`CHANGELOG not found at ${CHANGELOG_PATH}`);
  }
}

function stageChangelog() {
  try {
    execSync(`git add ${JSON.stringify(CHANGELOG_PATH)}`);
  } catch {}
}

// Default mode: generate [Unreleased] section if missing
function getLastTag() {
  try {
    return execSync('git describe --tags --abbrev=0', { encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

function getCommitsSince(tag) {
  try {
    const range = tag ? `${tag}..HEAD` : 'HEAD';
    const out = execSync(`git log ${range} --oneline --no-merges`, { encoding: 'utf8' }).trim();
    return out ? out.split('\n') : [];
  } catch {
    return [];
  }
}

function parseCommitLine(line) {
  // abcd123 feat: message
  const m = line.match(/^([a-f0-9]+)\s+(.+)$/);
  if (!m) return null;
  const hash = m[1];
  const msg = m[2];
  const t = msg.match(/^(feat|fix|refactor|docs|chore|test|perf):\s+(.+)$/);
  if (t) return { hash, type: t[1], message: t[2] };
  return { hash, type: 'other', message: msg };
}

function generateUnreleasedSection(commits) {
  const groups = { feat: [], fix: [], refactor: [], docs: [], test: [], perf: [], chore: [], other: [] };
  commits.forEach((line) => {
    const p = parseCommitLine(line);
    if (!p) return;
    groups[p.type] = groups[p.type] || [];
    groups[p.type].push(p);
  });

  const typeHeaders = {
    feat: '### Features',
    fix: '### Fixes',
    refactor: '### Refactor',
    docs: '### Documentation',
    test: '### Tests',
    perf: '### Performance',
    chore: '### Chore',
    other: '### Other',
  };

  const lines = ['## [Unreleased]', ''];
  for (const key of ['feat', 'fix', 'refactor', 'docs', 'test', 'perf', 'chore', 'other']) {
    const items = groups[key];
    if (!items || items.length === 0) continue;
    lines.push(typeHeaders[key]);
    items.forEach((c) => lines.push(`- ${c.message} (${c.hash})`));
    lines.push('');
  }
  return lines.join('\n');
}

function ensureUnreleased() {
  ensureChangelogFile();
  const existing = fs.readFileSync(CHANGELOG_PATH, 'utf8');
  if (existing.includes('[Unreleased]')) {
    console.log('⚠️  [Unreleased] section already exists in CHANGELOG.md');
    console.log('   Skipping CHANGELOG update (already up to date)');
    return 0;
  }
  const last = getLastTag();
  if (last) console.log(`   Last tag: ${last}`);
  const commits = getCommitsSince(last);
  if (commits.length === 0) {
    console.log('   No new commits since last tag');
    console.log('✅ CHANGELOG up to date');
    return 0;
  }
  console.log(`   Found ${commits.length} commits`);
  const newSection = generateUnreleasedSection(commits);

  // Insert after header (first blank line after first line)
  let headerEnd = existing.indexOf('\n\n');
  if (headerEnd === -1) headerEnd = existing.length;
  const updated = existing.slice(0, headerEnd + 2) + newSection + '\n' + existing.slice(headerEnd + 2);
  fs.writeFileSync(CHANGELOG_PATH, updated, 'utf8');
  stageChangelog();
  console.log('✅ CHANGELOG updated and staged');
  return 0;
}

function prepareRC(version) {
  ensureChangelogFile();
  const lines = readLines(CHANGELOG_PATH);
  const unreleasedIdx = lines.findIndex((l) => l.trim() === '## [Unreleased]');
  if (unreleasedIdx === -1) {
    console.error('❌ Missing "## [Unreleased]" section. Aborting.');
    return 1;
  }
  const contentStart = unreleasedIdx + 1;
  const macroIdx = lines.findIndex((l, i) => i >= contentStart && (l.startsWith('**Current Version:**') || l.startsWith('**Generated:**')));
  let contentEnd = indexOfNextVersionHeader(lines, contentStart);
  if (macroIdx !== -1) contentEnd = macroIdx;
  if (contentEnd === -1) contentEnd = lines.length;

  const extracted = lines.slice(contentStart, contentEnd).filter((l) => {
    if (!l.trim()) return false;
    if (l.startsWith('All notable changes')) return false;
    if (l.trim() === '---') return false;
    return true;
  });
  const movedCount = extracted.length;

  const keepHead = lines.slice(0, contentStart);
  const keepTail = lines.slice(contentEnd);
  const beforeInsert = keepHead.concat(keepTail);
  const insertAt = beforeInsert.findIndex((l, i) => i > unreleasedIdx && l.startsWith('## ['));
  if (insertAt === -1) {
    console.error('❌ Could not find first version section to anchor insertion.');
    return 1;
  }

  const header = `## [${version}] - ${todayISO()}`;
  const section = [header, ''];
  if (movedCount > 0) section.push(...extracted); else section.push('No changelog entries (packaging-only RC).');
  section.push('');

  const updated = beforeInsert.slice(0, insertAt).concat(section).concat(beforeInsert.slice(insertAt));
  writeLines(CHANGELOG_PATH, updated);
  stageChangelog();
  log('green', '✅', `CHANGELOG updated for RC ${version} (moved ${movedCount} lines)`);
  return 0;
}

function promoteStable(version) {
  ensureChangelogFile();
  const lines = readLines(CHANGELOG_PATH);
  const base = version;
  let rcIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('## [') && lines[i].includes(`${base}-rc.`)) { rcIdx = i; break; }
  }
  if (rcIdx !== -1) {
    lines[rcIdx] = `## [${base}] - ${todayISO()}`;
    writeLines(CHANGELOG_PATH, lines);
    stageChangelog();
    log('green', '✅', `Promoted RC section to stable ${base}`);
    return 0;
  }
  // Insert minimal section near top (after '---' if present, else before first version)
  const sepIdx = lines.findIndex((l) => l.trim() === '---');
  const firstVerIdx = indexOfNextVersionHeader(lines, 0);
  const anchor = sepIdx !== -1 ? sepIdx + 1 : (firstVerIdx !== -1 ? firstVerIdx : lines.length);
  const header = `## [${base}] - ${todayISO()}`;
  const section = [header, '', 'No changes since last RC.', ''];
  const updated = lines.slice(0, anchor).concat(section).concat(lines.slice(anchor));
  writeLines(CHANGELOG_PATH, updated);
  stageChangelog();
  log('green', '✅', `Inserted stable section ${base}`);
  return 0;
}

function main() {
  if (ACTION === 'rc') {
    if (!VERSION) {
      console.error('Usage: update-changelog.js rc <version>');
      process.exit(1);
    }
    process.exit(prepareRC(VERSION));
  }

  if (ACTION === 'stable') {
    if (!VERSION) {
      console.error('Usage: update-changelog.js stable <version>');
      process.exit(1);
    }
    process.exit(promoteStable(VERSION));
  }

  // default: ensure [Unreleased]
  process.exit(ensureUnreleased());
}

main();

