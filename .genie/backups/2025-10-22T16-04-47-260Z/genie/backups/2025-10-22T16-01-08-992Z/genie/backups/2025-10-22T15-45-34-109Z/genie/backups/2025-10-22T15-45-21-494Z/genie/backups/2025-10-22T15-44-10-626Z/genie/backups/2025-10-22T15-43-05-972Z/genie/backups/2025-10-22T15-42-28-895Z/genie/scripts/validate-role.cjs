#!/usr/bin/env node
/**
 * validate-role.js
 *
 * Purpose: Pre-MCP delegation validator - ensures correct agent routing
 * Validates: Intent → Agent mapping per routing.md decision matrix
 * Action: Warn if delegation pattern violates routing rules
 *
 * Usage: node validate-role.js <intent> <target-agent>
 *
 * Part of: Skills Prioritization & Architecture Automation (Wish #107)
 */

const fs = require('fs');
const path = require('path');

// Agent routing matrix (from routing.md lines 52-61)
const ROUTING_MATRIX = {
  'genie': {
    triggers: ['ambiguous', 'architecture', 'risk', 'complexity', 'multiple approaches', 'high-stakes', 'strategic', 'planning'],
    output: 'Analysis, pressure test, recommendation',
    priority: 'HIGH'
  },
  'implementor': {
    triggers: ['build', 'implement', 'feature', 'bug fix', 'add support', 'changes to', 'code', 'files'],
    output: 'Modified files, passing tests',
    priority: 'MEDIUM'
  },
  'tests': {
    triggers: ['test', 'validation', 'QA', 'coverage', 'verify', 'integration tests'],
    output: 'Test results, coverage report',
    priority: 'MEDIUM'
  },
  'git': {
    triggers: ['commit', 'PR', 'issue', 'branch', 'release', 'gh command', 'github'],
    output: 'Links, issue/PR created',
    priority: 'MEDIUM'
  },
  'release': {
    triggers: ['publish', 'npm publish', 'github release', 'version bump', 'tag', 'rc release'],
    output: 'Published to npm/GitHub, verified',
    priority: 'CRITICAL'
  },
  'learn': {
    triggers: ['teach you', 'new pattern', 'from now on', 'you should have', 'let me teach'],
    output: 'Skills updated, AGENTS.md patched',
    priority: 'HIGH'
  },
  'polish': {
    triggers: ['clean up', 'refactor', 'improve', 'polish', 'remove duplication'],
    output: 'Cleaned files, tests pass',
    priority: 'LOW'
  }
};

// Critical routing rules (from routing.md lines 65-127)
const CRITICAL_RULES = {
  'release': {
    rule: 'ALWAYS delegate release operations to release agent',
    violations: ['manual npm publish', 'manual gh release', 'manual version tagging'],
    consequence: 'Releases without validation, incomplete changelog, no audit trail'
  },
  'learn': {
    rule: 'ALWAYS invoke learn agent when user teaches new pattern',
    violations: ['say "I\'m learning" without invoking', 'mental note without documenting'],
    consequence: 'Pattern not preserved, repeated mistakes'
  },
  'genie': {
    rule: 'CONSULT genie agent for ambiguous or high-risk decisions',
    violations: ['implement without pressure test', 'skip analysis on complex changes'],
    consequence: 'Suboptimal architecture, missed risks'
  }
};

/**
 * Validate intent → agent mapping
 * @param {string} intent - User intent description
 * @param {string} targetNeuron - Target agent for delegation
 * @returns {Object} - Validation result with warnings/suggestions
 */
function validateRouting(intent, targetNeuron) {
  const intentLower = intent.toLowerCase();
  const neuronLower = targetNeuron.toLowerCase();

  const result = {
    valid: true,
    confidence: 'high',
    warnings: [],
    suggestions: [],
    criticalViolations: []
  };

  // Check if target agent exists
  if (!ROUTING_MATRIX[neuronLower]) {
    result.valid = false;
    result.confidence = 'none';
    result.warnings.push(`❌ Unknown agent: ${targetNeuron}`);
    result.suggestions.push(`Available agents: ${Object.keys(ROUTING_MATRIX).join(', ')}`);
    return result;
  }

  // Check for critical rule violations
  for (const [agent, rule] of Object.entries(CRITICAL_RULES)) {
    const triggers = ROUTING_MATRIX[agent].triggers;
    const matchesCriticalIntent = triggers.some(trigger => intentLower.includes(trigger.toLowerCase()));

    if (matchesCriticalIntent && neuronLower !== agent) {
      result.valid = false;
      result.confidence = 'none';
      result.criticalViolations.push({
        agent,
        rule: rule.rule,
        consequence: rule.consequence,
        correctNeuron: agent
      });
    }
  }

  // Check if intent matches target agent triggers
  const targetConfig = ROUTING_MATRIX[neuronLower];
  const intentMatchesTarget = targetConfig.triggers.some(trigger =>
    intentLower.includes(trigger.toLowerCase())
  );

  if (!intentMatchesTarget) {
    result.confidence = 'low';
    result.warnings.push(`⚠️  Intent "${intent}" may not match ${targetNeuron} agent triggers`);

    // Find better matches
    const betterMatches = Object.entries(ROUTING_MATRIX)
      .filter(([agent, config]) =>
        config.triggers.some(trigger => intentLower.includes(trigger.toLowerCase()))
      )
      .map(([agent, config]) => ({ agent, priority: config.priority }));

    if (betterMatches.length > 0) {
      result.suggestions.push('Better agent matches:');
      betterMatches.forEach(({ agent, priority }) => {
        result.suggestions.push(`  - ${agent} (${priority} priority)`);
      });
    }
  }

  // Validate priority
  if (targetConfig.priority === 'CRITICAL') {
    result.warnings.push(`🚨 CRITICAL: ${targetNeuron} operations require special care`);
    result.suggestions.push('Validate all steps before proceeding');
  }

  return result;
}

/**
 * Format validation result for display
 * @param {string} intent - User intent
 * @param {string} targetNeuron - Target agent
 * @param {Object} result - Validation result
 * @returns {string} - Formatted output
 */
function formatValidationResult(intent, targetNeuron, result) {
  let output = `
🔍 Routing Validation: "${intent}" → ${targetNeuron}
`;

  if (result.valid && result.confidence === 'high') {
    output += `\n✅ Valid routing (confidence: ${result.confidence})\n`;
  } else if (result.valid && result.confidence === 'low') {
    output += `\n⚠️  Valid but low confidence\n`;
  } else {
    output += `\n❌ Invalid routing\n`;
  }

  if (result.criticalViolations.length > 0) {
    output += `\n🚨 CRITICAL VIOLATIONS:\n`;
    result.criticalViolations.forEach(violation => {
      output += `
   Violation: ${violation.rule}
   Correct agent: ${violation.correctNeuron}
   Consequence: ${violation.consequence}
`;
    });
  }

  if (result.warnings.length > 0) {
    output += `\n⚠️  Warnings:\n`;
    result.warnings.forEach(warning => {
      output += `   ${warning}\n`;
    });
  }

  if (result.suggestions.length > 0) {
    output += `\n💡 Suggestions:\n`;
    result.suggestions.forEach(suggestion => {
      output += `   ${suggestion}\n`;
    });
  }

  return output;
}

// Main execution
if (require.main === module) {
  const args = process.argv.slice(2);

  if (args.length < 2) {
    console.log(`
Usage: node validate-role.js <intent> <target-agent>

Validates intent → agent routing per routing.md decision matrix.

Available agents:
${Object.entries(ROUTING_MATRIX).map(([agent, config]) =>
  `  - ${agent} (${config.priority}): ${config.triggers.slice(0, 3).join(', ')}...`
).join('\n')}

Example:
  node validate-role.js "publish npm package" "release"
  → ✅ Valid routing (CRITICAL priority)

  node validate-role.js "publish npm package" "implementor"
  → ❌ Invalid - should use release agent
`);
    process.exit(0);
  }

  const intent = args[0];
  const targetNeuron = args[1];

  const result = validateRouting(intent, targetNeuron);
  const output = formatValidationResult(intent, targetNeuron, result);

  console.log(output);

  // Exit with non-zero if invalid or low confidence
  process.exit(result.valid && result.confidence === 'high' ? 0 : 1);
}

module.exports = { validateRouting, formatValidationResult, ROUTING_MATRIX };
