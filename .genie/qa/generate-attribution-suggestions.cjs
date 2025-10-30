#!/usr/bin/env node

/**
 * Attribution Suggester for ACE Phase 5
 *
 * Generates learning attribution suggestions for QA scenarios
 * Uses pattern matching on titles, descriptions, and labels
 * Outputs YAML for human review and validation
 *
 * Usage:
 *   node .genie/qa/generate-attribution-suggestions.cjs
 *   node .genie/qa/generate-attribution-suggestions.cjs --dry-run
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Learning ID registry with keywords and categories
const LEARNING_PATTERNS = {
  // MCP Operations
  'routing-001': { keywords: ['agent', 'discovery', 'list agents'], category: 'mcp', confidence: 0.8 },
  'routing-003': { keywords: ['routing', 'decision', 'delegate'], category: 'routing', confidence: 0.9 },
  'routing-018': { keywords: ['when to delegate', 'agent execution', 'mcp'], category: 'mcp', confidence: 0.9 },

  // Delegation
  'delegate-001': { keywords: ['delegation', 'workflow', 'never implement', 'orchestrator'], category: 'delegation', confidence: 0.95 },
  'delegate-045': { keywords: ['self-delegate', 'never self', 'self delegation'], category: 'delegation', confidence: 0.95 },

  // Orchestration Boundary
  'orchestrator-018': { keywords: ['active forge', 'pre-edit', 'amendment #4', 'duplicate implementation'], category: 'delegation', confidence: 0.95 },

  // Forge Integration
  'forge-int-001': { keywords: ['clear ownership', 'forge task', 'one pr'], category: 'forge', confidence: 0.8 },
  'forge-int-006': { keywords: ['never create issue without', 'github issue'], category: 'forge', confidence: 0.9 },
  'forge-int-029': { keywords: ['create_task', 'mcp__automagik_forge__create_task'], category: 'forge', confidence: 0.95 },
  'forge-int-032': { keywords: ['start_task_attempt', 'executor', 'task attempt'], category: 'forge', confidence: 0.95 },
  'forge-int-035': { keywords: ['worktree', 'worktree naming', 'worktree pattern'], category: 'forge', confidence: 0.8 },

  // Forge Orchestration
  'forge-orch-002': { keywords: ['forge.md creates', 'forge mcp task'], category: 'forge', confidence: 0.9 },
  'forge-orch-079': { keywords: ['get_task periodically', 'monitor', 'polling'], category: 'forge', confidence: 0.85 },
  'forge-orch-083': { keywords: ['monitor', 'active vigilance', 'monitoring pattern'], category: 'forge', confidence: 0.8 },

  // Error Investigation
  'error-001': { keywords: ['panic', 'bypass', 'error handling', 'dont panic'], category: 'error', confidence: 0.85 },
  'error-015': { keywords: ['investigation', 'investigate before', 'protocol'], category: 'error', confidence: 0.9 },

  // Evidence-Based Completion
  'evidence-001': { keywords: ['can i see', 'evidence', 'result', 'proof'], category: 'execution', confidence: 0.9 },
  'evidence-010': { keywords: ['never mark completed without', 'completion', 'done'], category: 'execution', confidence: 0.85 },
  'evidence-015': { keywords: ['filesystem evidence', 'file exists'], category: 'execution', confidence: 0.8 },
  'evidence-020': { keywords: ['git evidence', 'commit', 'pr'], category: 'execution', confidence: 0.8 },

  // Know Yourself
  'know-012': { keywords: ['self-awareness', 'agent ecosystem', 'what i know'], category: 'identity', confidence: 0.7 },
  'know-025': { keywords: ['session awareness', 'session state'], category: 'identity', confidence: 0.75 },

  // Wish Dance
  'wish-008': { keywords: ['skip discovery', 'never skip', 'discovery first'], category: 'routing', confidence: 0.85 },
  'wish-014': { keywords: ['user shares', 'idea', 'discovery'], category: 'routing', confidence: 0.7 },
  'wish-036': { keywords: ['understand frustration', 'hook pattern'], category: 'routing', confidence: 0.7 },
  'wish-175': { keywords: ['session resumption', 'resume session'], category: 'routing', confidence: 0.8 },
  'wish-183': { keywords: ['track which step', 'step tracking'], category: 'routing', confidence: 0.75 },

  // Learning Protocol
  'learn-042': { keywords: ['recognition pattern', 'enter learning', 'learn mode'], category: 'learning', confidence: 0.85 },
  'learn-109': { keywords: ['load learn.md', 'immediately load'], category: 'learning', confidence: 0.9 },
  'learn-125': { keywords: ['parse teaching', 'teaching input'], category: 'learning', confidence: 0.8 },
  'learn-146': { keywords: ['duplicate', 'semantic dedup', '0.85'], category: 'learning', confidence: 0.8 },
  'learn-183': { keywords: ['commit message', 'fixes #', 'closes #'], category: 'learning', confidence: 0.85 },
};

// Priority patterns
const PRIORITY_PATTERNS = {
  critical: ['critical', 'amendment #4', 'worktree', 'delegation loop', 'duplicate implementation'],
  high: ['high', 'mcp', 'forge', 'session', 'failure'],
  medium: ['medium', 'ui', 'format', 'display'],
  low: ['low', 'documentation', 'typo', 'minor']
};

// Category patterns
const CATEGORY_PATTERNS = {
  mcp: ['mcp', 'agent', 'session', 'list agents', 'run agent'],
  forge: ['forge', 'worktree', 'task attempt', 'github issue'],
  delegation: ['delegation', 'orchestrator', 'implementor', 'amendment #4'],
  routing: ['routing', 'wish', 'discovery', 'alignment'],
  learning: ['learn', 'teaching', 'meta-learning', 'recognition'],
  execution: ['evidence', 'completion', 'filesystem', 'git'],
  error: ['error', 'investigation', 'panic', 'failure'],
  cli: ['cli', 'command', 'installer', 'terminal'],
  ui: ['ui', 'display', 'format', 'layout']
};

/**
 * Score text against learning patterns
 */
function scoreLearnings(text) {
  const lowerText = text.toLowerCase();
  const scores = [];

  for (const [learningId, pattern] of Object.entries(LEARNING_PATTERNS)) {
    let score = 0;
    let matchedKeywords = [];

    for (const keyword of pattern.keywords) {
      if (lowerText.includes(keyword.toLowerCase())) {
        score += pattern.confidence;
        matchedKeywords.push(keyword);
      }
    }

    if (score > 0) {
      scores.push({
        learningId,
        score,
        matchedKeywords,
        category: pattern.category,
        baseConfidence: pattern.confidence
      });
    }
  }

  // Sort by score descending
  scores.sort((a, b) => b.score - a.score);

  return scores;
}

/**
 * Infer priority from text
 */
function inferPriority(title, description, labels = []) {
  const text = `${title} ${description} ${labels.join(' ')}`.toLowerCase();

  for (const [priority, patterns] of Object.entries(PRIORITY_PATTERNS)) {
    for (const pattern of patterns) {
      if (text.includes(pattern)) {
        return priority;
      }
    }
  }

  return 'medium'; // default
}

/**
 * Infer category from text
 */
function inferCategory(title, description, labels = []) {
  const text = `${title} ${description} ${labels.join(' ')}`.toLowerCase();
  const categoryScores = {};

  for (const [category, patterns] of Object.entries(CATEGORY_PATTERNS)) {
    categoryScores[category] = 0;
    for (const pattern of patterns) {
      if (text.includes(pattern)) {
        categoryScores[category]++;
      }
    }
  }

  // Find category with highest score
  let maxScore = 0;
  let maxCategory = 'general';

  for (const [category, score] of Object.entries(categoryScores)) {
    if (score > maxScore) {
      maxScore = score;
      maxCategory = category;
    }
  }

  return maxCategory;
}

/**
 * Parse checklist scenarios
 */
function parseChecklistScenarios(checklistPath) {
  const content = fs.readFileSync(checklistPath, 'utf-8');
  const scenarios = [];

  const lines = content.split('\n');
  let currentSection = '';
  let currentScenario = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Section headers (## MCP Agent Operations)
    if (line.startsWith('##')) {
      currentSection = line.replace(/^#+\s*/, '').trim();
      continue;
    }

    // Scenario items (- [ ] **Valid agent execution**)
    if (line.match(/^- \[ \] \*\*(.+?)\*\*/)) {
      const titleMatch = line.match(/\*\*(.+?)\*\*/);
      const title = titleMatch ? titleMatch[1] : '';

      // Create scenario ID from title
      const scenarioId = title
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, '')
        .replace(/\s+/g, '-')
        .substring(0, 50);

      currentScenario = {
        id: scenarioId,
        title: title,
        section: currentSection,
        description: '',
        command: '',
        evidence: '',
        status: ''
      };

      scenarios.push(currentScenario);
    }

    // Parse scenario details
    if (currentScenario) {
      if (line.includes('**Comando:**') || line.includes('**Command:**')) {
        currentScenario.command = line.replace(/.*?:\s*/, '').replace(/`/g, '').trim();
      }
      if (line.includes('**Evidência:**') || line.includes('**Evidence:**')) {
        currentScenario.evidence = line.replace(/.*?:\s*/, '').trim();
      }
      if (line.includes('**Status:**')) {
        currentScenario.status = line.replace(/.*?:\s*/, '').trim();
      }
    }
  }

  return scenarios;
}

/**
 * Parse bug scenarios from GitHub
 */
function parseBugScenarios() {
  try {
    const out = execSync('gh issue list --label type:bug --state all --json number,title,labels,state,body --limit 1000', { encoding: 'utf8' });
    const issues = JSON.parse(out);

    return issues.map(issue => ({
      id: `bug-${issue.number}`,
      title: issue.title,
      section: 'Bug Regression',
      description: issue.body || '',
      labels: (issue.labels || []).map(l => l.name),
      state: issue.state,
      number: issue.number
    }));
  } catch (e) {
    console.error(`Error fetching bug issues: ${e.message}`);
    return [];
  }
}

/**
 * Generate attribution suggestions for a scenario
 */
function generateAttribution(scenario) {
  const fullText = `${scenario.title} ${scenario.description} ${scenario.command} ${scenario.evidence}`;
  const scores = scoreLearnings(fullText);

  // Top learnings (score > 0)
  const topHelpers = scores.slice(0, 5).map(s => s.learningId);

  // Prevention learnings (always suggest common ones)
  const preventers = ['error-001', 'error-015', 'evidence-001'];

  // Add delegation preventers if delegation-related
  if (fullText.toLowerCase().includes('delegation') ||
      fullText.toLowerCase().includes('orchestrator') ||
      fullText.toLowerCase().includes('amendment #4')) {
    preventers.push('orchestrator-018', 'delegate-001');
  }

  // Add forge preventers if forge-related
  if (fullText.toLowerCase().includes('forge') ||
      fullText.toLowerCase().includes('worktree')) {
    preventers.push('forge-int-006', 'forge-int-011');
  }

  const priority = inferPriority(scenario.title, scenario.description, scenario.labels || []);
  const category = inferCategory(scenario.title, scenario.description, scenario.labels || []);

  // Calculate confidence
  const avgScore = scores.length > 0 ? scores.slice(0, 3).reduce((sum, s) => sum + s.score, 0) / 3 : 0;
  let confidence = 'low';
  if (avgScore > 0.8) confidence = 'high';
  else if (avgScore > 0.5) confidence = 'medium';

  return {
    scenario_id: scenario.id,
    title: scenario.title,
    source: scenario.section || scenario.id,
    expected_to_help: topHelpers.filter(id => !preventers.includes(id)),
    expected_to_prevent: [...new Set(preventers)], // dedupe
    category: category,
    priority: priority,
    confidence: confidence,
    needs_review: true,
    matched_keywords: scores.slice(0, 3).flatMap(s => s.matchedKeywords),
    score_details: scores.slice(0, 3).map(s => ({
      learning: s.learningId,
      score: s.score.toFixed(2),
      keywords: s.matchedKeywords
    }))
  };
}

/**
 * Format attribution as YAML
 */
function formatYAML(attributions) {
  let yaml = '# QA Scenario Learning Attribution Suggestions\n';
  yaml += '# Auto-Generated - REQUIRES HUMAN REVIEW\n';
  yaml += `# Generated: ${new Date().toISOString()}\n`;
  yaml += '# Total Scenarios: ' + attributions.length + '\n\n';
  yaml += '# Format:\n';
  yaml += '# scenario_id:\n';
  yaml += '#   title: Human-readable name\n';
  yaml += '#   source: checklist | bug-NNN\n';
  yaml += '#   expected_to_help: [learning-IDs that should help]\n';
  yaml += '#   expected_to_prevent: [learning-IDs that should prevent failure]\n';
  yaml += '#   category: mcp | forge | delegation | routing | learning | execution | error\n';
  yaml += '#   priority: critical | high | medium | low\n';
  yaml += '#   confidence: high | medium | low (AI suggestion confidence)\n';
  yaml += '#   needs_review: true (human review required)\n\n';
  yaml += '---\n\n';

  for (const attr of attributions) {
    yaml += `${attr.scenario_id}:\n`;
    yaml += `  title: "${attr.title.replace(/"/g, '\\"')}"\n`;
    yaml += `  source: ${attr.source}\n`;
    yaml += `  expected_to_help:\n`;
    if (attr.expected_to_help.length > 0) {
      for (const id of attr.expected_to_help) {
        const pattern = LEARNING_PATTERNS[id];
        const comment = pattern ? ` # ${pattern.keywords[0]}` : '';
        yaml += `    - ${id}${comment}\n`;
      }
    } else {
      yaml += `    [] # No strong matches - needs manual review\n`;
    }
    yaml += `  expected_to_prevent:\n`;
    for (const id of attr.expected_to_prevent) {
      const pattern = LEARNING_PATTERNS[id];
      const comment = pattern ? ` # ${pattern.keywords[0]}` : '';
      yaml += `    - ${id}${comment}\n`;
    }
    yaml += `  category: ${attr.category}\n`;
    yaml += `  priority: ${attr.priority}\n`;
    yaml += `  confidence: ${attr.confidence}\n`;
    yaml += `  needs_review: true\n`;

    // Add debug info as comments
    if (attr.matched_keywords && attr.matched_keywords.length > 0) {
      yaml += `  # Matched: ${attr.matched_keywords.join(', ')}\n`;
    }
    if (attr.score_details && attr.score_details.length > 0) {
      yaml += `  # Scores: ${attr.score_details.map(s => `${s.learning}=${s.score}`).join(', ')}\n`;
    }
    yaml += '\n';
  }

  return yaml;
}

/**
 * Main execution
 */
function main() {
  const dryRun = process.argv.includes('--dry-run');

  console.log('📋 ACE Phase 5: Attribution Suggester');
  console.log('=====================================\n');

  // Parse checklist scenarios
  console.log('📖 Parsing checklist scenarios...');
  const checklistPath = path.join(__dirname, 'checklist.md');
  const checklistScenarios = parseChecklistScenarios(checklistPath);
  console.log(`   Found ${checklistScenarios.length} checklist scenarios\n`);

  // Parse bug scenarios
  console.log('🐛 Fetching bug scenarios from GitHub...');
  const bugScenarios = parseBugScenarios();
  console.log(`   Found ${bugScenarios.length} bug scenarios\n`);

  // Combine all scenarios
  const allScenarios = [...checklistScenarios, ...bugScenarios];
  console.log(`📊 Total scenarios: ${allScenarios.length}\n`);

  // Generate attributions
  console.log('🤖 Generating learning attribution suggestions...');
  const attributions = allScenarios.map(scenario => generateAttribution(scenario));

  // Stats
  const stats = {
    total: attributions.length,
    highConfidence: attributions.filter(a => a.confidence === 'high').length,
    mediumConfidence: attributions.filter(a => a.confidence === 'medium').length,
    lowConfidence: attributions.filter(a => a.confidence === 'low').length,
    byCategory: {}
  };

  for (const attr of attributions) {
    stats.byCategory[attr.category] = (stats.byCategory[attr.category] || 0) + 1;
  }

  console.log('\n📈 Statistics:');
  console.log(`   Total: ${stats.total}`);
  console.log(`   High confidence: ${stats.highConfidence} (${(stats.highConfidence/stats.total*100).toFixed(1)}%)`);
  console.log(`   Medium confidence: ${stats.mediumConfidence} (${(stats.mediumConfidence/stats.total*100).toFixed(1)}%)`);
  console.log(`   Low confidence: ${stats.lowConfidence} (${(stats.lowConfidence/stats.total*100).toFixed(1)}%)`);
  console.log('\n   By category:');
  for (const [category, count] of Object.entries(stats.byCategory).sort((a, b) => b[1] - a[1])) {
    console.log(`   - ${category}: ${count}`);
  }

  // Generate YAML
  const yaml = formatYAML(attributions);

  if (dryRun) {
    console.log('\n--- DRY RUN OUTPUT (first 3 scenarios) ---\n');
    const lines = yaml.split('\n');
    let count = 0;
    for (const line of lines) {
      console.log(line);
      if (line.startsWith('  needs_review:')) {
        count++;
        if (count >= 3) break;
      }
    }
    console.log('\n--- END DRY RUN ---');
    console.log('\nℹ️  Dry run complete. No files written.');
    console.log(`\nTo generate full output: node ${__filename}`);
    return;
  }

  // Write output
  const outPath = path.join(__dirname, 'scenarios-metadata-suggestions.yaml');
  fs.writeFileSync(outPath, yaml);

  console.log(`\n✅ Suggestions written to: ${outPath}`);
  console.log('\n⚠️  IMPORTANT: These are AI-generated suggestions!');
  console.log('   - Review each scenario carefully');
  console.log('   - Validate learning attributions');
  console.log('   - Add missing learnings');
  console.log('   - Remove incorrect suggestions');
  console.log('   - Adjust confidence levels');
  console.log('\n📝 Next steps:');
  console.log('   1. Review suggestions: cat ' + outPath);
  console.log('   2. Edit and validate: vim ' + outPath);
  console.log('   3. Save validated version: mv ' + outPath + ' scenarios-metadata.yaml');
  console.log('   4. Commit: git add scenarios-metadata.yaml && git commit -m "feat(qa): Add learning attribution"');
}

main();
