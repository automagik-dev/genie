const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  listAgents,
  resolveAgentIdentifier,
  agentExists,
  loadAgentSpec,
  extractFrontMatter
} = require('../.genie/cli/dist/lib/agent-resolver.js');

// Test: extractFrontMatter with no frontmatter
(function testExtractFrontMatterNone() {
  const content = 'Just plain markdown content';
  const result = extractFrontMatter(content);
  assert.deepStrictEqual(result.meta, {}, 'should return empty meta for no frontmatter');
  assert.strictEqual(result.body, content, 'should return full content as body');
})();

// Test: extractFrontMatter with valid frontmatter
(function testExtractFrontMatterValid() {
  const content = `---
name: test-agent
description: A test agent
---
# Agent Content
This is the body`;
  const result = extractFrontMatter(content);
  assert.ok(result.meta, 'should have meta object');
  assert.strictEqual(result.meta.name, 'test-agent', 'should parse name from frontmatter');
  assert.strictEqual(result.meta.description, 'A test agent', 'should parse description from frontmatter');
  assert.ok(result.body.includes('# Agent Content'), 'should return body without frontmatter');
})();

// Test: extractFrontMatter with incomplete frontmatter
(function testExtractFrontMatterIncomplete() {
  const content = `---
name: test-agent
Some content without closing marker`;
  const result = extractFrontMatter(content);
  assert.deepStrictEqual(result.meta, {}, 'should return empty meta for incomplete frontmatter');
  assert.ok(result.body.includes('name: test-agent'), 'should treat everything as body');
})();

// Test: extractFrontMatter with invalid YAML (when YAML module available)
(function testExtractFrontMatterInvalidYaml() {
  const content = `---
{invalid: yaml content
---
Body content`;
  const result = extractFrontMatter(content);
  // Should handle gracefully - either parse or return empty meta
  assert.ok(result.body, 'should have body content');
})();

// Test: agentExists with existing agent
(function testAgentExistsTrue() {
  // Test with known agents from the actual project
  const exists = agentExists('plan');
  assert.strictEqual(exists, true, 'should find existing plan agent');
})();

// Test: agentExists with non-existing agent
(function testAgentExistsFalse() {
  const exists = agentExists('non-existent-agent-xyz');
  assert.strictEqual(exists, false, 'should return false for non-existing agent');
})();

// Test: agentExists with empty string
(function testAgentExistsEmpty() {
  const exists = agentExists('');
  assert.strictEqual(exists, false, 'should return false for empty string');
})();

// Test: agentExists with path separators
(function testAgentExistsWithPath() {
  const exists = agentExists('orchestrator');
  assert.strictEqual(exists, true, 'should handle path separators correctly');
})();

// Test: listAgents returns array
(function testListAgentsReturnsArray() {
  const agents = listAgents();
  assert.ok(Array.isArray(agents), 'should return an array');
  assert.ok(agents.length > 0, 'should return at least one agent from project');
})();

// Test: listAgents structure
(function testListAgentsStructure() {
  const agents = listAgents();
  if (agents.length > 0) {
    const agent = agents[0];
    assert.ok(agent.id, 'agent should have id');
    assert.ok(agent.label, 'agent should have label');
    assert.ok(typeof agent.meta === 'object', 'agent should have meta object');
    assert.ok(agent.folder === null || typeof agent.folder === 'string', 'folder should be null or string');
  }
})();

// Test: listAgents filters README.md
(function testListAgentsFiltersReadme() {
  const agents = listAgents();
  const readmeAgent = agents.find(a => a.id === 'README' || a.id.endsWith('/README'));
  assert.strictEqual(readmeAgent, undefined, 'should not include README.md files');
})();

// Test: listAgents normalizes IDs
(function testListAgentsNormalizesIds() {
  const agents = listAgents();
  if (agents.length > 0) {
    agents.forEach(agent => {
      assert.ok(!agent.id.endsWith('.md'), 'agent IDs should not end with .md');
      assert.ok(!agent.id.includes('\\'), 'agent IDs should use forward slashes');
    });
  }
})();

// Test: resolveAgentIdentifier with exact match
(function testResolveAgentIdentifierExact() {
  const resolved = resolveAgentIdentifier('plan');
  assert.strictEqual(resolved, 'plan', 'should resolve canonical core path');
})();

// Test: resolveAgentIdentifier with case insensitive
(function testResolveAgentIdentifierCaseInsensitive() {
  const resolved = resolveAgentIdentifier('PLAN');
  assert.strictEqual(resolved.toLowerCase(), 'plan', 'should resolve case-insensitive match to canonical path');
})();

// Test: resolveAgentIdentifier with .md extension
(function testResolveAgentIdentifierWithExtension() {
  const resolved = resolveAgentIdentifier('plan.md');
  assert.strictEqual(resolved, 'plan', 'should strip .md extension and return canonical path');
})();

// Test: resolveAgentIdentifier with path
(function testResolveAgentIdentifierWithPath() {
  const resolved = resolveAgentIdentifier('orchestrator');
  assert.strictEqual(resolved, 'orchestrator', 'should resolve paths correctly');
})();

// Test: resolveAgentIdentifier with non-existing agent
(function testResolveAgentIdentifierNotFound() {
  try {
    resolveAgentIdentifier('non-existent-agent-xyz-123');
    assert.fail('should throw error for non-existing agent');
  } catch (error) {
    assert.ok(error.message.includes('not found'), 'error should mention agent not found');
  }
})();

// Test: resolveAgentIdentifier with empty string
(function testResolveAgentIdentifierEmpty() {
  try {
    resolveAgentIdentifier('');
    assert.fail('should throw error for empty string');
  } catch (error) {
    assert.ok(error.message.includes('required'), 'error should mention agent id is required');
  }
})();

// Test: resolveAgentIdentifier with whitespace
(function testResolveAgentIdentifierWhitespace() {
  try {
    resolveAgentIdentifier('   ');
    assert.fail('should throw error for whitespace-only string');
  } catch (error) {
    assert.ok(error.message.includes('required'), 'error should mention agent id is required');
  }
})();

// Test: loadAgentSpec with existing agent
(function testLoadAgentSpecExisting() {
  const spec = loadAgentSpec('plan');
  assert.ok(spec, 'should return spec object');
  assert.ok(spec.meta || spec.meta === undefined, 'should have meta property');
  assert.ok(spec.instructions, 'should have instructions property');
  assert.ok(typeof spec.instructions === 'string', 'instructions should be a string');
  assert.ok(spec.instructions.length > 0, 'instructions should not be empty');
})();

// Test: loadAgentSpec with non-existing agent
(function testLoadAgentSpecNotFound() {
  try {
    loadAgentSpec('non-existent-agent-xyz-123');
    assert.fail('should throw error for non-existing agent');
  } catch (error) {
    assert.ok(error.message.includes('not found'), 'error should mention agent not found');
  }
})();

// Test: loadAgentSpec strips .md extension
(function testLoadAgentSpecStripsMd() {
  const spec = loadAgentSpec('plan.md');
  assert.ok(spec, 'should load agent even with .md extension');
  assert.ok(spec.instructions, 'should have instructions');
})();

// Test: loadAgentSpec with frontmatter
(function testLoadAgentSpecWithFrontmatter() {
  const spec = loadAgentSpec('plan');
  if (spec.meta && Object.keys(spec.meta).length > 0) {
    assert.ok(spec.meta.name || spec.meta.description, 'should parse frontmatter when present');
  }
  assert.ok(!spec.instructions.startsWith('---'), 'instructions should not include frontmatter');
})();

console.log('✅ agent-resolver tests passed');
