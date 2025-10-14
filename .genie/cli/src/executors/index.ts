import fs from 'fs';
import path from 'path';
import type { Executor } from './types';

export type { Executor } from './types';
export const DEFAULT_EXECUTOR_KEY = 'claude';

export function loadExecutors(): Record<string, Executor> {
  const executors: Record<string, Executor> = {};
  const currentDir = __dirname;
  let files: string[] = [];
  try {
    files = fs.readdirSync(currentDir);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[genie] Failed to read executors directory: ${message}`);
    return executors;
  }

  files
    .filter((file) => file.endsWith('.js') && !file.startsWith('types') && file !== 'index.js')
    .forEach((file) => {
      const executorName = path.basename(file, '.js');
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
        const mod = require(path.join(currentDir, file));
        const executor: Executor = mod.default || mod;
        if (executor && typeof executor === 'object') {
          executors[executorName] = executor;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[genie] Failed to load executor '${executorName}': ${message}`);
      }
    });

  return executors;
}
