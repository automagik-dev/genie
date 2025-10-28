import type { Handler, HandlerContext } from '../context';
import type { ParsedCommand } from '../types';
import { resolveAgentIdentifier, loadAgentSpec } from '../../lib/agent-resolver';
import { generateSessionName } from '../../session-store';
import { createForgeExecutor } from '../../lib/forge-executor';
import { describeForgeError, FORGE_RECOVERY_HINT } from '../../lib/forge-helpers';
import { ensureForgeRunning, waitForTaskCompletion, type RunResult } from '../../lib/headless-helpers';
import { normalizeExecutorKey, normalizeExecutorKeyOrDefault } from '../../lib/executor-registry';
import { checkExecutorAuth, promptExecutorLogin, type ExecutorId } from '../../lib/executor-auth';

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

    // Detect output mode
    // Default: Foreground execution with live output (wait for completion)
    // --background: Start task and exit immediately (return Forge URL)
    // --raw: Foreground execution, output raw text only
    // --quiet: Foreground execution, suppress startup messages
    const isBackground = parsed.options.background;
    const isRawOutput = parsed.options.raw;
    const isQuiet = parsed.options.quiet;
    const isForeground = !isBackground; // Default is foreground

    // Check if executor is authenticated
    if (isExecutorAuthRequired(executorKey)) {
      const isAuthenticated = await checkExecutorAuth(executorKey as ExecutorId);
      if (!isAuthenticated) {
        try {
          await promptExecutorLogin(executorKey as ExecutorId);
        } catch (error) {
          throw new Error(`Authentication required for ${executorKey}. Please configure it and try again.`);
        }
      }
    }

    // Ensure Forge is running (silent if quiet mode)
    if (isForeground) {
      await ensureForgeRunning(isQuiet);
    }

    const forgeExecutor = createForgeExecutor();
    try {
      // Skip config.forge.executors - incompatible format, Forge loads from its own config
      await forgeExecutor.syncProfiles();
    } catch (error) {
      const reason = describeForgeError(error);
      ctx.recordRuntimeWarning(`Forge sync failed: ${reason}`);
      console.error(`[DEBUG] syncProfiles error:`, error);
      throw new Error(`Forge backend unavailable while starting a session. ${FORGE_RECOVERY_HINT}\nReason: ${reason}`);
    }

    const startTime = Date.now();
    let sessionResult;
    try {
      sessionResult = await forgeExecutor.createSession({
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
      sessionId: sessionResult.attemptId,
      background: parsed.options.background
    };
    await ctx.sessionService.save(store);

    // Foreground mode (DEFAULT): wait for completion and show output
    if (isForeground) {
      if (!isQuiet) {
        const executorSummary = [executorKey, executorVariant].filter(Boolean).join('/');
        const modelSuffix = model ? `, model=${model}` : '';
        process.stdout.write(`✓ Running ${resolvedAgentName} (executor=${executorSummary}${modelSuffix})\n`);
        process.stdout.write(`  Session: ${sessionName}\n`);
        process.stdout.write(`  Waiting for completion...\n\n`);
      }

      const result = await waitForTaskCompletion(sessionResult.attemptId, forgeExecutor);
      const duration = Date.now() - startTime;

      // Output result based on mode
      if (isRawOutput) {
        // Raw text output only (no JSON wrapper)
        process.stdout.write(result.output + '\n');
      } else {
        // Default: show output with metadata
        if (!isQuiet) {
          process.stdout.write(`\n${'='.repeat(60)}\n`);
          process.stdout.write(`📊 ${resolvedAgentName} Output\n`);
          process.stdout.write(`${'='.repeat(60)}\n\n`);
        }
        process.stdout.write(result.output + '\n');
        if (!isQuiet) {
          process.stdout.write(`\n${'='.repeat(60)}\n`);
          process.stdout.write(`Status: ${result.status}\n`);
          process.stdout.write(`Duration: ${(duration / 1000).toFixed(2)}s\n`);
          process.stdout.write(`${'='.repeat(60)}\n`);
        }
      }

      // Exit with appropriate code
      process.exitCode = result.status === 'completed' ? 0 : 1;
      return;
    }

    // Background mode: just show Forge URL and exit
    const executorSummary = [executorKey, executorVariant].filter(Boolean).join('/');
    const modelSuffix = model ? `, model=${model}` : '';
    process.stdout.write(`✓ Started ${resolvedAgentName} in background (executor=${executorSummary}${modelSuffix})\n`);
    process.stdout.write(`  Session name: ${sessionName}\n`);
    process.stdout.write(`  Forge URL: ${sessionResult.forgeUrl}\n`);
  };
}

function resolveExecutionSelection(
  config: HandlerContext['config'],
  parsed: ParsedCommand,
  agentGenie: Record<string, any>
): { executorKey: string; executorVariant: string; model?: string; modeName: string } {
  let executor = normalizeExecutorKeyOrDefault(config.defaults?.executor);
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
    executor = normalizeExecutorKey(agentGenie.executor) ?? executor;
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
    executor = normalizeExecutorKey(parsed.options.executor) ?? executor;
  }

  if (typeof parsed.options.model === 'string' && parsed.options.model.trim().length) {
    model = parsed.options.model.trim();
    const matchedVariant = findVariantForModel(config, executor, model);
    if (matchedVariant) {
      variant = matchedVariant;
    }
  }

  if (!variant.length) variant = 'DEFAULT';

  return { executorKey: normalizeExecutorKeyOrDefault(executor), executorVariant: variant, model, modeName };
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

/**
 * Check if executor requires authentication
 */
function isExecutorAuthRequired(executorKey: string): boolean {
  const authRequiredExecutors = ['OPENCODE', 'CLAUDE_CODE', 'CODEX', 'GEMINI'];
  return authRequiredExecutors.includes(executorKey.toUpperCase());
}
