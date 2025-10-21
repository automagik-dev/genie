/**
 * Task Management Tools
 * Category 3: CRUD operations for tasks
 */

import { z } from 'zod';
import { ForgeClient } from '../lib/forge-client.js';

export function registerTaskTools(server: any, client: ForgeClient) {
  // Tool: forge_list_tasks
  server.addTool({
    name: 'forge_list_tasks',
    description: 'List all tasks in a project. Tasks represent work items that can be executed by AI agents.',
    parameters: z.object({
      project_id: z.string().describe('Project UUID')
    }),
    annotations: {
      readOnlyHint: true
    },
    execute: async (args: any, { log }: any) => {
      log.info(`Listing tasks for project: ${args.project_id}...`);
      const tasks: any = await client.listTasks(args.project_id);

      if (!tasks || tasks.length === 0) {
        return `No tasks found in project ${args.project_id}. Create a task with forge_create_task.`;
      }

      return `Found ${tasks.length} task(s):\n${JSON.stringify(tasks, null, 2)}`;
    }
  });

  // Tool: forge_create_task
  server.addTool({
    name: 'forge_create_task',
    description: 'Create a new task (not started). Use forge_create_and_start_task to create and start in one operation.',
    parameters: z.object({
      project_id: z.string().describe('Project UUID'),
      title: z.string().describe('Task title (e.g., "Fix login bug")'),
      description: z.string().optional().describe('Detailed task description for AI agent')
    }),
    execute: async (args: any, { log }: any) => {
      log.info(`Creating task in project ${args.project_id}: "${args.title}"...`);
      const task: any = await client.createTask(args.project_id, {
        title: args.title,
        description: args.description
      });

      log.info(`Task created: ${task.id}`);
      return `Task created successfully:\n${JSON.stringify(task, null, 2)}`;
    }
  });

  // Tool: forge_create_and_start_task
  server.addTool({
    name: 'forge_create_and_start_task',
    description: 'Create a task AND immediately start AI execution (all-in-one). Faster than creating and starting separately. Spawns an executor to work on the task.',
    parameters: z.object({
      project_id: z.string().describe('Project UUID'),
      title: z.string().describe('Task title'),
      description: z.string().optional().describe('Detailed task description'),
      executor: z.enum(['CLAUDE_CODE', 'CODEX', 'GEMINI', 'CURSOR', 'OPENCODE']).describe('AI executor to use (check available with forge_list_executor_profiles)'),
      base_branch: z.string().describe('Git base branch (e.g., "main")')
    }),
    execute: async (args: any, { log, reportProgress }: any) => {
      log.info(`Creating and starting task in project ${args.project_id}: "${args.title}"...`);
      await reportProgress({ progress: 1, total: 3 });

      const attempt: any = await client.createAndStartTask(args.project_id, {
        title: args.title,
        description: args.description,
        executor: args.executor,
        base_branch: args.base_branch
      });

      await reportProgress({ progress: 2, total: 3 });
      log.info(`Task attempt started: ${attempt.id}`);
      await reportProgress({ progress: 3, total: 3 });

      return `Task created and execution started:\n${JSON.stringify(attempt, null, 2)}\n\nUse forge_get_task_attempt to monitor progress.`;
    }
  });

  // Tool: forge_get_task
  server.addTool({
    name: 'forge_get_task',
    description: 'Get detailed information about a specific task including attempt status.',
    parameters: z.object({
      project_id: z.string().describe('Project UUID'),
      task_id: z.string().describe('Task UUID')
    }),
    annotations: {
      readOnlyHint: true
    },
    execute: async (args: any, { log }: any) => {
      log.info(`Fetching task: ${args.task_id}...`);
      const task = await client.getTask(args.project_id, args.task_id);

      return `Task Details:\n${JSON.stringify(task, null, 2)}`;
    }
  });

  // Tool: forge_update_task
  server.addTool({
    name: 'forge_update_task',
    description: 'Update task details (title, description, status, images).',
    parameters: z.object({
      project_id: z.string().describe('Project UUID'),
      task_id: z.string().describe('Task UUID'),
      title: z.string().optional().describe('New task title'),
      description: z.string().optional().describe('New task description'),
      status: z.enum(['todo', 'inprogress', 'inreview', 'done', 'cancelled']).optional().describe('New task status')
    }),
    execute: async (args: any, { log }: any) => {
      log.info(`Updating task: ${args.task_id}...`);
      const { project_id, task_id, ...updates } = args;
      const task = await client.updateTask(project_id, task_id, updates);

      log.info('Task updated successfully');
      return `Task updated:\n${JSON.stringify(task, null, 2)}`;
    }
  });

  // Tool: forge_delete_task
  server.addTool({
    name: 'forge_delete_task',
    description: 'Delete a task (async cleanup happens in background). WARNING: This action cannot be undone.',
    parameters: z.object({
      project_id: z.string().describe('Project UUID'),
      task_id: z.string().describe('Task UUID')
    }),
    execute: async (args: any, { log }: any) => {
      log.warn(`Deleting task: ${args.task_id}...`);
      await client.deleteTask(args.project_id, args.task_id);

      log.info('Task deletion initiated (background cleanup)');
      return `Task ${args.task_id} deletion started. Cleanup happens in background.`;
    }
  });
}
