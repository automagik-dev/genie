/**
 * Auto-Approve Configuration
 *
 * Manages layered trust configuration for automatic approval of tool operations.
 *
 * Config hierarchy (lower overrides higher):
 * 1. Global defaults: ~/.config/genie/auto-approve.yaml
 * 2. Repo-level: .genie/auto-approve.yaml in each repo
 * 3. Wish-level: ## Auto-Approve section in wish.md
 */

import { z } from 'zod';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import * as yaml from 'js-yaml';
import type { PermissionRequest } from './event-listener.js';
import { getBashCommand } from './event-listener.js';

// ============================================================================
// Schema Definitions
// ============================================================================

/**
 * Tool names that can be auto-approved
 */
export const ToolName = z.string();

/**
 * Repo-level configuration (can be used at global defaults or per-repo)
 */
export const RepoConfigSchema = z.object({
  inherit: z.enum(['global', 'none']).optional(),
  allow: z.array(ToolName).default([]),
  deny: z.array(ToolName).default([]),
  bash_allow_patterns: z.array(z.string()).optional(),
  bash_deny_patterns: z.array(z.string()).optional(),
});

export type RepoConfig = z.infer<typeof RepoConfigSchema>;

/**
 * Defaults configuration section
 */
export const DefaultsConfigSchema = z.object({
  allow: z.array(ToolName).default([]),
  deny: z.array(ToolName).default([]),
  bash_allow_patterns: z.array(z.string()).optional(),
  bash_deny_patterns: z.array(z.string()).optional(),
});

export type DefaultsConfig = z.infer<typeof DefaultsConfigSchema>;

/**
 * Full auto-approve configuration schema (global config file)
 */
export const AutoApproveConfigSchema = z.object({
  defaults: DefaultsConfigSchema.default({}),
  repos: z.record(z.string(), RepoConfigSchema).optional(),
});

export type AutoApproveConfig = z.infer<typeof AutoApproveConfigSchema>;

/**
 * Wish-level auto-approve override (parsed from markdown)
 */
export interface WishAutoApproveOverride {
  allow: string[];
  deny: string[];
  bash_allow_patterns: string[];
  bash_deny_patterns: string[];
}

// ============================================================================
// Config Loading
// ============================================================================

/**
 * Options for loading auto-approve config
 */
export interface LoadConfigOptions {
  /**
   * Override the global config directory (for testing)
   * Default: ~/.config/genie
   */
  globalConfigDir?: string;
}

/**
 * Get the default global config directory
 */
function getDefaultGlobalConfigDir(): string {
  return join(homedir(), '.config', 'genie');
}

/**
 * Load YAML config file, returning null if not found or invalid
 */
function loadYamlConfig<T>(filePath: string, schema: z.ZodSchema<T>): T | null {
  if (!existsSync(filePath)) {
    return null;
  }

  try {
    const content = readFileSync(filePath, 'utf-8');
    const parsed = yaml.load(content);
    const result = schema.safeParse(parsed);

    if (result.success) {
      return result.data;
    } else {
      console.warn(`Warning: Invalid config at ${filePath}:`, result.error.message);
      return null;
    }
  } catch (error: any) {
    console.warn(`Warning: Failed to load config at ${filePath}:`, error.message);
    return null;
  }
}

/**
 * Load the global auto-approve config
 */
function loadGlobalConfig(options: LoadConfigOptions = {}): AutoApproveConfig | null {
  const configDir = options.globalConfigDir ?? getDefaultGlobalConfigDir();
  const configPath = join(configDir, 'auto-approve.yaml');
  return loadYamlConfig(configPath, AutoApproveConfigSchema);
}

/**
 * Load the repo-level auto-approve config
 */
function loadRepoConfig(repoPath: string): RepoConfig | null {
  const configPath = join(repoPath, '.genie', 'auto-approve.yaml');
  return loadYamlConfig(configPath, RepoConfigSchema);
}

/**
 * Get the config for a specific repo from global config
 */
function getRepoOverrideFromGlobal(globalConfig: AutoApproveConfig, repoPath: string): RepoConfig | null {
  if (!globalConfig.repos) {
    return null;
  }

  // Try exact match first
  if (globalConfig.repos[repoPath]) {
    return globalConfig.repos[repoPath];
  }

  // Try to find a parent path match (e.g., /home/genie/workspace/guga matches /home/genie/workspace/guga/code/...)
  for (const [path, config] of Object.entries(globalConfig.repos)) {
    if (repoPath.startsWith(path + '/') || repoPath === path) {
      return config;
    }
  }

  return null;
}

/**
 * Merge two arrays, returning unique values (union)
 */
function mergeArrays<T>(base: T[] | undefined, override: T[] | undefined): T[] {
  const baseArr = base ?? [];
  const overrideArr = override ?? [];
  return Array.from(new Set([...baseArr, ...overrideArr]));
}

/**
 * Merge a repo config into an auto-approve config
 */
export function mergeConfigs(
  base: AutoApproveConfig,
  override: Partial<RepoConfig> | WishAutoApproveOverride
): AutoApproveConfig {
  // Handle inherit behavior
  const shouldInherit = 'inherit' in override ? override.inherit !== 'none' : true;

  if (!shouldInherit && 'allow' in override) {
    // Full override - don't inherit from base
    return {
      defaults: {
        allow: override.allow ?? [],
        deny: override.deny ?? [],
        bash_allow_patterns: override.bash_allow_patterns,
        bash_deny_patterns: override.bash_deny_patterns,
      },
      repos: base.repos,
    };
  }

  // Merge mode - combine base and override
  return {
    defaults: {
      allow: mergeArrays(base.defaults.allow, override.allow),
      deny: mergeArrays(base.defaults.deny, override.deny),
      bash_allow_patterns: mergeArrays(base.defaults.bash_allow_patterns, override.bash_allow_patterns),
      bash_deny_patterns: mergeArrays(base.defaults.bash_deny_patterns, override.bash_deny_patterns),
    },
    repos: base.repos,
  };
}

/**
 * Load and merge auto-approve config for a repository
 *
 * Precedence (lowest to highest):
 * 1. Global defaults
 * 2. Global repo-specific overrides
 * 3. Repo-level .genie/auto-approve.yaml
 *
 * @param repoPath - Path to the repository
 * @param options - Loading options
 * @returns Merged auto-approve configuration
 */
export async function loadAutoApproveConfig(
  repoPath: string,
  options: LoadConfigOptions = {}
): Promise<AutoApproveConfig> {
  // Start with empty defaults
  let config: AutoApproveConfig = AutoApproveConfigSchema.parse({});

  // 1. Load global config
  const globalConfig = loadGlobalConfig(options);
  if (globalConfig) {
    config = globalConfig;
  }

  // 2. Check for repo-specific override in global config
  if (globalConfig) {
    const globalRepoOverride = getRepoOverrideFromGlobal(globalConfig, repoPath);
    if (globalRepoOverride) {
      config = mergeConfigs(config, globalRepoOverride);
    }
  }

  // 3. Load repo-level config
  const repoConfig = loadRepoConfig(repoPath);
  if (repoConfig) {
    // Check if repo config explicitly inherits from global
    // Default behavior (no inherit field) = full override
    // inherit: global = merge with global
    // inherit: none = full override
    if (repoConfig.inherit === 'global') {
      // Merge with existing config
      config = mergeConfigs(config, repoConfig);
    } else {
      // Full override (no inherit field or inherit: none)
      config = {
        defaults: {
          allow: repoConfig.allow,
          deny: repoConfig.deny,
          bash_allow_patterns: repoConfig.bash_allow_patterns,
          bash_deny_patterns: repoConfig.bash_deny_patterns,
        },
      };
    }
  }

  return config;
}

// ============================================================================
// Wish Markdown Parsing
// ============================================================================

/**
 * Parse the ## Auto-Approve section from a wish.md file
 *
 * Expected format:
 * ```markdown
 * ## Auto-Approve
 * - bash: "npm publish"
 * - bash: "docker push"
 * - allow: NotebookEdit
 * - deny: Bash
 * ```
 *
 * @param wishContent - Full content of the wish.md file
 * @returns Parsed auto-approve overrides
 */
export function parseWishAutoApprove(wishContent: string): WishAutoApproveOverride {
  const result: WishAutoApproveOverride = {
    allow: [],
    deny: [],
    bash_allow_patterns: [],
    bash_deny_patterns: [],
  };

  // Find the ## Auto-Approve section
  const sectionRegex = /^## Auto-Approve\s*$/m;
  const match = sectionRegex.exec(wishContent);

  if (!match) {
    return result;
  }

  // Extract content from Auto-Approve section until next heading or end
  const startIndex = match.index + match[0].length;
  const nextHeadingMatch = /^##?\s+/m.exec(wishContent.slice(startIndex));
  const endIndex = nextHeadingMatch ? startIndex + nextHeadingMatch.index : wishContent.length;
  const sectionContent = wishContent.slice(startIndex, endIndex);

  // Parse each line
  const lines = sectionContent.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();

    // Skip empty lines and non-list items
    if (!trimmed.startsWith('-')) {
      continue;
    }

    // Remove the leading dash and trim
    const content = trimmed.slice(1).trim();

    // Parse bash patterns: - bash: "pattern"
    const bashMatch = /^bash:\s*["'](.+?)["']$/.exec(content);
    if (bashMatch) {
      result.bash_allow_patterns.push(bashMatch[1]);
      continue;
    }

    // Parse allow: - allow: ToolName
    const allowMatch = /^allow:\s*(\w+)$/.exec(content);
    if (allowMatch) {
      result.allow.push(allowMatch[1]);
      continue;
    }

    // Parse deny: - deny: ToolName
    const denyMatch = /^deny:\s*(\w+)$/.exec(content);
    if (denyMatch) {
      result.deny.push(denyMatch[1]);
      continue;
    }
  }

  return result;
}

/**
 * Load complete auto-approve config including wish-level overrides
 *
 * @param repoPath - Path to the repository
 * @param wishContent - Content of the wish.md file (optional)
 * @param options - Loading options
 * @returns Fully merged auto-approve configuration
 */
export async function loadFullAutoApproveConfig(
  repoPath: string,
  wishContent?: string,
  options: LoadConfigOptions = {}
): Promise<AutoApproveConfig> {
  // Load global + repo config
  let config = await loadAutoApproveConfig(repoPath, options);

  // Apply wish-level overrides if provided
  if (wishContent) {
    const wishOverride = parseWishAutoApprove(wishContent);
    config = mergeConfigs(config, wishOverride);
  }

  return config;
}

// ============================================================================
// Rule Matching (Group C)
// ============================================================================

/**
 * Decision returned by the rule matcher.
 *
 * - 'approve': The request is auto-approved based on config rules.
 * - 'deny': The request is denied and should NOT be auto-approved.
 * - 'escalate': The request could not be decided automatically; requires human review.
 */
export interface Decision {
  action: 'approve' | 'deny' | 'escalate';
  reason: string;
}

// ============================================================================
// Security Helpers
// ============================================================================

/** Maximum time (ms) allowed for a single regex match before it is aborted. */
const REGEX_TIMEOUT_MS = 100;

/**
 * Normalize a bash command for security-safe pattern matching.
 *
 * 1. Trim leading/trailing whitespace.
 * 2. Collapse all internal runs of whitespace (spaces, tabs) to a single space.
 * 3. Strip leading absolute-path prefix from the first token
 *    (e.g. /usr/bin/rm -> rm) so deny patterns are not bypassed by using
 *    a full path to the binary.
 *
 * @param command - Raw bash command string
 * @returns Normalized command string
 */
export function normalizeCommand(command: string): string {
  // Trim and collapse whitespace
  let normalized = command.trim().replace(/\s+/g, ' ');
  if (normalized === '') return '';

  // Strip leading path prefix from first token (e.g. /usr/bin/rm -> rm)
  // Only applies when the command starts with '/'
  normalized = normalized.replace(/^\/[\w./-]*\/(\w)/, '$1');

  return normalized;
}

/**
 * Detect shell metacharacters that indicate a compound / piped command.
 *
 * Compound commands can smuggle dangerous operations after an innocuous
 * prefix that matches an allow pattern (e.g. "bun test && rm -rf /").
 *
 * Detected metacharacters: &&  ||  ;  |  `  $(
 *
 * @param command - The (already-normalized) bash command string
 * @returns true if the command contains shell metacharacters
 */
export function hasShellMetacharacters(command: string): boolean {
  // Detect: &&, ||, ;, | (pipe), backticks, $() command substitution.
  // A single | check catches both pipe and || (logical OR).
  return /(&&|\||;|`|\$\()/.test(command);
}

/**
 * Execute a regex test with a time limit to prevent ReDoS attacks.
 *
 * If the regex takes longer than REGEX_TIMEOUT_MS it is considered a
 * non-match and a warning is logged.
 *
 * @param regex - Compiled RegExp
 * @param input - String to test
 * @returns true if the regex matches within the time limit
 */
function safeRegexTest(regex: RegExp, input: string): boolean {
  const start = Date.now();
  // Run on a limited-length prefix to cap worst-case backtracking.
  // Commands longer than 8 KB are extremely unusual; truncate for safety.
  const safeInput = input.length > 8192 ? input.slice(0, 8192) : input;
  try {
    const result = regex.test(safeInput);
    const elapsed = Date.now() - start;
    if (elapsed > REGEX_TIMEOUT_MS) {
      console.warn(
        `Warning: Regex pattern "${regex.source}" took ${elapsed}ms to evaluate (limit: ${REGEX_TIMEOUT_MS}ms). Treating as non-match for safety.`
      );
      return false;
    }
    return result;
  } catch {
    return false;
  }
}

/**
 * Check if a bash command matches any pattern in the given list.
 * Patterns are treated as regular expressions and matched against
 * the full command string (substring match).
 *
 * Security: Each regex is executed via safeRegexTest which enforces
 * a time limit to prevent ReDoS. Invalid patterns log a warning and
 * fall back to substring match.
 *
 * @param command - The bash command string
 * @param patterns - List of regex pattern strings
 * @returns The first matching pattern, or null if none match
 */
function matchBashPattern(command: string, patterns: string[]): string | null {
  for (const pattern of patterns) {
    try {
      const regex = new RegExp(pattern);
      if (safeRegexTest(regex, command)) {
        return pattern;
      }
    } catch {
      // If the pattern is not valid regex, log a warning and fall back to substring match
      console.warn(`Warning: Invalid regex pattern "${pattern}" in bash patterns; falling back to substring match`);
      if (command.includes(pattern)) {
        return pattern;
      }
    }
  }
  return null;
}

/**
 * Evaluate a permission request against the merged auto-approve configuration.
 *
 * Decision logic:
 * 1. If the tool is in the deny list, deny (deny always wins over allow).
 * 2. If the tool is not in the allow list, escalate.
 * 3. For non-Bash tools: if tool is in allow list and not denied, approve.
 * 4. For Bash tools:
 *    a. If no command can be extracted, escalate.
 *    b. Normalize the command (collapse whitespace, strip path prefixes).
 *    c. If normalized command matches any bash_deny_pattern, deny (deny patterns always win).
 *    d. If no bash patterns are configured at all, approve (tool-level allow is sufficient).
 *    e. If command contains shell metacharacters (&&, ||, ;, |, backticks, $()),
 *       only approve if the ENTIRE normalized string matches an allow pattern;
 *       otherwise escalate for human review.
 *    f. If command matches any bash_allow_pattern, approve.
 *    g. Otherwise, escalate (command not recognized).
 *
 * @param request - The permission request to evaluate
 * @param config - The merged auto-approve configuration
 * @returns Decision with action and reason
 */
export function evaluateRequest(request: PermissionRequest, config: AutoApproveConfig): Decision {
  const { toolName } = request;
  const { allow, deny, bash_allow_patterns, bash_deny_patterns } = config.defaults;

  // Step 1: Deny always wins - check tool-level deny list first
  if (deny.includes(toolName)) {
    return {
      action: 'deny',
      reason: `Tool "${toolName}" is in the deny list`,
    };
  }

  // Step 2: Tool must be in the allow list to proceed
  if (!allow.includes(toolName)) {
    return {
      action: 'escalate',
      reason: `Tool "${toolName}" is not in the allow list; requires human review`,
    };
  }

  // Step 3: Non-Bash tools - if allowed and not denied, approve
  if (toolName !== 'Bash') {
    return {
      action: 'approve',
      reason: `Tool "${toolName}" is in the allow list`,
    };
  }

  // Step 4: Bash tool - need to evaluate the command against patterns
  const rawCommand = getBashCommand(request);

  // 4a: No command to evaluate - escalate
  if (rawCommand === null) {
    return {
      action: 'escalate',
      reason: 'Bash tool request has no command to evaluate; requires human review',
    };
  }

  // 4b: Normalize the command to prevent whitespace/path-prefix bypass
  const command = normalizeCommand(rawCommand);

  // 4c: Check bash_deny_patterns first (deny always wins)
  const denyPatterns = bash_deny_patterns ?? [];
  if (denyPatterns.length > 0) {
    const matchedDeny = matchBashPattern(command, denyPatterns);
    if (matchedDeny) {
      return {
        action: 'deny',
        reason: `Bash command matches deny pattern "${matchedDeny}": ${command}`,
      };
    }
  }

  // 4d: If no bash patterns configured at all, tool-level allow is sufficient
  const allowPatterns = bash_allow_patterns ?? [];
  if (allowPatterns.length === 0 && denyPatterns.length === 0) {
    return {
      action: 'approve',
      reason: `Bash tool is allowed and no command patterns are configured`,
    };
  }

  // 4e: Compound command detection - escalate unless the ENTIRE string matches an allow pattern
  if (hasShellMetacharacters(command)) {
    // For compound commands, only approve if an allow pattern matches the ENTIRE command.
    // This prevents "bun test && rm -rf /" from being approved by a "bun test" pattern.
    if (allowPatterns.length > 0) {
      const matchedAllow = matchBashPattern(command, allowPatterns);
      if (matchedAllow) {
        // Verify the pattern actually covers the entire command string
        try {
          const fullMatchRegex = new RegExp(matchedAllow);
          const match = command.match(fullMatchRegex);
          if (match && match[0] === command) {
            return {
              action: 'approve',
              reason: `Bash compound command fully matches allow pattern "${matchedAllow}": ${command}`,
            };
          }
        } catch {
          // Invalid regex - can't verify full match, escalate
        }
      }
    }
    return {
      action: 'escalate',
      reason: `Bash command contains shell metacharacters and does not fully match any allow pattern; requires human review: ${command}`,
    };
  }

  // 4f: Check bash_allow_patterns (simple commands without metacharacters)
  if (allowPatterns.length > 0) {
    const matchedAllow = matchBashPattern(command, allowPatterns);
    if (matchedAllow) {
      return {
        action: 'approve',
        reason: `Bash command matches allow pattern "${matchedAllow}": ${command}`,
      };
    }
  }

  // 4g: Command not recognized by any pattern - escalate
  return {
    action: 'escalate',
    reason: `Bash command does not match any allow pattern; requires human review: ${command}`,
  };
}

// ============================================================================
// Config Path Helpers
// ============================================================================

/**
 * Get the path to the global auto-approve config file
 */
export function getGlobalConfigPath(): string {
  return join(getDefaultGlobalConfigDir(), 'auto-approve.yaml');
}

/**
 * Get the path to a repo's auto-approve config file
 */
export function getRepoConfigPath(repoPath: string): string {
  return join(repoPath, '.genie', 'auto-approve.yaml');
}

/**
 * Get default auto-approve config (empty/permissive)
 */
export function getDefaultConfig(): AutoApproveConfig {
  return AutoApproveConfigSchema.parse({});
}