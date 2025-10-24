/**
 * Health & System Tools
 * Category 1: Health check and system discovery
 */

import { z } from 'zod';
import { ForgeClient } from '../lib/forge-client.js';

export function registerHealthTools(server: any, client: ForgeClient) {
  // Tool: forge_health_check
  server.addTool({
    name: 'forge_health_check',
    description: 'Check Forge backend health status. Use this first to verify connectivity before other operations.',
    parameters: z.object({}),
    annotations: {
      readOnlyHint: true
    },
    execute: async (_args: any, { log }: any) => {
      log.info('Checking Forge backend health...');
      const health = await client.healthCheck();

      return `Forge Backend Health Check:\n${JSON.stringify(health, null, 2)}`;
    }
  });

  // Tool: forge_get_system_info
  server.addTool({
    name: 'forge_get_system_info',
    description: 'Get comprehensive system information including executor profiles, capabilities, and configuration. Shows what executors are available (Claude Code, Codex, Gemini, etc).',
    parameters: z.object({}),
    annotations: {
      readOnlyHint: true
    },
    execute: async (_args: any, { log }: any) => {
      log.info('Fetching system information...');
      const info = await client.getSystemInfo();

      return `Forge System Information:\n${JSON.stringify(info, null, 2)}`;
    }
  });

  // Tool: forge_list_executor_profiles
  server.addTool({
    name: 'forge_list_executor_profiles',
    description: 'List all available executor profiles (Claude Code, Codex, Gemini, Cursor, OpenCode). Use this to see which AI executors are configured and available for task execution.',
    parameters: z.object({}),
    annotations: {
      readOnlyHint: true
    },
    execute: async (_args: any, { log }: any) => {
      log.info('Listing executor profiles...');
      // Use normalized fetch via client, which prefers /api/info
      const profiles = await client.getExecutorProfiles();
      return `Available Executor Profiles:\n${JSON.stringify(profiles, null, 2)}`;
    }
  });
}
