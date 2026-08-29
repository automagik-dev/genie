import type { OrcaOrchestrationAdapter } from '../../src/lib/orca-orchestration-adapter';
import { createOrcaOrchestrationAdapter } from '../../src/lib/orca-orchestration-adapter';
import { createOrcaPluginRuntime } from './orca-runtime';

export const ORCA_RUN_LIST_COMMAND = 'genie.orca.run-list';

interface OrcaPluginActivationContext {
  commands: {
    register(commandId: string, handler: (args?: unknown) => Promise<unknown>): void;
  };
}

export function createOrcaPluginEntrypoint(
  adapter: OrcaOrchestrationAdapter = createOrcaOrchestrationAdapter(),
): (context: OrcaPluginActivationContext) => Promise<void> {
  const runtime = createOrcaPluginRuntime(adapter);
  return async (context) => {
    context.commands.register(ORCA_RUN_LIST_COMMAND, () => runtime.execute({ operation: 'run-list', limit: 100 }));
  };
}

export default createOrcaPluginEntrypoint();
