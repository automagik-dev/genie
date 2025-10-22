import { isForgeRunning } from '../lib/forge-manager';
import { collectForgeStats, formatStatsForDashboard } from '../lib/forge-stats';
export async function runStatus(parsed, _config, _paths) {
    const baseUrl = process.env.FORGE_BASE_URL || 'http://localhost:8887';
    const mcpPort = process.env.MCP_PORT || '8885';
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('🧞 GENIE STATUS');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('');
    // Check Forge
    const forgeRunning = await isForgeRunning(baseUrl);
    const forgeStatus = forgeRunning ? '🟢 Running' : '🔴 Down';
    console.log(`📦 Forge Backend: ${forgeStatus}`);
    console.log(`   URL: ${baseUrl}`);
    if (forgeRunning) {
        const stats = await collectForgeStats(baseUrl);
        const statsDisplay = formatStatsForDashboard(stats);
        if (statsDisplay) {
            console.log(statsDisplay);
        }
    }
    console.log('');
    console.log(`📡 MCP Server:`);
    console.log(`   Expected URL: http://localhost:${mcpPort}/sse`);
    console.log(`   (Health check not implemented - check server logs)`);
    console.log('');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    if (!forgeRunning) {
        console.log('');
        console.log('💡 To start Genie server:');
        console.log('   npx automagik-genie');
        console.log('');
    }
}
