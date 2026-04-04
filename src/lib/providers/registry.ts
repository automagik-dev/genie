/**
 * Provider Registry — Static registry of ExecutorProvider implementations.
 *
 * Auto-registers ClaudeCodeProvider and CodexProvider on import.
 * Provides lookup by ProviderName and listing of all registered providers.
 */

import type { ExecutorProvider } from '../executor-types.js';
import type { ProviderName } from '../provider-adapters.js';
import { AppPtyProvider } from './app-pty.js';
import { ClaudeCodeProvider } from './claude-code.js';
import { ClaudeSdkProvider } from './claude-sdk.js';
import { CodexProvider } from './codex.js';

// ============================================================================
// Registry
// ============================================================================

const providers = new Map<ProviderName, ExecutorProvider>();

/** Register a provider. Overwrites if already registered. */
export function registerProvider(provider: ExecutorProvider): void {
  providers.set(provider.name as ProviderName, provider);
}

/** Get a provider by name. Returns undefined if not registered. */
export function getProvider(name: ProviderName): ExecutorProvider | undefined {
  return providers.get(name);
}

/** List all registered providers. */
export function listProviders(): ExecutorProvider[] {
  return [...providers.values()];
}

// ============================================================================
// Auto-registration
// ============================================================================

// Map provider names to ProviderName enum values:
// ClaudeCodeProvider.name = 'claude-code' but ProviderName = 'claude'
// CodexProvider.name = 'codex' which matches ProviderName = 'codex'

const claude = new ClaudeCodeProvider();
const codex = new CodexProvider();
const appPty = new AppPtyProvider();
const claudeSdk = new ClaudeSdkProvider();

providers.set('claude', claude);
providers.set('codex', codex);
providers.set('app-pty', appPty);
providers.set('claude-sdk', claudeSdk);
