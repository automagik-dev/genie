#!/usr/bin/env node

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

function fetchIssues() {
  try {
    const out = execSync('gh issue list --label type:bug --state all --json number,title,labels,state,createdAt,body --limit 1000', { encoding: 'utf8' });
    return JSON.parse(out);
  } catch (e) {
    console.error(`Error fetching issues: ${e.stderr || e.message}`);
    process.exit(1);
  }
}

function extractSections(body) {
  if (!body) return { description: 'No description provided' };
  const sections = {}; let current = 'description'; let buf = [];
  for (const line of body.split('\n')) {
    if (line.trim().startsWith('##')) { if (buf.length) sections[current] = buf.join('\n').trim(); current = line.replace(/^#+/,'').trim().toLowerCase().replace(/\s+/g,'_'); buf = []; }
    else if (line.trim().startsWith('**') && line.trim().endsWith('**')) { if (buf.length) sections[current] = buf.join('\n').trim(); current = line.replace(/\*/g,'').trim().toLowerCase().replace(/\s+/g,'_'); buf = []; }
    else buf.push(line);
  }
  if (buf.length) sections[current] = buf.join('\n').trim();
  return sections;
}

function formatScenario(issue) {
  const number = issue.number;
  const title = issue.title;
  const state = issue.state;
  const created = issue.createdAt.slice(0,10);
  const labels = (issue.labels || []).map((l) => l.name);
  const sections = extractSections(issue.body || '');
  const status = state === 'CLOSED' ? '✅ Fixed' : '🔴 Open';
  let s = `## Bug #${number}: ${title}\n**Status:** ${status}\n**Labels:** ${labels.join(', ')}\n**Created:** ${created}\n**GitHub:** https://github.com/namastexlabs/automagik-genie/issues/${number}\n\n`;
  const repro = sections.reproduction_steps || sections.steps_to_reproduce;
  if (repro) s += `### Reproduction Steps\n${repro}\n\n`;
  const expected = sections.expected_behavior || sections.expected;
  if (expected) s += `### Expected Behavior\n${expected}\n\n`;
  const actual = sections.actual_behavior || sections.actual;
  if (actual) s += `### Actual Behavior\n${actual}\n\n`;
  if (sections.description && !(repro || expected)) s += `### Description\n${sections.description}\n\n`;
  s += `### Validation\n- [${state === 'OPEN' ? ' ' : 'x'}] Bug verified fixed\n- [ ] Test scenario executed\n- [ ] Regression test added\n- [ ] Documentation updated\n\n---\n\n`;
  return s;
}

function main() {
  const dryRun = process.argv.includes('--dry-run');
  console.log('📋 Fetching GitHub issues...');
  const issues = fetchIssues();
  console.log(`   Found ${issues.length} bug issues`);
  const ts = new Date().toISOString().replace('T',' ').replace(/\..+/, ' UTC');
  const openBugs = issues.filter((i) => i.state === 'OPEN');
  const fixedBugs = issues.filter((i) => i.state === 'CLOSED');
  let content = `# QA Scenarios from GitHub Issues\n**Auto-Generated:** ${ts}\n**Source:** GitHub Issues with label \`type:bug\`\n**Script:** \`.genie/agents/qa/workflows/auto-generated/generator.cjs\`\n\n---\n\n## Summary\n\n**Total Bugs:** ${issues.length}\n- 🔴 Open: ${openBugs.length}\n- ✅ Fixed: ${fixedBugs.length}\n\n---\n\n## Open Bugs\n\n`;
  if (openBugs.length) openBugs.sort((a,b)=>a.number-b.number).forEach((i) => { content += formatScenario(i); }); else content += '*No open bugs found.*\n\n';
  content += `---\n\n## Fixed Bugs\n\n`;
  if (fixedBugs.length) fixedBugs.sort((a,b)=>b.number-a.number).forEach((i) => { content += formatScenario(i); }); else content += '*No fixed bugs found.*\n\n';
  content += `---\n\n## Usage\n\nThis file is auto-generated from GitHub issues. To update:\n\n\`\`\`bash\nnode .genie/agents/qa/workflows/auto-generated/generator.cjs\n\`\`\`\n\nTo run manually with dry-run:\n\n\`\`\`bash\nnode .genie/agents/qa/workflows/auto-generated/generator.cjs --dry-run\n\`\`\`\n\nTo automate via GitHub Actions (future):\n- Add workflow trigger: daily or on issue close\n- Run script and commit changes\n- Track regression coverage\n`;
  if (dryRun) {
    console.log('\n--- DRY RUN OUTPUT ---');
    console.log(content);
    console.log('\n--- END DRY RUN ---');
    console.log('\nℹ️  Dry run complete. No files written.');
    return;
  }
  const outPath = path.join(__dirname, 'scenarios-from-bugs.md');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, content);
  console.log(`✅ Scenarios written to: ${outPath}`);
  console.log('\n📊 Summary:');
  console.log(`   - Total bugs: ${issues.length}`);
  console.log(`   - Open: ${openBugs.length}`);
  console.log(`   - Fixed: ${fixedBugs.length}`);
}

main();

