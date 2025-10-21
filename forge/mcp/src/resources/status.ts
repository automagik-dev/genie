/**
 * Status Resources
 * Dynamic resources for accessing status information
 */

import { ForgeClient } from '../lib/forge-client.js';

export function registerStatusResources(server: any, client: ForgeClient) {
  // Resource: forge://status/attempt/{attemptId}
  server.addResourceTemplate({
    uriTemplate: 'forge://status/attempt/{attemptId}',
    name: 'Task Attempt Status',
    description: 'Get current status and details for a task attempt',
    mimeType: 'application/json',
    arguments: [{
      name: 'attemptId',
      description: 'Task attempt UUID',
      required: true
    }],
    async load({ attemptId }: any) {
      const attempt = await client.getTaskAttempt(attemptId);

      return {
        text: JSON.stringify(attempt, null, 2)
      };
    }
  });

  // Resource: forge://status/branch/{attemptId}
  server.addResourceTemplate({
    uriTemplate: 'forge://status/branch/{attemptId}',
    name: 'Task Attempt Branch Status',
    description: 'Get git branch status for a task attempt',
    mimeType: 'application/json',
    arguments: [{
      name: 'attemptId',
      description: 'Task attempt UUID',
      required: true
    }],
    async load({ attemptId }: any) {
      const status = await client.getTaskAttemptBranchStatus(attemptId);

      return {
        text: JSON.stringify(status, null, 2)
      };
    }
  });

  // Resource: forge://status/project/{projectId}
  server.addResourceTemplate({
    uriTemplate: 'forge://status/project/{projectId}',
    name: 'Project Status',
    description: 'Get project details including all tasks',
    mimeType: 'application/json',
    arguments: [{
      name: 'projectId',
      description: 'Project UUID',
      required: true
    }],
    async load({ projectId }: any) {
      const project: any = await client.getProject(projectId);
      const tasks: any = await client.listTasks(projectId);

      return {
        text: JSON.stringify({
          project,
          tasks,
          task_count: tasks.length
        }, null, 2)
      };
    }
  });
}
