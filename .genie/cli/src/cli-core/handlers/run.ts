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

    const { executorKey, executorVariant, model, modeName } = resolveExecutionSelection(ctx.config, parsed, agentGenie);

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
        executionMode: modeName,
        model
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
      model: model || undefined,
      status: 'running',
      created: now,
      lastUsed: now,
      lastPrompt: prompt.slice(0, 200),
      mode: modeName,
      sessionId: attemptId,
      background: parsed.options.background
    };
    await ctx.sessionService.save(store);

    const executorSummary = [executorKey, executorVariant].filter(Boolean).join('/');
    const modelSuffix = model ? `, model=${model}` : '';
    process.stdout.write(`✓ Started ${resolvedAgentName} via Forge (executor=${executorSummary}${modelSuffix})\n`);
    process.stdout.write(`  Session name: ${sessionName}\n`);
    process.stdout.write(`  View: genie view ${sessionName}\n`);
  };
}

function resolveExecutionSelection(
  config: HandlerContext['config'],
  parsed: ParsedCommand,
  agentGenie: Record<string, any>
): { executorKey: string; executorVariant: string; model?: string; modeName: string } {
  let executor = (config.defaults?.executor || 'opencode').trim().toLowerCase();
  let variant = (config.defaults?.executorVariant || 'DEFAULT').trim().toUpperCase();
  let model: string | undefined =
    typeof config.defaults?.model === 'string' ? config.defaults.model.trim() || undefined : undefined;

  let modeName = 'default';
  if (typeof config.defaults?.executionMode === 'string' && config.defaults.executionMode.trim().length) {
    modeName = config.defaults.executionMode.trim();
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

  if (typeof agentGenie.model === 'string' && agentGenie.model.trim().length) {
    model = agentGenie.model.trim();
  }

  if (typeof parsed.options.executor === 'string' && parsed.options.executor.trim().length) {
    executor = parsed.options.executor.trim().toLowerCase();
  }

  if (typeof parsed.options.model === 'string' && parsed.options.model.trim().length) {
    model = parsed.options.model.trim();
    const matchedVariant = findVariantForModel(config, executor, model);
    if (matchedVariant) {
      variant = matchedVariant;
    }
  }

  if (!variant.length) variant = 'DEFAULT';

  return { executorKey: executor, executorVariant: variant, model, modeName };
}

function findVariantForModel(
  config: HandlerContext['config'],
  executorKey: string,
  model: string
): string | null {
  const executors = config.forge?.executors;
  if (!executors) return null;

  const normalizedExecutor = executorKey.trim().toUpperCase();
  const executorProfiles = executors[normalizedExecutor];
  if (!executorProfiles || typeof executorProfiles !== 'object') return null;

  const desiredModel = model.trim();
  for (const [variantName, profileSpec] of Object.entries(executorProfiles)) {
    if (!profileSpec || typeof profileSpec !== 'object') continue;
    for (const profileKey of Object.keys(profileSpec)) {
      const profileConfig: any = (profileSpec as any)[profileKey];
      if (profileConfig && typeof profileConfig === 'object' && typeof profileConfig.model === 'string') {
        if (profileConfig.model.trim() === desiredModel) {
          return variantName.trim().toUpperCase();
        }
      }
    }
  }
  return null;
}
