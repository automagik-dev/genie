/**
 * Task Attempt Tools
 * Category 4: AI agent execution orchestration
 */

import { z } from 'zod';
import { ForgeClient } from '../lib/forge-client.js';

export function registerTaskAttemptTools(server: any, client: ForgeClient) {
  // Tool: forge_list_task_attempts
  server.addTool({
    name: 'forge_list_task_attempts',
    description: 'List task attempts (AI execution instances). Optionally filter by task ID.',
    parameters: z.object({
      task_id: z.string().optional().describe('Optional: Filter by task UUID')
    }),
    annotations: {
      readOnlyHint: true
    },
    execute: async (args: any, { log }: any) => {
      log.info('Listing task attempts...');
      const attempts: any = await client.listTaskAttempts(args.task_id);

      if (!attempts || attempts.length === 0) {
        return 'No task attempts found.';
      }

      return `Found ${attempts.length} task attempt(s):\n${JSON.stringify(attempts, null, 2)}`;
    }
  });

  // Tool: forge_create_task_attempt
  server.addTool({
    name: 'forge_create_task_attempt',
    description: 'Create a new task attempt (start AI execution). This spawns the selected executor to work on an existing task.',
    parameters: z.object({
      task_id: z.string().describe('Task UUID to execute'),
      executor: z.enum(['CLAUDE_CODE', 'CODEX', 'GEMINI', 'CURSOR', 'OPENCODE']).describe('AI executor to use'),
      base_branch: z.string().describe('Git base branch (e.g., "main")'),
      variant: z.string().optional().describe('Optional executor variant')
    }),
    execute: async (args: any, { log, reportProgress }: any) => {
      log.info(`Starting task attempt for task ${args.task_id} with ${args.executor}...`);
      await reportProgress({ progress: 1, total: 2 });

      const attempt: any = await client.createTaskAttempt({
        task_id: args.task_id,
        executor: args.executor,
        base_branch: args.base_branch,
        variant: args.variant
      });

      await reportProgress({ progress: 2, total: 2 });
      log.info(`Task attempt started: ${attempt.id}`);

      return `Task attempt created and started:\n${JSON.stringify(attempt, null, 2)}`;
    }
  });

  // Tool: forge_get_task_attempt
  server.addTool({
    name: 'forge_get_task_attempt',
    description: 'Get detailed information about a task attempt including execution status, branch info, and process details.',
    parameters: z.object({
      attempt_id: z.string().describe('Task attempt UUID')
    }),
    annotations: {
      readOnlyHint: true
    },
    execute: async (args: any, { log }: any) => {
      log.info(`Fetching task attempt: ${args.attempt_id}...`);
      const attempt = await client.getTaskAttempt(args.attempt_id);

      return `Task Attempt Details:\n${JSON.stringify(attempt, null, 2)}`;
    }
  });

  // Tool: forge_follow_up_task_attempt
  server.addTool({
    name: 'forge_follow_up_task_attempt',
    description: 'Send follow-up prompt to running/paused AI execution. The executor will use this to continue work.',
    parameters: z.object({
      attempt_id: z.string().describe('Task attempt UUID'),
      prompt: z.string().describe('Follow-up message for AI agent')
    }),
    execute: async (args: any, { log }: any) => {
      log.info(`Sending follow-up to task attempt ${args.attempt_id}...`);
      const process = await client.followUpTaskAttempt(args.attempt_id, args.prompt);

      log.info('Follow-up sent successfully');
      return `Follow-up sent. New execution process:\n${JSON.stringify(process, null, 2)}`;
    }
  });

  // Tool: forge_stop_task_attempt
  server.addTool({
    name: 'forge_stop_task_attempt',
    description: 'Stop execution process for a task attempt. Halts AI agent work.',
    parameters: z.object({
      attempt_id: z.string().describe('Task attempt UUID')
    }),
    execute: async (args: any, { log }: any) => {
      log.warn(`Stopping task attempt: ${args.attempt_id}...`);
      await client.stopTaskAttemptExecution(args.attempt_id);

      log.info('Task attempt stopped');
      return `Task attempt ${args.attempt_id} stopped successfully.`;
    }
  });

  // Tool: forge_get_branch_status
  server.addTool({
    name: 'forge_get_branch_status',
    description: 'Get git branch status for task attempt. Shows commits ahead/behind, merge conflicts, etc.',
    parameters: z.object({
      attempt_id: z.string().describe('Task attempt UUID')
    }),
    annotations: {
      readOnlyHint: true
    },
    execute: async (args: any, { log }: any) => {
      log.info(`Fetching branch status for task attempt: ${args.attempt_id}...`);
      const status = await client.getTaskAttemptBranchStatus(args.attempt_id);

      return `Branch Status:\n${JSON.stringify(status, null, 2)}`;
    }
  });

  // Tool: forge_rebase_task_attempt
  server.addTool({
    name: 'forge_rebase_task_attempt',
    description: 'Rebase task attempt branch onto new base branch. Handles merge conflicts automatically if possible.',
    parameters: z.object({
      attempt_id: z.string().describe('Task attempt UUID'),
      base_branch: z.string().describe('New base branch to rebase onto')
    }),
    execute: async (args: any, { log, reportProgress }: any) => {
      log.info(`Rebasing task attempt ${args.attempt_id} onto ${args.base_branch}...`);
      await reportProgress({ progress: 1, total: 2 });

      const status = await client.rebaseTaskAttempt(args.attempt_id, args.base_branch);

      await reportProgress({ progress: 2, total: 2 });
      log.info('Rebase completed');

      return `Rebase completed:\n${JSON.stringify(status, null, 2)}`;
    }
  });

  // Tool: forge_merge_task_attempt
  server.addTool({
    name: 'forge_merge_task_attempt',
    description: 'Merge task attempt branch to target branch.',
    parameters: z.object({
      attempt_id: z.string().describe('Task attempt UUID')
    }),
    execute: async (args: any, { log, reportProgress }: any) => {
      log.info(`Merging task attempt: ${args.attempt_id}...`);
      await reportProgress({ progress: 1, total: 2 });

      const result = await client.mergeTaskAttempt(args.attempt_id);

      await reportProgress({ progress: 2, total: 2 });
      log.info('Merge completed');

      return `Merge completed:\n${JSON.stringify(result, null, 2)}`;
    }
  });

  // Tool: forge_push_branch
  server.addTool({
    name: 'forge_push_branch',
    description: 'Push task attempt branch to GitHub remote.',
    parameters: z.object({
      attempt_id: z.string().describe('Task attempt UUID')
    }),
    execute: async (args: any, { log }: any) => {
      log.info(`Pushing branch for task attempt: ${args.attempt_id}...`);
      await client.pushTaskAttemptBranch(args.attempt_id);

      log.info('Branch pushed successfully');
      return `Branch pushed to GitHub for task attempt ${args.attempt_id}.`;
    }
  });

  // Tool: forge_create_pull_request
  server.addTool({
    name: 'forge_create_pull_request',
    description: 'Create GitHub pull request for task attempt branch.',
    parameters: z.object({
      attempt_id: z.string().describe('Task attempt UUID'),
      title: z.string().describe('PR title'),
      body: z.string().optional().describe('PR description/body'),
      target_branch: z.string().optional().describe('Target branch (defaults to base branch)')
    }),
    execute: async (args: any, { log, reportProgress }: any) => {
      log.info(`Creating PR for task attempt: ${args.attempt_id}...`);
      await reportProgress({ progress: 1, total: 3 });

      const pr: any = await client.createTaskAttemptPullRequest(args.attempt_id, {
        title: args.title,
        body: args.body,
        target_branch: args.target_branch
      });

      await reportProgress({ progress: 3, total: 3 });
      log.info(`PR created: ${pr.url}`);

      return `Pull request created:\n${JSON.stringify(pr, null, 2)}`;
    }
  });

  // Tool: forge_attach_existing_pr
  server.addTool({
    name: 'forge_attach_existing_pr',
    description: 'Attach existing GitHub PR to task attempt. Links task execution to ongoing PR.',
    parameters: z.object({
      attempt_id: z.string().describe('Task attempt UUID'),
      pr_number: z.number().describe('GitHub PR number')
    }),
    execute: async (args: any, { log }: any) => {
      log.info(`Attaching PR #${args.pr_number} to task attempt ${args.attempt_id}...`);
      await client.attachExistingPullRequest(args.attempt_id, args.pr_number);

      log.info('PR attached successfully');
      return `PR #${args.pr_number} attached to task attempt ${args.attempt_id}.`;
    }
  });

  // Tool: forge_change_target_branch
  server.addTool({
    name: 'forge_change_target_branch',
    description: 'Change target branch for task attempt. Useful if target was deleted or needs to change.',
    parameters: z.object({
      attempt_id: z.string().describe('Task attempt UUID'),
      target_branch: z.string().describe('New target branch name')
    }),
    execute: async (args: any, { log }: any) => {
      log.info(`Changing target branch for task attempt ${args.attempt_id} to ${args.target_branch}...`);
      await client.changeTaskAttemptTargetBranch(args.attempt_id, args.target_branch);

      log.info('Target branch changed');
      return `Target branch changed to ${args.target_branch} for task attempt ${args.attempt_id}.`;
    }
  });

  // Tool: forge_replace_process
  server.addTool({
    name: 'forge_replace_process',
    description: 'Replace the execution process and send new prompt. Use when you want to switch executors or restart with new instructions.',
    parameters: z.object({
      attempt_id: z.string().describe('Task attempt UUID'),
      executor: z.enum(['CLAUDE_CODE', 'CODEX', 'GEMINI', 'CURSOR', 'OPENCODE']).describe('New executor to use'),
      prompt: z.string().describe('New prompt for executor')
    }),
    execute: async (args: any, { log }: any) => {
      log.info(`Replacing process for task attempt ${args.attempt_id} with ${args.executor}...`);
      const process = await client.replaceTaskAttemptProcess(args.attempt_id, {
        executor: args.executor,
        prompt: args.prompt
      });

      log.info('Process replaced successfully');
      return `Process replaced:\n${JSON.stringify(process, null, 2)}`;
    }
  });

  // Tool: forge_list_execution_processes
  server.addTool({
    name: 'forge_list_execution_processes',
    description: 'List execution processes for a task attempt. Shows all process runs with logs and status.',
    parameters: z.object({
      attempt_id: z.string().describe('Task attempt UUID'),
      show_soft_deleted: z.boolean().optional().default(false).describe('Include soft-deleted processes')
    }),
    annotations: {
      readOnlyHint: true
    },
    execute: async (args: any, { log }: any) => {
      log.info(`Listing execution processes for task attempt: ${args.attempt_id}...`);
      const processes: any = await client.listExecutionProcesses(args.attempt_id, args.show_soft_deleted);

      if (!processes || processes.length === 0) {
        return 'No execution processes found.';
      }

      return `Found ${processes.length} execution process(es):\n${JSON.stringify(processes, null, 2)}`;
    }
  });

  // Tool: forge_get_execution_process
  server.addTool({
    name: 'forge_get_execution_process',
    description: 'Get detailed information about a specific execution process including logs and output.',
    parameters: z.object({
      process_id: z.string().describe('Execution process UUID')
    }),
    annotations: {
      readOnlyHint: true
    },
    execute: async (args: any, { log }: any) => {
      log.info(`Fetching execution process: ${args.process_id}...`);
      const process = await client.getExecutionProcess(args.process_id);

      return `Execution Process Details:\n${JSON.stringify(process, null, 2)}`;
    }
  });

  // Tool: forge_stop_execution_process
  server.addTool({
    name: 'forge_stop_execution_process',
    description: 'Stop a specific execution process. Sends SIGTERM to running process.',
    parameters: z.object({
      process_id: z.string().describe('Execution process UUID')
    }),
    execute: async (args: any, { log }: any) => {
      log.warn(`Stopping execution process: ${args.process_id}...`);
      await client.stopExecutionProcess(args.process_id);

      log.info('Execution process stopped');
      return `Execution process ${args.process_id} stopped successfully.`;
    }
  });
}
