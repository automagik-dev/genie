/**
 * Log Resources
 * Dynamic resources for accessing task execution logs
 */

import { ForgeClient } from '../lib/forge-client.js';

export function registerLogResources(server: any, client: ForgeClient) {
  // Resource: forge://logs/process/{processId}
  server.addResourceTemplate({
    uriTemplate: 'forge://logs/process/{processId}',
    name: 'Execution Process Logs',
    description: 'Get logs for a specific execution process',
    mimeType: 'text/plain',
    arguments: [{
      name: 'processId',
      description: 'Execution process UUID',
      required: true
    }],
    async load({ processId }: any) {
      const process: any = await client.getExecutionProcess(processId);

      // Extract logs from process
      const logs = process.logs || process.output || 'No logs available';

      return {
        text: typeof logs === 'string' ? logs : JSON.stringify(logs, null, 2)
      };
    }
  });

  // Resource: forge://logs/attempt/{attemptId}
  server.addResourceTemplate({
    uriTemplate: 'forge://logs/attempt/{attemptId}',
    name: 'Task Attempt Logs',
    description: 'Get all logs for a task attempt (all execution processes)',
    mimeType: 'text/plain',
    arguments: [{
      name: 'attemptId',
      description: 'Task attempt UUID',
      required: true
    }],
    async load({ attemptId }: any) {
      const processes: any = await client.listExecutionProcesses(attemptId, false);

      if (!processes || processes.length === 0) {
        return { text: 'No execution processes found for this task attempt.' };
      }

      // Combine logs from all processes
      let combinedLogs = `Task Attempt Logs (${processes.length} process(es)):\n\n`;

      for (const proc of processes) {
        combinedLogs += `=== Process ${proc.id} (${proc.status}) ===\n`;
        combinedLogs += proc.logs || proc.output || 'No logs\n';
        combinedLogs += '\n\n';
      }

      return { text: combinedLogs };
    }
  });
}
