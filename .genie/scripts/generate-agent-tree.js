#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

function scanAgents(root) {
  const agentsRoot = path.join(root, '.genie', 'agents');
  const out = { universal_neurons: [], code_neurons: [], create_neurons: [], orchestrators: [], git_workflows: [] };

  function push(filePath, bucket) {
    out[bucket].push({
      name: path.basename(filePath, path.extname(filePath)),
      path: path.relative(root, filePath),
      full_path: filePath,
    });
  }

  const neuronsDir = path.join(agentsRoot, 'neurons');
  if (fs.existsSync(neuronsDir)) {
    for (const f of fs.readdirSync(neuronsDir)) {
      if (f.endsWith('.md')) push(path.join(neuronsDir, f), 'universal_neurons');
    }
  }

  const codeDir = path.join(agentsRoot, 'code');
  if (fs.existsSync(codeDir)) {
    const codeOrch = path.join(codeDir, 'code.md');
    if (fs.existsSync(codeOrch)) out.orchestrators.push({ name: 'code', path: path.relative(root, codeOrch), full_path: codeOrch });
    const codeNeuronsDir = path.join(codeDir, 'neurons');
    if (fs.existsSync(codeNeuronsDir)) {
      for (const f of fs.readdirSync(codeNeuronsDir)) {
        if (f.endsWith('.md')) push(path.join(codeNeuronsDir, f), 'code_neurons');
      }
      const gitDir = path.join(codeNeuronsDir, 'git');
      if (fs.existsSync(gitDir)) {
        const gitMd = path.join(gitDir, 'git.md');
        if (fs.existsSync(gitMd)) out.code_neurons.push({ name: 'git', path: path.relative(root, gitMd), full_path: gitMd });
        const wfDir = path.join(gitDir, 'workflows');
        if (fs.existsSync(wfDir)) {
          for (const f of fs.readdirSync(wfDir)) if (f.endsWith('.md')) push(path.join(wfDir, f), 'git_workflows');
        }
      }
    }
  }

  const createDir = path.join(agentsRoot, 'create');
  if (fs.existsSync(createDir)) {
    const createOrch = path.join(createDir, 'create.md');
    if (fs.existsSync(createOrch)) out.orchestrators.push({ name: 'create', path: path.relative(root, createOrch), full_path: createOrch });
    const createNeuronsDir = path.join(createDir, 'neurons');
    if (fs.existsSync(createNeuronsDir)) {
      for (const f of fs.readdirSync(createNeuronsDir)) if (f.endsWith('.md')) push(path.join(createNeuronsDir, f), 'create_neurons');
    }
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
  lines.push('    %% Genie Agent Neural Tree');
  lines.push('');
  lines.push('    %% Universal Neurons (subset)');
  lines.push('    UNIVERSAL[Universal Neurons]:::universal');
  const universals = [...agents.universal_neurons].sort((a,b)=>a.name.localeCompare(b.name));
  universals.slice(0,5).forEach((a)=>{ lines.push(`    ${a.name}[${a.name}]:::neuron`); lines.push(`    UNIVERSAL --> ${a.name}`); });
  if (universals.length > 5) { lines.push(`    more_universal[...${universals.length-5} more]:::more`); lines.push('    UNIVERSAL --> more_universal'); }
  lines.push('');
  lines.push('    %% Code Template');
  lines.push('    CODE[Code Orchestrator]:::orchestrator');
  const codeNs = [...agents.code_neurons].sort((a,b)=>a.name.localeCompare(b.name));
  codeNs.slice(0,4).forEach((a)=>{ lines.push(`    code_${a.name}[${a.name}]:::code_neuron`); lines.push(`    CODE --> code_${a.name}`); });
  if (codeNs.length > 4) { lines.push(`    more_code[...${codeNs.length-4} more]:::more`); lines.push('    CODE --> more_code'); }
  if (agents.git_workflows.length) {
    lines.push('');
    lines.push('    %% Git Workflows');
    const git = codeNs.find((a)=>a.name==='git');
    if (git) { lines.push('    code_git --> git_issue[issue]:::workflow'); lines.push('    code_git --> git_pr[pr]:::workflow'); lines.push('    code_git --> git_report[report]:::workflow'); }
  }
  lines.push('');
  if (agents.create_neurons.length || agents.orchestrators.find(o=>o.name==='create')) {
    lines.push('    %% Create Template');
    lines.push('    CREATE[Create Orchestrator]:::orchestrator');
    const createNs = [...agents.create_neurons].sort((a,b)=>a.name.localeCompare(b.name));
    createNs.forEach((a)=>{ lines.push(`    create_${a.name}[${a.name}]:::create_neuron`); lines.push(`    CREATE --> create_${a.name}`); });
  }
  lines.push('');
  lines.push('    %% Styling');
  lines.push('    classDef universal fill:#e1f5ff,stroke:#0288d1,stroke-width:2px');
  lines.push('    classDef orchestrator fill:#fff3e0,stroke:#f57c00,stroke-width:3px');
  lines.push('    classDef neuron fill:#f3e5f5,stroke:#7b1fa2,stroke-width:2px');
  lines.push('    classDef code_neuron fill:#e8f5e9,stroke:#388e3c,stroke-width:2px');
  lines.push('    classDef create_neuron fill:#fce4ec,stroke:#c2185b,stroke-width:2px');
  lines.push('    classDef workflow fill:#fff9c4,stroke:#fbc02d,stroke-width:1px');
  lines.push('    classDef more fill:#f5f5f5,stroke:#9e9e9e,stroke-width:1px,stroke-dasharray: 5 5');
  lines.push('```');
  return lines.join('\n');
}

function generateMarkdownTree(agents) {
  const lines = [];
  lines.push('## Agent Neural Tree');
  lines.push('');
  lines.push('**Auto-generated** from `.genie/agents/` folder structure');
  lines.push('');
  const total = agents.universal_neurons.length + agents.code_neurons.length + agents.git_workflows.length + agents.create_neurons.length + agents.orchestrators.length;
  lines.push('**Summary:**');
  lines.push(`- Universal neurons: ${agents.universal_neurons.length}`);
  lines.push(`- Code neurons: ${agents.code_neurons.length}`);
  lines.push(`- Git workflows: ${agents.git_workflows.length}`);
  lines.push(`- Create neurons: ${agents.create_neurons.length}`);
  lines.push(`- Orchestrators: ${agents.orchestrators.length}`);
  lines.push(`- **Total: ${total} agents**`);
  lines.push('');
  lines.push('### Universal Neurons (Shared)');
  lines.push('');
  for (const a of [...agents.universal_neurons].sort((x,y)=>x.name.localeCompare(y.name))) {
    const dels = extractDelegations(a.full_path);
    lines.push(dels.length ? `- **${a.name}** → ${dels.map((d)=>'`'+d+'`').join(', ')}` : `- **${a.name}**`);
  }
  lines.push('');
  lines.push('### Code Template');
  lines.push('');
  lines.push('**Orchestrator:** `code`');
  lines.push('');
  lines.push('**Neurons:**');
  for (const a of [...agents.code_neurons].sort((x,y)=>x.name.localeCompare(y.name))) {
    const dels = extractDelegations(a.full_path);
    lines.push(dels.length ? `- **${a.name}** → ${dels.map((d)=>'`'+d+'`').join(', ')}` : `- **${a.name}**`);
  }
  if (agents.git_workflows.length) {
    lines.push('');
    lines.push('**Git workflows:** `issue`, `pr`, `report`');
  }
  if (agents.create_neurons.length) {
    lines.push('');
    lines.push('### Create Template');
    lines.push('');
    lines.push('**Orchestrator:** `create`');
    lines.push('');
    lines.push('**Neurons:**');
    for (const a of [...agents.create_neurons].sort((x,y)=>x.name.localeCompare(y.name))) {
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
  console.log('🔍 Scanning .genie/agents/ structure...');
  const agents = scanAgents(repoRoot);
  const total = agents.universal_neurons.length + agents.code_neurons.length + agents.git_workflows.length + agents.create_neurons.length + agents.orchestrators.length;
  console.log(`   Found ${total} agents total`);
  console.log(`   - Universal neurons: ${agents.universal_neurons.length}`);
  console.log(`   - Code neurons: ${agents.code_neurons.length}`);
  console.log(`   - Git workflows: ${agents.git_workflows.length}`);
  console.log(`   - Create neurons: ${agents.create_neurons.length}`);
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

