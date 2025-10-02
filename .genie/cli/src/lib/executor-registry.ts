import { loadExecutors, DEFAULT_EXECUTOR_KEY } from '../executors';
import type { Executor } from '../executors/types';

export const EXECUTORS: Record<string, Executor> = loadExecutors();

if (!EXECUTORS[DEFAULT_EXECUTOR_KEY]) {
  const available = Object.keys(EXECUTORS).join(', ') || 'none';
  throw new Error(`Default executor '${DEFAULT_EXECUTOR_KEY}' not found. Available executors: ${available}`);
}

export { DEFAULT_EXECUTOR_KEY };
