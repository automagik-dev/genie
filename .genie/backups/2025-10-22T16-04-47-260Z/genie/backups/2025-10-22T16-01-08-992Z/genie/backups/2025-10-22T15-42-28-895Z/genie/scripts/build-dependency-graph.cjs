#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

function readFileSafe(p) { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } }

function parseAtReferences(filePath) {
  const content = readFileSafe(filePath);
  const matches = content.match(/@([\w./-]+\.md)/g) || [];
  const set = new Set();
  for (const m of matches) {
    const ref = m.slice(1); // remove leading '@'
    set.add(ref.replace(/^\.\//, ''));
  }
  return Array.from(set);
}

function parseTsImports(filePath, repoRoot) {
  const content = readFileSafe(filePath);
  const re = /import\s+(?:{[^}]*}|\w+)\s+from\s+["']([^"']+)["']/g;
  const out = new Set();
  let m; while ((m = re.exec(content))) {
    const imp = m[1];
    if (!imp.startsWith('.')) continue; // skip packages
    const resolved = path.resolve(path.dirname(filePath), imp);
    try {
      const rel = path.relative(repoRoot, resolved);
      out.add(rel);
    } catch {}
  }
  return Array.from(out);
}

function listFiles(root, patterns) {
  const out = [];
  function walk(d) {
    const entries = fs.readdirSync(d, { withFileTypes: true });
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { walk(p); }
      else { out.push(p); }
    }
  }
  walk(root);
  return out.filter((p) => patterns.some((ext) => p.endsWith(ext)));
}

function buildGraph(repoRoot) {
  const deps = new Map();
  const types = new Map();

  // Markdown in .genie
  const mdFiles = listFiles(path.join(repoRoot, '.genie'), ['.md']);
  mdFiles.forEach((f) => {
    const rel = path.relative(repoRoot, f);
    types.set(rel, 'md');
    const refs = parseAtReferences(f).map((r) => (r.startsWith('.genie/') ? r : `.genie/${r}`));
    if (!deps.has(rel)) deps.set(rel, new Set());
    refs.forEach((r) => deps.get(rel).add(r));
  });

  // TypeScript sources
  const tsFiles = [
    ...listFiles(path.join(repoRoot, '.genie', 'cli', 'src'), ['.ts']),
    ...listFiles(path.join(repoRoot, '.genie', 'mcp', 'src'), ['.ts']),
  ].filter((p) => fs.existsSync(path.dirname(p)));
  tsFiles.forEach((f) => {
    const rel = path.relative(repoRoot, f);
    types.set(rel, 'ts');
    const ims = parseTsImports(f, repoRoot);
    if (!deps.has(rel)) deps.set(rel, new Set());
    ims.forEach((i) => deps.get(rel).add(i));
  });

  // Convert to plain objects
  const depsObj = {};
  for (const [k, v] of deps.entries()) depsObj[k] = Array.from(v);
  const typeObj = {};
  for (const [k, v] of types.entries()) typeObj[k] = v;
  return { deps: depsObj, types: typeObj };
}

function findHubNodes(deps) {
  const counts = new Map();
  Object.values(deps).forEach((arr) => arr.forEach((d) => counts.set(d, (counts.get(d) || 0) + 1)));
  return Array.from(counts.entries()).sort((a, b) => b[1] - a[1]).slice(0, 10);
}

function detectCircles(deps) {
  const circles = [];
  for (const [file, arr] of Object.entries(deps)) {
    for (const dep of arr) {
      if (deps[dep] && deps[dep].includes(file)) {
        const pair = [file, dep].sort();
        if (!circles.find((c) => c[0] === pair[0] && c[1] === pair[1])) circles.push(pair);
      }
    }
  }
  return circles;
}

function sanitizeId(p) { return p.replace(/[^a-zA-Z0-9_]/g, '_'); }

function generateMermaid(deps, types) {
  const keyFiles = new Set(['CLAUDE.md', 'AGENTS.md', '.genie/MASTER-PLAN.md', '.genie/SESSION-STATE.md', '.genie/USERCONTEXT.md', '.genie/STATE.md']);
  findHubNodes(deps).forEach(([h]) => keyFiles.add(h));
  const filesToShow = new Set(keyFiles);
  for (const [file, arr] of Object.entries(deps)) if (keyFiles.has(file)) { filesToShow.add(file); arr.forEach((d) => filesToShow.add(d)); }
  const max = 50; const shown = Array.from(filesToShow).slice(0, max);
  const lines = ['graph TD'];
  shown.sort().forEach((file) => {
    if (!deps[file]) return;
    const fileId = sanitizeId(file);
    const fileLabel = path.basename(file);
    deps[file].forEach((dep) => {
      if (!shown.includes(dep)) return;
      const depId = sanitizeId(dep);
      const depLabel = path.basename(dep);
      lines.push(`    ${fileId}[\"${fileLabel}\"] --> ${depId}[\"${depLabel}\"]`);
    });
  });
  return lines.join('\n');
}

function generateContent(deps, types) {
  const ts = new Date().toISOString().replace('T', ' ').replace(/\..+/, ' UTC');
  const totalNodes = Object.keys(deps).length;
  const totalEdges = Object.values(deps).reduce((a, b) => a + b.length, 0);
  const hubs = findHubNodes(deps);
  const circles = detectCircles(deps);
  const mermaid = generateMermaid(deps, types);
  let content = `# Dependency Graph\n\n**Auto-Generated:** ${ts}\n**Source:** @ references in .md files + import statements in .ts files\n**Script:** \\`.genie/scripts/build-dependency-graph.js\\`\n\n---\n\n## Overview\n\n**Total Nodes:** ${totalNodes} files\n**Total Edges:** ${totalEdges} dependencies\n**Circular Dependencies:** ${circles.length} detected\n\n---\n\n## Visual Map\n\n\`\`\`mermaid\n${mermaid}\n\`\`\`\n\n---\n\n## Hub Nodes (Most Referenced)\n\n`;
  hubs.forEach(([file, count], i) => { content += `${i + 1}. **${file}** - Referenced ${count} times\n`; });
  content += '\n---\n\n';
  if (circles.length) {
    content += '## Circular Dependencies\n\n';
    circles.forEach((c, i) => { content += `${i + 1}. ${c.join(' ↔ ')}\n`; });
    content += '\n---\n\n';
  }
  content += `## Usage\n\nThis file is auto-generated from codebase dependencies. To update:\n\n\`\`\`bash\nnode .genie/scripts/build-dependency-graph.js\n\`\`\`\n\nTo run with dry-run (print to stdout instead of file), set DRY_RUN=1.\n\n---\n\n## Legend\n\n**@ References:** Markdown files referencing other markdown files via \\`@path/to/file.md\\`\n**Import Statements:** TypeScript files importing other TypeScript modules\n\n**Hub Nodes:** Files referenced most frequently (architectural keypoints)\n**Circular Dependencies:** Files that reference each other (may indicate coupling)\n\n---\n\n## Interpretation\n\n**High hub node count:** Core architectural files (AGENTS.md, CLAUDE.md, etc.)\n**Many edges from file:** File loads lots of context (heavy dependencies)\n**Circular dependencies:** Review for potential refactoring opportunities\n\nThis graph helps understand:\n- Which files are central to the architecture\n- How knowledge flows through the system\n- Where coupling might be reduced\n- Evolution of architectural patterns over time\n`;
  return content;
}

function main() {
  const repoRoot = path.join(__dirname, '..', '..');
  console.log(`📊 Building dependency graph for: ${repoRoot}`);
  const { deps, types } = buildGraph(repoRoot);
  console.log('📝 Generating Mermaid diagram...');
  const content = generateContent(deps, types);
  if (process.env.DRY_RUN) {
    console.log('\n--- DRY RUN OUTPUT ---');
    console.log(content);
    console.log('\n--- END DRY RUN ---');
    console.log('\nℹ️  Dry run complete. No files written.');
    return;
  }
  const outPath = path.join(repoRoot, '.genie', 'docs', 'dependency-graph.md');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, content);
  console.log(`✅ Dependency graph written to: ${outPath}`);
  const totalNodes = Object.keys(deps).length;
  const totalEdges = Object.values(deps).reduce((a, b) => a + b.length, 0);
  const circles = detectCircles(deps);
  console.log('\n📊 Summary:');
  console.log(`   - Total files: ${totalNodes}`);
  console.log(`   - Total dependencies: ${totalEdges}`);
  console.log(`   - Circular dependencies: ${circles.length}`);
  if (circles.length) {
    console.log('\n⚠️  Circular dependencies detected:');
    circles.forEach((c) => console.log(`      ${c.join(' ↔ ')}`));
  }
}

main();

