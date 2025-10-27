// Quick test to verify agent sync with fixed merge logic
import { createForgeExecutor } from './lib/forge-executor.js';

async function testSync() {
  console.log('🔍 Testing agent sync with fixed merge logic...\n');

  const forgeExecutor = createForgeExecutor();

  try {
    // Run sync (will clear cache automatically)
    await forgeExecutor.syncProfiles(undefined, process.cwd());

    console.log('\n✅ Sync completed! Checking Forge profiles...\n');

    // Fetch profiles to verify (use /api/config/profiles endpoint)
    const response = await fetch('http://localhost:8887/api/config/profiles');
    const data = await response.json();

    // Parse the content string (Forge wraps it in { data: { content: "..." } })
    const profiles = JSON.parse(data.data.content);

    // Count agent variants per executor
    const executors = profiles.executors || {};
    let totalAgents = 0;

    for (const [executorName, variants] of Object.entries(executors)) {
      const agentVariants = Object.keys(variants).filter(
        v => v.startsWith('CODE_') || v.startsWith('CREATE_')
      );
      totalAgents += agentVariants.length;

      if (agentVariants.length > 0) {
        console.log(`${executorName}: ${agentVariants.length} agent variants`);
      }
    }

    const executorCount = Object.keys(executors).length;
    const expectedAgents = 37 * executorCount; // 37 agents × N executors

    console.log(`\n📊 Total agent variants in Forge: ${totalAgents}`);
    console.log(`📊 Expected: ${expectedAgents} (37 agents × ${executorCount} executors)`);

    if (totalAgents === expectedAgents) {
      console.log('\n✅ SUCCESS! All agents synced correctly!');
    } else {
      console.log(`\n⚠️  MISMATCH: Expected ${expectedAgents}, got ${totalAgents}`);
    }

  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  }
}

testSync();
