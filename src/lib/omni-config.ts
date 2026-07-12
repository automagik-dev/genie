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
//
// Vocabulary split: TEXT words (`OMNI_APPROVE_TOKENS`/`approveTokens`) vs
// REACTION emoji (`approveReactions`/`denyReactions`). Keep emoji OUT of the
// token lists — WhatsApp's bare-emoji dual-emit would echo them back and could
// double-resolve an approval.
export const DEFAULT_APPROVE_TOKENS = ['y', 'yes', 'approve', 'sim'];
export const DEFAULT_DENY_TOKENS = ['n', 'no', 'deny', 'nao'];
export const DEFAULT_APPROVE_REACTIONS = ['\u{1F44D}', '\u{2705}', '\u{1F44C}']; // 👍 ✅ 👌
export const DEFAULT_DENY_REACTIONS = ['\u{1F44E}', '\u{274C}', '\u{1F6AB}']; // 👎 ❌ 🚫

const DEFAULT_NATS_URL = 'localhost:4222';
const DEFAULT_TOOL_MATCHER = '^(Bash|Write|Edit|apply_patch|NotebookEdit)$';
/**
 * PermissionRequest timing ladder: Omni polls for at most 110s, the bundled
 * launcher owns 115s, and the Codex host manifest owns 125s. The 5s/15s
 * margins leave time to expire the row, serialize a deny, and terminate.
 */
export const MAX_APPROVAL_POLL_BUDGET_MS = 110_000;
export const PERMISSION_CHILD_TIMEOUT_MS = 115_000;
export const PERMISSION_HOST_TIMEOUT_MS = 125_000;
const DEFAULT_POLL_BUDGET_MS = MAX_APPROVAL_POLL_BUDGET_MS;
const DEFAULT_POLL_INTERVAL_MS = 400;
const DEFAULT_INBOUND_TIMEOUT_MS = 120_000;
const DEFAULT_INBOUND_MAX_REPLY_CHARS = 4_000;

/** A single inbound one-shot route: (instance, chat) → absolute repo dir. */
export interface OmniRoute {
  instance: string;
  chat: string;
  repo: string;
  /**
   * Absolute path to a persona / AGENTS.md file appended to the agent's system
   * prompt for this route's runs. Omitted → the runner falls back to
   * `<repo>/AGENTS.md` if it exists, else no persona.
   */
  persona?: string;
  /** Provider for inbound execution. Omitted preserves historical Claude behavior. */
  agent?: 'claude' | 'codex';
}

/**
 * Fully-resolved omni runtime config. The resolver populates every field, so
 * `resolveOmniRuntimeConfig` never returns a hole. `routes` and the two
 * `inbound*` fields are typed optional only so hand-built literals (tests that
 * predate one-shot inbound) still satisfy the shape; the runner defaults them.
 */
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
  /** Inbound one-shot routes; unmapped (instance, chat) pairs are store-only. */
  routes?: OmniRoute[];
  /** Wall-clock budget for one inbound one-shot `claude -p` run (ms). */
  inboundTimeoutMs?: number;
  /** Max chars of one-shot stdout returned as a reply (truncated past this). */
  inboundMaxReplyChars?: number;
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

export function normalizeApprovalTiming(
  pollBudgetMs: number | undefined,
  pollIntervalMs: number | undefined,
): { pollBudgetMs: number; pollIntervalMs: number } {
  const budget =
    typeof pollBudgetMs === 'number' && Number.isFinite(pollBudgetMs) && pollBudgetMs > 0
      ? Math.min(Math.max(1, Math.floor(pollBudgetMs)), MAX_APPROVAL_POLL_BUDGET_MS)
      : DEFAULT_POLL_BUDGET_MS;
  const interval =
    typeof pollIntervalMs === 'number' && Number.isFinite(pollIntervalMs) && pollIntervalMs > 0
      ? Math.max(1, Math.floor(pollIntervalMs))
      : DEFAULT_POLL_INTERVAL_MS;
  return { pollBudgetMs: budget, pollIntervalMs: Math.min(interval, budget) };
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
  const timing = normalizeApprovalTiming(appr?.pollBudgetMs, appr?.pollIntervalMs);

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
    routes: omni?.routes ?? [],
    inboundTimeoutMs: omni?.inboundTimeoutMs ?? DEFAULT_INBOUND_TIMEOUT_MS,
    inboundMaxReplyChars: omni?.inboundMaxReplyChars ?? DEFAULT_INBOUND_MAX_REPLY_CHARS,
    approvals: {
      enabled,
      toolMatcher: appr?.tools ?? DEFAULT_TOOL_MATCHER,
      pollBudgetMs: timing.pollBudgetMs,
      pollIntervalMs: timing.pollIntervalMs,
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
