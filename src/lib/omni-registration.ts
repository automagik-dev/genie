/**
 * Omni Auto-Registration — register genie agents in Omni's agent directory.
 *
 * When `OMNI_API_URL` env var or `config.omni.apiUrl` is set, agents are
 * auto-registered in Omni for identity reconciliation + A2A reachability.
 *
 * Graceful no-op when Omni is not configured. Omni API failure warns but
 * does not block local registration.
 */

import { generateTraceId, getActor, recordAuditEvent } from './audit.js';
import { loadGenieConfig } from './genie-config.js';

// ============================================================================
// Types
// ============================================================================

export interface OmniAgentRegistration {
  name: string;
  provider: 'claude' | 'agno' | 'openai' | 'gemini' | 'custom' | 'omni-internal';
  model?: string;
  agentType?: 'assistant' | 'workflow' | 'team' | 'tool';
  capabilities?: string[];
  metadata?: Record<string, unknown>;
}

export interface OmniAgentResponse {
  id: string;
  name: string;
  provider: string;
  model: string | null;
  agentType: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

// ============================================================================
// Configuration
// ============================================================================

/**
 * Resolve the Omni API URL from env var or genie config.
 * Returns null if Omni is not configured.
 */
export async function resolveOmniApiUrl(): Promise<string | null> {
  // Env var takes precedence
  const envUrl = process.env.OMNI_API_URL;
  if (envUrl) return envUrl;

  // Fall back to genie config
  const config = await loadGenieConfig();
  return config.omni?.apiUrl ?? null;
}

/**
 * Resolve the Omni API key from env var or genie config.
 */
async function resolveOmniApiKey(): Promise<string | undefined> {
  const envKey = process.env.OMNI_API_KEY;
  if (envKey) return envKey;

  const config = await loadGenieConfig();
  return config.omni?.apiKey;
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Register an agent in Omni's directory.
 *
 * Creates the agent via POST /api/v2/agents with session isolation metadata
 * (separate sessions per person + per channel).
 *
 * @returns The Omni agent ID on success, null if Omni is not configured or unreachable.
 */
export async function registerAgentInOmni(
  agentName: string,
  options?: {
    model?: string;
    roles?: string[];
  },
): Promise<string | null> {
  const apiUrl = await resolveOmniApiUrl();
  if (!apiUrl) return null;

  const apiKey = await resolveOmniApiKey();

  const body: OmniAgentRegistration = {
    name: agentName,
    provider: 'claude',
    model: options?.model,
    agentType: 'assistant',
    capabilities: options?.roles ?? [],
    metadata: {
      source: 'genie',
      sessionIsolation: {
        perPerson: true,
        perChannel: true,
      },
      registeredAt: new Date().toISOString(),
    },
  };

  const traceId = generateTraceId();

  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-Trace-Id': traceId,
    };
    if (apiKey) {
      headers.Authorization = `Bearer ${apiKey}`;
    }

    const response = await fetch(`${apiUrl}/api/v2/agents`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      console.warn(`Warning: Omni registration failed (HTTP ${response.status}): ${text}`);
      recordAuditEvent('omni', agentName, 'registration_error', getActor(), {
        traceId,
        status: response.status,
        error: text.slice(0, 200),
      }).catch(() => {});
      return null;
    }

    const result = (await response.json()) as { data: OmniAgentResponse };
    recordAuditEvent('omni', agentName, 'registration_success', getActor(), {
      traceId,
      omniAgentId: result.data.id,
    }).catch(() => {});
    return result.data.id;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`Warning: Omni registration failed: ${message}`);
    recordAuditEvent('omni', agentName, 'registration_error', getActor(), {
      traceId,
      error: message.slice(0, 200),
    }).catch(() => {});
    return null;
  }
}

/**
 * Check if an agent already exists in Omni by name.
 *
 * @returns The Omni agent ID if found, null otherwise.
 */
export async function findOmniAgent(agentName: string): Promise<string | null> {
  const apiUrl = await resolveOmniApiUrl();
  if (!apiUrl) return null;

  const apiKey = await resolveOmniApiKey();

  const traceId = generateTraceId();

  try {
    const headers: Record<string, string> = {
      'X-Trace-Id': traceId,
    };
    if (apiKey) {
      headers.Authorization = `Bearer ${apiKey}`;
    }

    const response = await fetch(`${apiUrl}/api/v2/agents?name=${encodeURIComponent(agentName)}`, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) return null;

    const result = (await response.json()) as { data: OmniAgentResponse[] };
    const match = result.data?.find((a) => a.name === agentName && a.isActive);
    return match?.id ?? null;
  } catch {
    return null;
  }
}
