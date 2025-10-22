#!/usr/bin/env node
/**
 * Generate workspace summary and indices for agents, workflows, and skills.
 */
const fs = require('fs');
const path = require('path');

const ROOT = process.cwd();
const STATE = path.join(ROOT, '.genie', 'state');
const SUMMARY = path.join(STATE, 'workspace-summary.md');
const AGENTS_IDX = path.join(STATE, 'agents-index.md');
const WORKFLOWS_IDX = path.join(STATE, 'workflows-index.md');
const SKILLS_IDX = path.join(STATE, 'skills-index.md');

function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); }
function readDir(p) { try { return fs.readdirSync(p, { withFileTypes: true }); } catch { return []; } }

function listMarkdown(dir) {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return [];
  return readDir(dir)
    .filter(e => e.isFile() && e.name.endsWith('.md'))
    .map(e => e.name)
    .sort((a,b)=>a.localeCompare(b));
}

function listMarkdownRecursive(dir) {
  const out = [];
  function walk(d) {
    for (const entry of readDir(d)) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith('.md')) out.push(full);
    }
  }
  if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) walk(dir);
  return out.sort((a,b)=>a.localeCompare(b));
}

function descFromFrontMatter(filePath) {
  try {
    const text = fs.readFileSync(filePath, 'utf8');
    if (!text.startsWith('---')) return '';
    const end = text.indexOf('\n---', 3);
    if (end === -1) return '';
    const block = text.slice(4, end).split(/\r?\n/);
    for (const line of block) {
      const m = line.match(/^\s*description:\s*(.*)$/);
      if (m) return m[1].trim();
    }
  } catch {}
  return '';
}

function discoverCollectives() {
  return readDir(ROOT)
    .filter(e => e.isDirectory() && !e.name.startsWith('.'))
    .map(e => ({ name: e.name, root: path.join(ROOT, e.name), hasMarker: fs.existsSync(path.join(ROOT, e.name, 'AGENTS.md')) }))
    .filter(info => info.hasMarker)
    .sort((a,b)=>a.name.localeCompare(b.name));
}

function renderTree(paths, base) {
  const tree = {};
  for (const rel of paths) {
    const parts = rel.split('/');
    let current = tree;
    parts.forEach((part, idx) => {
      const last = idx === parts.length - 1;
      if (!current[part]) current[part] = {};
      current = current[part];
      if (last) current.__leaf = true;
    });
  }

  const lines = [];
  function walk(node, prefix = '', isLast = true) {
    const keys = Object.keys(node).filter(k => k !== '__leaf').sort((a,b)=>a.localeCompare(b));
    keys.forEach((key, idx) => {
      const last = idx === keys.length - 1;
      const connector = isLast ? '└── ' : '├── ';
      lines.push(`${prefix}${connector}${key}`);
      const nextPrefix = prefix + (isLast ? '    ' : '│   ');
      walk(node[key], nextPrefix, last);
    });
  }
  walk(tree, '', true);
  return lines.join('\n');
}

function main() {
  const generatedAt = new Date().toISOString();
  ensureDir(STATE);

  const coreAgentsDir = path.join(ROOT, 'agents');
  const coreAgents = listMarkdown(coreAgentsDir);
  const coreLines = coreAgents.length
    ? coreAgents.map(name => {
        const desc = descFromFrontMatter(path.join(coreAgentsDir, name));
        return `- ${name.replace(/\.md$/, '')}${desc ? ` — ${desc}` : ''}`;
      })
    : ['_None_'];

  const globalWorkflowsDir = path.join(ROOT, 'workflows');
  const globalWorkflows = listMarkdownRecursive(globalWorkflowsDir)
    .map(p => path.relative(ROOT, p).replace(/\\/g, '/'));
  const globalSkills = listMarkdown(path.join(ROOT, 'skills')).map(name => `skills/${name}`);

  const collectives = discoverCollectives();

  // Workspace summary
  const summary = [];
  summary.push('# Workspace Summary');
  summary.push(`Generated: ${generatedAt}`);
  summary.push('');
  summary.push(`## Master Genie (Core Agents) (${coreAgents.length})`);
  summary.push(...coreLines);
  summary.push('');
  summary.push(`## Global Workflows (tree, ${globalWorkflows.length})`);
  summary.push(globalWorkflows.length ? renderTree(globalWorkflows, ROOT) : '_None_');
  summary.push('');
  summary.push(`## Global Skills (${globalSkills.length})`);
  summary.push(globalSkills.length ? globalSkills.map(s => `- ${s}`).join('\n') : '_None_');
  summary.push('');
  summary.push('## Collectives');
  collectives.forEach(info => {
    summary.push(`### ${info.name}`);
    const agents = listMarkdownRecursive(path.join(info.root, 'agents')).map(p => path.relative(ROOT, p).replace(/\\/g,'/'));
    const workflows = listMarkdownRecursive(path.join(info.root, 'workflows')).map(p => path.relative(ROOT, p).replace(/\\/g,'/'));
    const skills = listMarkdown(path.join(info.root, 'skills')).map(name => `${info.name}/skills/${name}`);
    summary.push(`- Agents (tree, ${agents.length})`);
    summary.push(agents.length ? renderTree(agents, ROOT) : '  _None_');
    summary.push(`- Workflows (tree, ${workflows.length})`);
    summary.push(workflows.length ? renderTree(workflows, ROOT) : '  _None_');
    summary.push(`- Skills (${skills.length})`);
    summary.push(skills.length ? skills.map(s => `  - ${s}`).join('\n') : '  _None_');
    summary.push('');
  });
  fs.writeFileSync(SUMMARY, summary.join('\n'), 'utf8');

  // Agents index with descriptions
  const agentsIndex = [];
  agentsIndex.push('# Agents Index');
  agentsIndex.push(`Generated: ${generatedAt}`);
  agentsIndex.push('');
  agentsIndex.push(`## Core (${coreAgents.length})`);
  agentsIndex.push(...coreLines);
  agentsIndex.push('');
  collectives.forEach(info => {
    const md = listMarkdownRecursive(path.join(info.root, 'agents'))
      .map(p => {
        const rel = path.relative(ROOT, p).replace(/\\/g,'/');
        const desc = descFromFrontMatter(p);
        return `- ${rel}${desc ? ` — ${desc}` : ''}`;
      });
    agentsIndex.push(`## ${info.name} (${md.length})`);
    agentsIndex.push(md.length ? md.join('\n') : '_None_');
    agentsIndex.push('');
  });
  fs.writeFileSync(AGENTS_IDX, agentsIndex.join('\n'), 'utf8');

  // Workflows index
  const workflowsIdx = [];
  workflowsIdx.push('# Workflows Index');
  workflowsIdx.push(`Generated: ${generatedAt}`);
  workflowsIdx.push('');
  workflowsIdx.push(`## Global (${globalWorkflows.length})`);
  workflowsIdx.push(globalWorkflows.length ? renderTree(globalWorkflows, ROOT) : '_None_');
  workflowsIdx.push('');
  collectives.forEach(info => {
    const wf = listMarkdownRecursive(path.join(info.root, 'workflows')).map(p => path.relative(ROOT, p).replace(/\\/g,'/'));
    workflowsIdx.push(`## ${info.name} (${wf.length})`);
    workflowsIdx.push(wf.length ? renderTree(wf, ROOT) : '_None_');
    workflowsIdx.push('');
  });
  fs.writeFileSync(WORKFLOWS_IDX, workflowsIdx.join('\n'), 'utf8');

  // Skills index
  const skillsIdx = [];
  skillsIdx.push('# Skills Index');
  skillsIdx.push(`Generated: ${generatedAt}`);
  skillsIdx.push('');
  skillsIdx.push(`## Global (${listMarkdown(path.join(ROOT,'skills')).length})`);
  skillsIdx.push(globalSkills.length ? globalSkills.map(s => `- ${s}`).join('\n') : '_None_');
  skillsIdx.push('');
  collectives.forEach(info => {
    const sk = listMarkdown(path.join(info.root, 'skills')).map(name => `${info.name}/skills/${name}`);
    skillsIdx.push(`## ${info.name} (${sk.length})`);
    skillsIdx.push(sk.length ? sk.map(s => `- ${s}`).join('\n') : '_None_');
    skillsIdx.push('');
  });
  fs.writeFileSync(SKILLS_IDX, skillsIdx.join('\n'), 'utf8');

  try { require('child_process').execSync(`git add ${SUMMARY} ${AGENTS_IDX} ${WORKFLOWS_IDX} ${SKILLS_IDX}`, { stdio: 'ignore' }); } catch {}
  console.log('- Notes: Workspace summary updated');
}

try { main(); } catch (e) {
  console.error('❌ Workspace summary failed:', e?.message || e);
  process.exit(0);
}

