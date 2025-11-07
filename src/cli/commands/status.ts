import type { ParsedCommand, GenieConfig, ConfigPaths } from '../lib/types';
import { getForgeConfig } from '../lib/service-config.js';
import { isForgeRunning } from '../lib/forge-manager';
import { collectForgeStats, formatStatsForDashboard } from '../lib/forge-stats';

/**
 * Check URL shortener health
 * Simple health check - silent on failure
 */
async function isUrlShortenerHealthy(): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 2000); // 2s timeout

    const response = await fetch('https://url.namastex.ai/health', {
      signal: controller.signal,
      headers: { 'Accept': 'application/json' }
    });

    clearTimeout(timeoutId);
    return response.ok;
  } catch (error) {
    return false;
  }
}

export async function runStatus(
  parsed: ParsedCommand,
  _config: GenieConfig,
  _paths: Required<ConfigPaths>
): Promise<void> {
  const { baseUrl } = getForgeConfig();
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

  // Check URL shortener
  const shortenerHealthy = await isUrlShortenerHealthy();
  const shortenerStatus = shortenerHealthy ? '🟢 Available' : '🟡 Unavailable (using full URLs)';

  console.log(`🔗 URL Shortener: ${shortenerStatus}`);
  console.log(`   Service: https://url.namastex.ai`);

  console.log('');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  if (!forgeRunning) {
    console.log('');
    console.log('💡 To start Genie server:');
    console.log('   npx automagik-genie');
    console.log('');
  }
}
