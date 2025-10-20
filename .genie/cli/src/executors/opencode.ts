import type { Executor, ExecutorCommand } from './types';
import codexExecutor from './codex';

// Thin wrapper around codex executor until native Opencode integration is available.
// Allows `--executor opencode` to route through the same command surface while
// we stabilise Forge-based model selection.
const opencodeExecutor: Executor = {
  ...codexExecutor,
  defaults: {
    ...codexExecutor.defaults,
    exec: {
      ...codexExecutor.defaults.exec,
      model: codexExecutor.defaults.exec?.model || 'opencode',
    }
  },
  buildRunCommand: (params: { config?: Record<string, any>; prompt?: string; agentPath?: string }): ExecutorCommand => {
    return codexExecutor.buildRunCommand(params);
  },
  buildResumeCommand: (params: { config?: Record<string, any>; sessionId?: string; prompt?: string }): ExecutorCommand => {
    return codexExecutor.buildResumeCommand(params);
  }
};

export default opencodeExecutor;
