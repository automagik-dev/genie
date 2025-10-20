#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const ROOT = process.cwd();
const GENIE = path.join(ROOT, '.genie');
const STATE = path.join(GENIE, 'state');
const OUTPUT_SUMMARY = path.join(STATE, 'workspace-summary.md');
const OUTPUT_AGENTS = path.join(STATE, 'agents-index.md');
const OUTPUT_WORKFLOWS = path.join(STATE, 'workflows-index.md');
const OUTPUT_SKILLS = path.join(STATE, 'skills-index.md');

function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); }
function readDir(p) { try { return fs.readdirSync(p, { withFileTypes: true }); } catch { return []; } }
function isDir(p) { try { return fs.statSync(p).isDirectory(); } catch { return false; } }
function isFile(p) { try { return fs.statSync(p).isFile(); } catch { return false; } }

function listMarkdown(dir) {
  if (!isDir(dir)) return [];
  return readDir(dir)
    .filter(e => e.isFile() && e.name.toLowerCase().endsWith('.md'))
    .map(e => e.name)
    .sort((a,b)=>a.localeCompare(b));
}

function listMarkdownRecursive(dir) {
  const out = [];
  function walk(d) {
    for (const e of readDir(d)) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && e.name.toLowerCase().endsWith('.md')) out.push(p);
    }
  }
  if (isDir(dir)) walk(dir);
  return out.sort((a,b)=>a.localeCompare(b));
}

function discoverCollectives() {
  return readDir(GENIE)
    .filter(e => e.isDirectory() && !e.name.startsWith('.'))
    .map(e => ({ name: e.name, root: path.join(GENIE, e.name), hasMarker: isFile(path.join(GENIE, e.name, 'AGENTS.md')) }))
    .filter(x => x.hasMarker)
    .sort((a,b)=>a.name.localeCompare(b.name));
}

function descFromFrontMatter(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    if (!content.startsWith('---')) return '';
    const end = content.indexOf('\n---', 3);
    if (end === -1) return '';
    const fm = content.slice(4, end).split(/\r?\n/);
    for (const line of fm) {
      const m = line.match(/^\s*description:\s*(.*)$/);
      if (m) return m[1].trim();
    }
  } catch {}
  return '';
}

function toRel(p) { return path.relative(GENIE, p).replace(/\\/g, '/'); }

function renderTree(paths, base) {
  // paths: array of relative paths (posix)
  const root = {};
  for (const rel of paths) {
    const parts = rel.split('/');
    let cur = root;
    for (let i=0;i<parts.length;i++) {
      const part = parts[i];
      if (!cur[part]) cur[part] = {};
      cur = cur[part];
    }
  }
  const lines = [];
  function walk(node, prefix='', isLast=true) {
    const keys = Object.keys(node).sort((a,b)=>a.localeCompare(b));
    keys.forEach((key, idx)=>{
      const last = idx === keys.length-1;
      const connector = isLast ? '└── ' : '├── ';
      lines.push(`${prefix}${connector}${key}`);
      const child = node[key];
      const nextPrefix = prefix + (isLast ? '    ' : '│   ');
      if (Object.keys(child).length) walk(child, nextPrefix, last);
    });
  }
  walk(root, '', true);
  return lines.join('\n');
}

function listMdWithDesc(dir) {
  const files = listMarkdownRecursive(dir);
  return files.map(fp => {
    const desc = descFromFrontMatter(fp);
    return { rel: toRel(fp), desc };
  });
}

function writeFile(p, content) {
  ensureDir(path.dirname(p));
  fs.writeFileSync(p, content, 'utf8');
  try { require('child_process').execSync(`git add ${p}`, { stdio: 'ignore' }); } catch {}
}

function main() {
  const now = new Date().toISOString();

  // Agents (core)
  // Core agents: prefer repo root 'agents/' if present, else fallback to '.genie/agents/'
  const coreRootDir = path.join(ROOT, 'agents');
  const coreGenieDir = path.join(GENIE, 'agents');
  const coreAgentsDir = isDir(coreRootDir) ? coreRootDir : coreGenieDir;
  const coreAgents = listMarkdown(coreAgentsDir);
  const agentsList = coreAgents.map(name => {
    const fp = path.join(coreAgentsDir, name);
    const desc = descFromFrontMatter(fp);
    return `- ${name.replace(/\.md$/, '')}${desc ? ` — ${desc}` : ''}`;
  }).join('\n') || '_None_';

  // Global workflows & skills
  const gw = listMarkdownRecursive(path.join(GENIE, 'workflows')).map(toRel);
  const gs = listMarkdown(path.join(GENIE, 'skills')).map(s=>`skills/${s}`);

  // Collectives
  const collectives = discoverCollectives();
  const lines = [];
  lines.push('# Workspace Summary');
  lines.push('');
  lines.push(`Generated: ${now}`);
  lines.push('');
  lines.push(`## Master Genie (Core Agents) (${coreAgents.length})`);
  lines.push(agentsList);
  lines.push('');
  lines.push(`## Global Workflows (tree, ${gw.length})`);
  lines.push(gw.length ? renderTree(gw, GENIE) : '_None_');
  lines.push('');
  lines.push(`## Global Skills (${gs.length})`);
  lines.push(gs.length ? gs.map(s=>`- ${s}`).join('\n') : '_None_');
  lines.push('');
  lines.push('## Collectives');
  for (const col of collectives) {
    lines.push(`### ${col.name}`);
    const agents = listMarkdownRecursive(path.join(col.root, 'agents')).map(p=>toRel(p));
    const workflows = listMarkdownRecursive(path.join(col.root, 'workflows')).map(p=>toRel(p));
    const skills = listMarkdown(path.join(col.root, 'skills')).map(s=>`${col.name}/skills/${s}`);
    lines.push(`- Agents (tree, ${agents.length})`);
    lines.push(agents.length ? renderTree(agents, col.root) : '  _None_');
    lines.push(`- Workflows (tree, ${workflows.length})`);
    lines.push(workflows.length ? renderTree(workflows, col.root) : '  _None_');
    lines.push(`- Skills (${skills.length})`);
    lines.push(skills.length ? skills.map(s=>`  - ${s}`).join('\n') : '  _None_');
    lines.push('');
  }
  writeFile(OUTPUT_SUMMARY, lines.join('\n'));

  // Separate indices
  const agentsIndexLines = ['# Agents Index', `Generated: ${now}`, ''];
  agentsIndexLines.push(`## Core (${coreAgents.length})`);
  agentsIndexLines.push(agentsList || '_None_');
  agentsIndexLines.push('');
  // Per-collective agent descriptions (flat list)
  for (const col of collectives) {
    const md = listMdWithDesc(path.join(col.root, 'agents'));
    agentsIndexLines.push(`## ${col.name} (${md.length})`);
    if (md.length) {
      agentsIndexLines.push(...md.map(x => `- ${x.rel.replace(/\.md$/,'')}${x.desc ? ' — ' + x.desc : ''}`));
    } else {
      agentsIndexLines.push('_None_');
    }
    agentsIndexLines.push('');
  }
  const agentsIndex = agentsIndexLines.join('\n');
  writeFile(OUTPUT_AGENTS, agentsIndex);
  const workflowsIndex = ['# Workflows Index', `Generated: ${now}`, '', `## Global (${gw.length})`, gw.length ? renderTree(gw, GENIE) : '_None_', ''].join('\n');
  writeFile(OUTPUT_WORKFLOWS, workflowsIndex);
  const skillsIndex = ['# Skills Index', `Generated: ${now}`, '', `## Global (${gs.length})`, gs.length ? gs.map(s=>`- ${s}`).join('\n') : '_None_', ''].join('\n');
  writeFile(OUTPUT_SKILLS, skillsIndex);

  console.log(`✅ Workspace summary and indices updated.`);
}

try { main(); } catch (e) {
  console.error('❌ Summary generation failed:', e?.message || e);
  process.exit(1);
}
