/**
 * Omni runtime-config resolver — merges the `omni` section of
 * `~/.genie/config.json` with environment overrides into one flat, typed
 * shape the runner and the approval handler both consume.
 *
 * Precedence: explicit env var > config value > built-in default.
 *
 * The single gate the whole feature hangs on is {@link isOmniApprovalEnabled}:
 * when it returns false the dispatcher never registers the `omni-approval`
 * handler and its output is byte-identical to a build with no Omni at all.
 */

import type { OmniConfig } from '../types/genie-config.js';
import { loadGenieConfig } from './genie-config.js';

// Ported verbatim from origin/v4:src/lib/omni-approval-handler.ts so remote
// operators keep the exact token/reaction vocabulary they trained their muscle
// memory on. `sim`/`nao` are Portuguese yes/no (the original omni deployment).
export const DEFAULT_APPROVE_TOKENS = ['y', 'yes', 'approve', 'sim'];
export const DEFAULT_DENY_TOKENS = ['n', 'no', 'deny', 'nao'];
export const DEFAULT_APPROVE_REACTIONS = ['\u{1F44D}', '\u{2705}', '\u{1F44C}']; // 👍 ✅ 👌
export const DEFAULT_DENY_REACTIONS = ['\u{1F44E}', '\u{274C}', '\u{1F6AB}']; // 👎 ❌ 🚫

const DEFAULT_NATS_URL = 'localhost:4222';
const DEFAULT_TOOL_MATCHER = '^(Bash|Write|Edit|NotebookEdit)$';
const DEFAULT_POLL_BUDGET_MS = 110_000;
const DEFAULT_POLL_INTERVAL_MS = 400;

/** Fully-resolved omni runtime config. `null`-free — every field has a value. */
export interface OmniRuntimeConfig {
  apiUrl?: string;
  apiKey?: string;
  natsUrl: string;
  instance?: string;
  approvalChat?: string;
  approveTokens: string[];
  denyTokens: string[];
  approveReactions: string[];
  denyReactions: string[];
  approvals: {
    enabled: boolean;
    toolMatcher: string;
    pollBudgetMs: number;
    pollIntervalMs: number;
  };
}

/** Split a comma/space-separated env list into trimmed, non-empty tokens. */
function parseList(raw: string | undefined): string[] | undefined {
  if (raw === undefined) return undefined;
  const items = raw
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return items.length > 0 ? items : undefined;
}

/** Interpret an env truthiness flag: `1`/`true`/`yes`/`on` (case-insensitive). */
function envFlag(raw: string | undefined): boolean | undefined {
  if (raw === undefined) return undefined;
  return /^(1|true|yes|on)$/i.test(raw.trim());
}

/**
 * Resolve the full omni runtime config from disk config + environment.
 *
 * The optional `config` lets callers that already loaded the genie config avoid
 * a second file read; omit it to load fresh.
 */
export async function resolveOmniRuntimeConfig(config?: { omni?: OmniConfig }): Promise<OmniRuntimeConfig> {
  const cfg = config ?? (await loadGenieConfig());
  const omni = cfg.omni;
  const appr = omni?.approvals;

  const enabled = envFlag(process.env.OMNI_APPROVALS_ENABLED) ?? appr?.enabled ?? false;

  return {
    apiUrl: process.env.OMNI_API_URL ?? omni?.apiUrl,
    apiKey: process.env.OMNI_API_KEY ?? omni?.apiKey,
    natsUrl: process.env.OMNI_NATS_URL ?? omni?.natsUrl ?? DEFAULT_NATS_URL,
    instance: process.env.OMNI_INSTANCE ?? omni?.instance ?? omni?.defaultInstanceId,
    approvalChat: process.env.OMNI_APPROVAL_CHAT ?? omni?.approvalChat,
    approveTokens: parseList(process.env.OMNI_APPROVE_TOKENS) ?? appr?.approveTokens ?? DEFAULT_APPROVE_TOKENS,
    denyTokens: parseList(process.env.OMNI_DENY_TOKENS) ?? appr?.denyTokens ?? DEFAULT_DENY_TOKENS,
    approveReactions: appr?.approveReactions ?? DEFAULT_APPROVE_REACTIONS,
    denyReactions: appr?.denyReactions ?? DEFAULT_DENY_REACTIONS,
    approvals: {
      enabled,
      toolMatcher: appr?.tools ?? DEFAULT_TOOL_MATCHER,
      pollBudgetMs: appr?.pollBudgetMs ?? DEFAULT_POLL_BUDGET_MS,
      pollIntervalMs: appr?.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    },
  };
}

/**
 * The one feature gate. True only when approvals are explicitly enabled AND the
 * runner has enough config to route a message (an instance + chat). Missing
 * routing is treated as disabled so a half-configured host silently no-ops
 * rather than gating every tool call against a phone that can never answer.
 */
export function isOmniApprovalEnabled(rt: OmniRuntimeConfig): boolean {
  return rt.approvals.enabled && Boolean(rt.instance) && Boolean(rt.approvalChat);
}
