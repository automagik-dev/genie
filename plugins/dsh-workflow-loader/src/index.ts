/**
 * The LOADER row: `@automagik/genie-dsh-workflow-loader`.
 *
 * One model-facing tool that runs a saved workflow **by name** from a catalog
 * repository, without the script passing through the model's context. The
 * engine (`ctx.workflowEngine`) executes it; this row owns discovery, the
 * dialect transform, and result delivery.
 *
 * Why a plain object rather than `defineTool` from `@deepseek-ai/dsh-tools`: a
 * profile-installed plugin cannot resolve the harness's own packages, and
 * `defineTool` is a validation helper over exactly this shape (`parameters` as
 * JSON Schema, `output.schema` plus `render`). `plugins/dsh-genie-board` takes
 * the same route for its rows.
 *
 * Tool results are pruned of `undefined` before they cross the boundary: the
 * harness snapshots a tool's value through its own walker and refuses the whole
 * call when one property holds `undefined`.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { CatalogError, catalogRoots, listWorkflows, resolveWorkflow } from './catalog';
import { type LoaderConfig, resolveLoaderConfig, schemaOf } from './config';
import { DialectError, scanUnsupported, stripDeferredOptions } from './dialect';
import { journalDirectory, previewValue, render, writeJournal } from './run';

export const name = 'genie-dsh-workflow-loader';
export const inject = ['tools'];
export const Config = schemaOf(resolveLoaderConfig);

interface ToolExec {
  agent?: { session?: { header?: { cwd?: string } } };
  signal?: AbortSignal;
}

interface ToolContext {
  tools: { register: (definition: unknown) => () => void };
  workflowEngine: {
    start: (request: {
      script: string;
      meta: unknown;
      args?: unknown;
      parent: unknown;
      signal?: AbortSignal;
    }) => {
      id: string;
      result: Promise<{ stopReason: string; agentsStarted: number; value?: unknown; error?: string }>;
      dispose: () => Promise<void>;
    };
  };
}

const DESCRIPTION = `Run a saved workflow from this repository's \`.claude/workflows\` catalog, by name, on DSH.

The workflow executes on the first-party workflow engine with the catalog script as its body — the script never passes through your context, so a 100 KB workflow costs the same as a small one. Use it when the user asks to run a saved workflow (council, docs-audit, wish, workfly, research-sweep, skill-intake, skill-audit-sweep, observability-review, pm-ledger-verify), or names one of those directly.

Everything the workflow needs arrives through \`args\`, so read the workflow's own \`whenToUse\` and args contract before calling (the catalog panel shows it, or read the file). The full return value is written to a journal file and the response carries a bounded projection plus that path.`;

/** The model-facing tool, built once per row. */
export function workflowRunTool(ctx: ToolContext, config: LoaderConfig) {
  return {
    name: config.toolName,
    description: DESCRIPTION,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        name: {
          type: 'string',
          description: 'The workflow name — the filename stem in `.claude/workflows`, e.g. "council".',
        },
        args: {
          type: 'object',
          additionalProperties: true,
          description:
            'The workflow arguments, exactly as the workflow documents them. Omit when it takes none; pass `{}` when it takes optional values.',
        },
        cwd: {
          type: 'string',
          description:
            'Optional repository root holding `.claude/workflows`. Defaults to the calling session’s working directory.',
        },
      },
      required: ['name'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          ok: { type: 'boolean' },
          name: { type: 'string' },
          agentsStarted: { type: 'number' },
          stoppedEffort: { type: 'number' },
          journalPath: { type: 'string' },
          truncated: { type: 'boolean' },
          preview: { type: 'string' },
        },
        required: ['ok', 'name', 'journalPath', 'preview'],
      },
      render: (
        _args: unknown,
        value: {
          ok?: boolean;
          name?: string;
          agentsStarted?: number;
          journalPath?: string;
          truncated?: boolean;
          preview?: string;
        },
      ) => {
        if (!value?.ok) return [{ type: 'text', text: `workflow "${value?.name ?? 'unknown'}" did not complete` }];
        const agents = value.agentsStarted ?? 0;
        const truncation = value.truncated
          ? `\n\n(This projection is bounded; the full return value is at ${value.journalPath}.)`
          : '';
        return [
          {
            type: 'text',
            text: `workflow "${value.name}" completed (${agents} agent${agents === 1 ? '' : 's'}).\nReturn value:\n${value.preview ?? ''}${truncation}`,
          },
        ];
      },
    },
    async execute(args: { name: string; args?: unknown; cwd?: string }, exec: ToolExec) {
      const parent = exec.agent;
      if (!parent) throw new Error(`${config.toolName} requires a calling agent`);
      const cwd = args.cwd ?? parent.session?.header?.cwd ?? process.cwd();
      const roots = catalogRoots(cwd, config.userRoot || join(homedir(), '.claude', 'workflows'));
      const workflow = resolveWorkflow(args.name, roots, config.allowShadowing);
      const diagnostics: string[] = [];
      const stripped = stripDeferredOptions(workflow.body, diagnostics);
      if (!stripped) {
        throw new Error(
          `${workflow.path} uses an \`agent()\` option this engine does not accept, so it cannot run unchanged: ${diagnostics.join('; ')}`,
        );
      }
      scanUnsupported(stripped.script);

      const startedAt = new Date().toISOString();
      const started = Date.now();
      const run = ctx.workflowEngine.start({
        script: stripped.script,
        meta: workflow.meta,
        args: args.args ?? {},
        parent,
        ...(exec.signal ? { signal: exec.signal } : {}),
      });
      try {
        const result = await run.result;
        if (result.stopReason !== 'completed') {
          throw new Error(
            `workflow "${workflow.name}" ${result.stopReason === 'cancelled' ? 'was cancelled' : `failed: ${result.error ?? 'unknown error'}`}`,
          );
        }
        const journalPath = writeJournal(journalDirectory(config.journalDir), {
          name: workflow.name,
          source: workflow.path,
          root: workflow.root,
          runId: run.id,
          agentsStarted: result.agentsStarted,
          stoppedEffort: stripped.removed,
          startedAt,
          durationMs: Date.now() - started,
          value: result.value,
        });
        const preview = previewValue(result.value, config.maxResultChars);
        return {
          ok: true,
          name: workflow.name,
          agentsStarted: result.agentsStarted,
          stoppedEffort: stripped.removed.length,
          journalPath,
          truncated: preview.truncated,
          preview: preview.text,
        };
      } finally {
        await run.dispose();
      }
    },
  };
}

export function apply(ctx: ToolContext, rawConfig?: unknown): () => void {
  const config = resolveLoaderConfig(rawConfig);
  return ctx.tools.register(workflowRunTool(ctx, config));
}

/** Exported for the catalog-routes half and for tests. */
export { catalogRoots, listWorkflows, CatalogError, DialectError, render };
