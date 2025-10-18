#!/usr/bin/env node
/**
 * Simple Forge Integration Test
 * Tests that Forge backend is reachable and basic operations work
 */

const { ForgeClient } = require('./forge.js');

async function main() {
  console.log('🧪 Testing Forge Integration...\n');

  const forgeBaseUrl = process.env.FORGE_BASE_URL || 'http://localhost:3000';
  const genieProjectId = process.env.GENIE_PROJECT_ID || 'f8924071-fa8e-43ee-8fbc-96ec5b49b3da';

  console.log(`Config:`);
  console.log(`  FORGE_BASE_URL: ${forgeBaseUrl}`);
  console.log(`  GENIE_PROJECT_ID: ${genieProjectId}\n`);

  const forge = new ForgeClient(forgeBaseUrl);

  // Test 1: Health check
  try {
    console.log('Test 1: Health check...');
    const health = await forge.healthCheck();
    console.log('✅ Health check passed:', health);
  } catch (error) {
    console.error('❌ Health check failed:', error.message);
    return;
  }

  // Test 2: List projects
  try {
    console.log('\nTest 2: List projects...');
    const projects = await forge.listProjects();
    console.log(`✅ Found ${projects.length} projects`);
    projects.forEach(p => console.log(`  - ${p.name} (${p.id})`));
  } catch (error) {
    console.error('❌ List projects failed:', error.message);
    return;
  }

  // Test 3: Create and start task
  try {
    console.log('\nTest 3: Create and start task...');
    const attempt = await forge.createAndStartTask(genieProjectId, {
      title: 'Genie CLI Test: analyze (background)',
      description: 'Test task creation from Genie CLI',
      executor_profile_id: 'CLAUDE_CODE',
      base_branch: 'main'
    });
    console.log('✅ Task created:', attempt.id);
    console.log(`  Status: ${attempt.status}`);
    console.log(`  Worktree: ${attempt.worktree_path || 'N/A'}`);
    console.log(`  Branch: ${attempt.branch_name || 'N/A'}`);

    // Test 4: Follow-up
    console.log('\nTest 4: Follow-up prompt...');
    await forge.followUpTaskAttempt(attempt.id, 'Continue working on this task');
    console.log('✅ Follow-up sent');

    // Test 5: Get logs
    console.log('\nTest 5: Retrieve logs...');
    const processes = await forge.listExecutionProcesses(attempt.id);
    console.log(`✅ Found ${processes.length} execution processes`);
    if (processes.length > 0) {
      const latest = processes[processes.length - 1];
      console.log(`  Latest process: ${latest.id}`);
      console.log(`  Status: ${latest.status}`);
      console.log(`  Output length: ${latest.output?.length || 0} chars`);
    }

    // Test 6: Stop
    console.log('\nTest 6: Stop execution...');
    await forge.stopTaskAttemptExecution(attempt.id);
    console.log('✅ Execution stopped');

  } catch (error) {
    console.error('❌ Task operations failed:', error.message);
    console.error('Stack:', error.stack);
    return;
  }

  console.log('\n✅ All tests passed!');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
