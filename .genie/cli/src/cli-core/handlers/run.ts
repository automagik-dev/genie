import type { Handler, HandlerContext } from '../context';
import type { ParsedCommand } from '../types';
import { resolveAgentIdentifier, loadAgentSpec } from '../../lib/agent-resolver';
import { generateSessionName } from '../../session-store';
import { createForgeExecutor } from '../../lib/forge-executor';
import { describeForgeError, FORGE_RECOVERY_HINT } from '../../lib/forge-helpers';

export function createRunHandler(ctx: HandlerContext): Handler {
  return async (parsed: ParsedCommand) => {
    const [agentName, ...promptParts] = parsed.commandArgs;
    if (!agentName) {
      throw new Error('Usage: genie run <agent> "<prompt>"');
    }

    const prompt = promptParts.join(' ').trim();
    const resolvedAgentName = resolveAgentIdentifier(agentName);
    const agentSpec = loadAgentSpec(resolvedAgentName);
    const agentGenie = agentSpec.meta?.genie || {};

    const { executorKey, executorVariant, modeName } = resolveExecutionSelection(ctx.config, parsed, agentGenie);

    const forgeExecutor = createForgeExecutor();
    try {
      await forgeExecutor.syncProfiles(ctx.config.forge?.executors);
    } catch (error) {
      const reason = describeForgeError(error);
      ctx.recordRuntimeWarning(`Forge sync failed: ${reason}`);
      throw new Error(`Forge backend unavailable while starting a session. ${FORGE_RECOVERY_HINT}`);
    }

    let attemptId: string;
    try {
      attemptId = await forgeExecutor.createSession({
        agentName: resolvedAgentName,
        prompt,
        executorKey,
        executorVariant,
        executionMode: modeName
      });
    } catch (error) {
      const reason = describeForgeError(error);
      ctx.recordRuntimeWarning(`Forge session creation failed: ${reason}`);
      throw new Error(`Forge backend rejected session creation. ${FORGE_RECOVERY_HINT}`);
    }

    const sessionName = parsed.options.name || generateSessionName(resolvedAgentName);
    const now = new Date().toISOString();

    const store = ctx.sessionService.load({ onWarning: ctx.recordRuntimeWarning });
    store.sessions[sessionName] = {
      agent: resolvedAgentName,
      name: sessionName,
      executor: executorKey,
      executorVariant,
      status: 'running',
      created: now,
      lastUsed: now,
      lastPrompt: prompt.slice(0, 200),
      mode: modeName,
      sessionId: attemptId,
      background: parsed.options.background
    };
    await ctx.sessionService.save(store);

    process.stdout.write(`✓ Started ${resolvedAgentName} via Forge (executor=${executorKey}/${executorVariant})\n`);
    process.stdout.write(`  Session name: ${sessionName}\n`);
    process.stdout.write(`  View: genie view ${sessionName}\n`);
  };
}

function resolveExecutionSelection(
  config: HandlerContext['config'],
  parsed: ParsedCommand,
  agentGenie: Record<string, any>
): { executorKey: string; executorVariant: string; modeName: string } {
  let executor = (config.defaults?.executor || 'opencode').toLowerCase();
  let variant = (config.defaults?.executorVariant || 'DEFAULT').toUpperCase();
  let modeName = parsed.options.mode?.trim() || config.defaults?.executionMode || 'default';

  if (parsed.options.mode) {
    const modeConfig = config.executionModes?.[parsed.options.mode];
    if (!modeConfig) {
      throw new Error(`Execution mode '${parsed.options.mode}' not found.`);
    }
    if (modeConfig.executor) executor = modeConfig.executor.toLowerCase();
    if (modeConfig.executorVariant) variant = modeConfig.executorVariant.toUpperCase();
    modeName = parsed.options.mode;
  }

  if (typeof agentGenie.executionMode === 'string' && agentGenie.executionMode.trim().length) {
    modeName = agentGenie.executionMode.trim();
  }

  if (typeof agentGenie.executor === 'string' && agentGenie.executor.trim().length) {
    executor = agentGenie.executor.trim().toLowerCase();
  }

  const agentVariant =
    agentGenie.executorProfile || agentGenie.executor_variant || agentGenie.executorVariant || agentGenie.variant;
  if (typeof agentVariant === 'string' && agentVariant.trim().length) {
    variant = agentVariant.trim().toUpperCase();
  }

  if (!variant.length) variant = 'DEFAULT';

  return { executorKey: executor, executorVariant: variant, modeName };
}
