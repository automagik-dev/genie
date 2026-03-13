/**
 * Task backend abstraction.
 *
 * Local backend (.genie tracked) for task management.
 */

import * as local from './local-tasks.js';

export interface TaskSummary {
  id: string;
  title: string;
  status: string;
  description?: string;
  blockedBy?: string[];
}

export interface QueueStatus {
  ready: string[];
  blocked: string[];
}

export interface UpdateTaskOptions {
  status?: string;
  title?: string;
  blockedBy?: string[];
  addBlockedBy?: string[];
}

export interface TaskBackend {
  kind: 'local';
  create(title: string, options?: { description?: string; parent?: string }): Promise<TaskSummary>;
  get(id: string): Promise<TaskSummary | null>;
  claim(id: string): Promise<boolean>;
  markDone(id: string): Promise<boolean>;
  update(id: string, options: UpdateTaskOptions): Promise<TaskSummary | null>;
  queue(): Promise<QueueStatus>;
}

export function getBackend(repoPath: string): TaskBackend {
  return {
    kind: 'local',
    async create(title, options) {
      const task = await local.createWishTask(repoPath, title, {
        description: options?.description,
        parent: options?.parent,
      });
      return {
        id: task.id,
        title: task.title,
        status: task.status,
        description: task.description,
        blockedBy: task.blockedBy,
      };
    },
    async get(id) {
      const task = await local.getTask(repoPath, id);
      return task
        ? {
            id: task.id,
            title: task.title,
            status: task.status,
            description: task.description,
            blockedBy: task.blockedBy,
          }
        : null;
    },
    async claim(id) {
      return local.claimTask(repoPath, id);
    },
    async markDone(id) {
      return local.markDone(repoPath, id);
    },
    async update(id, options) {
      const task = await local.updateTask(repoPath, id, {
        status: options.status as local.LocalTaskStatus | undefined,
        title: options.title,
        blockedBy: options.blockedBy,
        addBlockedBy: options.addBlockedBy,
      });
      return task
        ? {
            id: task.id,
            title: task.title,
            status: task.status,
            description: task.description,
            blockedBy: task.blockedBy,
          }
        : null;
    },
    async queue() {
      return local.getQueue(repoPath);
    },
  };
}
