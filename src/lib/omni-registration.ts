/**
 * Omni auto-registration — register a genie agent in Omni's directory over
 * SIGNED HTTP (the only signed-HTTP path in the runner; all other omni traffic
 * is NATS publish).
 *
 * Ported from origin/v4:src/lib/omni-registration.ts, trimmed of the v4 audit
 * pipeline (no `audit.ts` in v5). Graceful no-op when Omni is unconfigured;
 * omni-side failures warn (to stderr) but never throw.
 */

import { loadGenieConfig } from './genie-config.js';
import { signOmniRequest } from './omni-signature.js';

interface OmniAgentRegistration {
  name: string;
  provider: 'claude' | 'agno' | 'openai' | 'gemini' | 'custom' | 'omni-internal';
  model?: string;
  agentType?: 'assistant' | 'workflow' | 'team' | 'tool';
  capabilities?: string[];
  metadata?: Record<string, unknown>;
}

interface OmniAgentResponse {
  id: string;
  name: string;
  provider: string;
  model: string | null;
  agentType: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

type OmniFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** Resolve the Omni API URL from env var or genie config; null when unset. */
export async function resolveOmniApiUrl(): Promise<string | null> {
  const envUrl = process.env.OMNI_API_URL;
  if (envUrl) return envUrl;
  const config = await loadGenieConfig();
  return config.omni?.apiUrl ?? null;
}

/** Resolve the Omni API key from env var or genie config. */
export async function resolveOmniApiKey(): Promise<string | undefined> {
  const envKey = process.env.OMNI_API_KEY;
  if (envKey) return envKey;
  const config = await loadGenieConfig();
  return config.omni?.apiKey;
}

/**
 * Register an agent in Omni's directory via `POST /api/v2/agents`. Attaches the
 * ed25519 signature headers when this host has run `genie omni handshake`;
 * bearer stays the auth source until omni's verifier flips on.
 *
 * @returns The Omni agent id on success, null when unconfigured or unreachable.
 */
export async function registerAgentInOmni(
  agentName: string,
  options?: { model?: string; roles?: string[]; apiUrl?: string; apiKey?: string; fetchImpl?: OmniFetch },
): Promise<string | null> {
  const apiUrl = options?.apiUrl ?? (await resolveOmniApiUrl());
  if (!apiUrl) return null;
  const apiKey = options?.apiKey ?? (await resolveOmniApiKey());

  const body: OmniAgentRegistration = {
    name: agentName,
    provider: 'claude',
    model: options?.model,
    agentType: 'assistant',
    capabilities: options?.roles ?? [],
    metadata: {
      source: 'genie',
      sessionIsolation: { perPerson: true, perChannel: true },
      registeredAt: new Date().toISOString(),
    },
  };

  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

    const bodyJson = JSON.stringify(body);
    const sig = signOmniRequest('POST', '/api/v2/agents', bodyJson);
    if (sig) Object.assign(headers, sig);

    const response = await (options?.fetchImpl ?? fetch)(`${apiUrl.replace(/\/+$/, '')}/api/v2/agents`, {
      method: 'POST',
      headers,
      body: bodyJson,
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      process.stderr.write(`[omni-registration] failed (HTTP ${response.status}): ${text.slice(0, 200)}\n`);
      return null;
    }

    const result = (await response.json()) as { data: OmniAgentResponse };
    return result.data.id;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[omni-registration] failed: ${message}\n`);
    return null;
  }
}
