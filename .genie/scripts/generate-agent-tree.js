#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

function scanAgents(root) {
  const genieRoot = path.join(root, '.genie');
  const out = { code_agents: [], create_agents: [], code_workflows: [], orchestrators: [], git_workflows: [] };

  function push(filePath, bucket) {
    out[bucket].push({
      name: path.basename(filePath, path.extname(filePath)),
      path: path.relative(root, filePath),
      full_path: filePath,
    });
  }

  // Scan code agents
  const codeAgentsDir = path.join(genieRoot, 'code', 'agents');
  if (fs.existsSync(codeAgentsDir)) {
    for (const f of fs.readdirSync(codeAgentsDir)) {
      if (f.endsWith('.md')) {
        push(path.join(codeAgentsDir, f), 'code_agents');
      } else if (fs.statSync(path.join(codeAgentsDir, f)).isDirectory()) {
        // Check for git/ or wish/ subdirectories
        const agentFile = path.join(codeAgentsDir, f, `${f}.md`);
        if (fs.existsSync(agentFile)) {
          push(agentFile, 'code_agents');
          // Check for workflows subdirectory
          const wfDir = path.join(codeAgentsDir, f, 'workflows');
          if (fs.existsSync(wfDir)) {
            for (const wf of fs.readdirSync(wfDir)) {
              if (wf.endsWith('.md')) push(path.join(wfDir, wf), 'git_workflows');
            }
          }
        }
      }
    }
  }

  // Scan code workflows
  const codeWorkflowsDir = path.join(genieRoot, 'code', 'workflows');
  if (fs.existsSync(codeWorkflowsDir)) {
    for (const f of fs.readdirSync(codeWorkflowsDir)) {
      if (f.endsWith('.md')) push(path.join(codeWorkflowsDir, f), 'code_workflows');
    }
  }

  // Scan code collective
  const codeDir = path.join(genieRoot, 'code');
  if (fs.existsSync(codeDir)) {
    const codeOrch = path.join(codeDir, 'code.md');
    if (fs.existsSync(codeOrch)) out.orchestrators.push({ name: 'code', path: path.relative(root, codeOrch), full_path: codeOrch });
  }

  // Scan create agents
  const createAgentsDir = path.join(genieRoot, 'create', 'agents');
  if (fs.existsSync(createAgentsDir)) {
    for (const f of fs.readdirSync(createAgentsDir)) {
      if (f.endsWith('.md')) push(path.join(createAgentsDir, f), 'create_agents');
    }
  }

  // Scan create collective
  const createDir = path.join(genieRoot, 'create');
  if (fs.existsSync(createDir)) {
    const createOrch = path.join(createDir, 'create.md');
    if (fs.existsSync(createOrch)) out.orchestrators.push({ name: 'create', path: path.relative(root, createOrch), full_path: createOrch });
  }

  return out;
}

function extractDelegations(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const re = /mcp__genie__run.*?agent=["']([^"']+)["']/gs;
    const set = new Set();
    let m; while ((m = re.exec(content))) set.add(m[1]);
    return Array.from(set);
  } catch { return []; }
}

function generateMermaid(agents) {
  const lines = [];
  lines.push('```mermaid');
  lines.push('graph TB');
  lines.push('    %% Genie Agent Tree');
  lines.push('');
  lines.push('    %% Code Collective');
  lines.push('    CODE[Code Collective]:::orchestrator');
  const codeAgents = [...agents.code_agents].sort((a,b)=>a.name.localeCompare(b.name));
  codeAgents.slice(0,6).forEach((a)=>{ lines.push(`    code_${a.name}[${a.name}]:::code_agent`); lines.push(`    CODE --> code_${a.name}`); });
  if (codeAgents.length > 6) { lines.push(`    more_code[...${codeAgents.length-6} more]:::more`); lines.push('    CODE --> more_code'); }
  if (agents.git_workflows.length) {
    lines.push('');
    lines.push('    %% Git Workflows');
    const git = codeAgents.find((a)=>a.name==='git');
    if (git) { lines.push('    code_git --> git_issue[issue]:::workflow'); lines.push('    code_git --> git_pr[pr]:::workflow'); lines.push('    code_git --> git_report[report]:::workflow'); }
  }
  lines.push('');
  if (agents.code_workflows.length) {
    lines.push('    %% Code Workflows');
    const workflows = [...agents.code_workflows].sort((a,b)=>a.name.localeCompare(b.name));
    workflows.slice(0,4).forEach((a)=>{ lines.push(`    workflow_${a.name}[${a.name}]:::workflow`); lines.push(`    CODE --> workflow_${a.name}`); });
  }
  if (agents.create_agents.length || agents.orchestrators.find(o=>o.name==='create')) {
    lines.push('');
    lines.push('    %% Create Collective');
    lines.push('    CREATE[Create Collective]:::orchestrator');
    const createAgents = [...agents.create_agents].sort((a,b)=>a.name.localeCompare(b.name));
    createAgents.forEach((a)=>{ lines.push(`    create_${a.name}[${a.name}]:::create_agent`); lines.push(`    CREATE --> create_${a.name}`); });
  }
  lines.push('');
  lines.push('    %% Styling');
  lines.push('    classDef orchestrator fill:#fff3e0,stroke:#f57c00,stroke-width:3px');
  lines.push('    classDef code_agent fill:#e8f5e9,stroke:#388e3c,stroke-width:2px');
  lines.push('    classDef create_agent fill:#fce4ec,stroke:#c2185b,stroke-width:2px');
  lines.push('    classDef workflow fill:#fff9c4,stroke:#fbc02d,stroke-width:1px');
  lines.push('    classDef more fill:#f5f5f5,stroke:#9e9e9e,stroke-width:1px,stroke-dasharray: 5 5');
  lines.push('```');
  return lines.join('\n');
}

function generateMarkdownTree(agents) {
  const lines = [];
  lines.push('## Agent Tree');
  lines.push('');
  lines.push('**Auto-generated** from `.genie/` folder structure');
  lines.push('');
  const total = agents.code_agents.length + agents.git_workflows.length + agents.create_agents.length + agents.code_workflows.length + agents.orchestrators.length;
  lines.push('**Summary:**');
  lines.push(`- Code agents: ${agents.code_agents.length}`);
  lines.push(`- Code workflows: ${agents.code_workflows.length}`);
  lines.push(`- Git workflows: ${agents.git_workflows.length}`);
  lines.push(`- Create agents: ${agents.create_agents.length}`);
  lines.push(`- Orchestrators: ${agents.orchestrators.length}`);
  lines.push(`- **Total: ${total} agents**`);
  lines.push('');
  lines.push('### Code Collective');
  lines.push('');
  lines.push('**Orchestrator:** `code`');
  lines.push('');
  lines.push('**Agents:**');
  for (const a of [...agents.code_agents].sort((x,y)=>x.name.localeCompare(y.name))) {
    const dels = extractDelegations(a.full_path);
    lines.push(dels.length ? `- **${a.name}** → ${dels.map((d)=>'`'+d+'`').join(', ')}` : `- **${a.name}**`);
  }
  if (agents.code_workflows.length) {
    lines.push('');
    lines.push('**Workflows:**');
    for (const a of [...agents.code_workflows].sort((x,y)=>x.name.localeCompare(y.name))) {
      lines.push(`- **${a.name}**`);
    }
  }
  if (agents.git_workflows.length) {
    lines.push('');
    lines.push('**Git workflows:** `issue`, `pr`, `report`');
  }
  if (agents.create_agents.length) {
    lines.push('');
    lines.push('### Create Collective');
    lines.push('');
    lines.push('**Orchestrator:** `create`');
    lines.push('');
    lines.push('**Agents:**');
    for (const a of [...agents.create_agents].sort((x,y)=>x.name.localeCompare(y.name))) {
      lines.push(`- **${a.name}**`);
    }
  }
  return lines.join('\n');
}

function updateBetweenMarkers(filePath, startMarker, endMarker, newContent) {
  if (!fs.existsSync(filePath)) { console.warn(`⚠️  File not found: ${filePath}`); return false; }
  const content = fs.readFileSync(filePath, 'utf8');
  const startIdx = content.indexOf(startMarker);
  const endIdx = content.indexOf(endMarker);
  if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) {
    console.warn(`⚠️  Markers not found in ${path.relative(process.cwd(), filePath)}`);
    return false;
  }
  const before = content.slice(0, startIdx + startMarker.length) + '\n';
  const after = '\n' + content.slice(endIdx);
  fs.writeFileSync(filePath, before + newContent + after);
  return true;
}

function main() {
  const repoRoot = path.join(__dirname, '..', '..');
  console.log('🔍 Scanning .genie/ structure...');
  const agents = scanAgents(repoRoot);
  const total = agents.code_agents.length + agents.code_workflows.length + agents.git_workflows.length + agents.create_agents.length + agents.orchestrators.length;
  console.log(`   Found ${total} agents total`);
  console.log(`   - Code agents: ${agents.code_agents.length}`);
  console.log(`   - Code workflows: ${agents.code_workflows.length}`);
  console.log(`   - Git workflows: ${agents.git_workflows.length}`);
  console.log(`   - Create agents: ${agents.create_agents.length}`);
  console.log(`   - Orchestrators: ${agents.orchestrators.length}`);

  console.log('\n🌲 Generating Mermaid diagram...');
  const mermaid = generateMermaid(agents);
  console.log('📝 Generating markdown tree...');
  const mdTree = generateMarkdownTree(agents);

  const readme = path.join(repoRoot, 'README.md');
  console.log(`\n📄 Updating ${path.relative(repoRoot, readme)}...`);
  const ok1 = updateBetweenMarkers(readme, '<!-- AGENT_TREE_START -->', '<!-- AGENT_TREE_END -->', mermaid);
  console.log(ok1 ? '   ✅ Mermaid chart updated' : '   ⚠️  Could not update Mermaid chart (markers missing)');

  const genieReadme = path.join(repoRoot, '.genie', 'README.md');
  console.log(`\n📄 Updating ${path.relative(repoRoot, genieReadme)}...`);
  const ok2 = updateBetweenMarkers(genieReadme, '<!-- NEURAL_TREE_START -->', '<!-- NEURAL_TREE_END -->', mdTree);
  console.log(ok2 ? '   ✅ Markdown tree updated' : '   ⚠️  Could not update markdown tree (markers missing)');

  console.log('\n✨ Agent neural tree generation complete!');
  console.log('   - README.md: Mermaid flowchart');
  console.log('   - .genie/README.md: Detailed markdown tree');
}

main();

