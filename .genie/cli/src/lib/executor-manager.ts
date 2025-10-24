/**
 * Executor Management - Verification, Installation, and Authentication
 */

import { execSync } from 'child_process';
import { platform } from 'os';
import { EXECUTOR_DEFINITIONS, getExecutorDefinition, type ExecutorDefinition } from './executor-definitions.js';

/**
 * OS detection utilities
 */
export function getOSType(): 'macos' | 'linux' | 'windows' | 'unknown' {
  const p = platform();
  if (p === 'darwin') return 'macos';
  if (p === 'linux') return 'linux';
  if (p === 'win32') return 'windows';
  return 'unknown';
}

/**
 * Execute shell command and return stdout
 */
function execCommand(command: string, ignoreError = false): string | null {
  try {
    return execSync(command, { encoding: 'utf8', stdio: ignoreError ? 'pipe' : 'inherit' }).trim();
  } catch (error) {
    if (ignoreError) return null;
    throw error;
  }
}

/**
 * Check if a command exists in PATH
 */
export function commandExists(command: string): boolean {
  try {
    execSync(`command -v ${command}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Verify if an executor is installed
 */
export async function verifyExecutor(executorKey: string): Promise<{
  installed: boolean;
  version?: string;
  error?: string;
}> {
  const def = getExecutorDefinition(executorKey);
  if (!def) {
    return { installed: false, error: `Unknown executor: ${executorKey}` };
  }

  try {
    // For VSCode extensions, check both VSCode and extension
    if (def.key === 'cline' || def.key === 'continue') {
      if (!commandExists('code')) {
        return { installed: false, error: 'VSCode is not installed' };
      }

      // Check if extension is installed
      const extensions = execCommand('code --list-extensions', true);
      if (!extensions) {
        return { installed: false, error: 'Could not list VSCode extensions' };
      }

      const extensionId = def.key === 'cline' ? 'saoudrizwan.claude-dev' : 'continue.continue';
      const installed = extensions.includes(extensionId);

      return {
        installed,
        version: installed ? 'installed' : undefined,
        error: installed ? undefined : `VSCode extension ${extensionId} not found`
      };
    }

    // For regular CLI tools, check command existence
    if (!commandExists(def.command)) {
      return { installed: false, error: `Command '${def.command}' not found in PATH` };
    }

    // Try to get version
    const version = execCommand(def.verifyCommand, true);
    return {
      installed: true,
      version: version || 'installed'
    };
  } catch (error: any) {
    return {
      installed: false,
      error: error.message || 'Verification failed'
    };
  }
}

/**
 * Install an executor
 */
export async function installExecutor(executorKey: string): Promise<{
  success: boolean;
  error?: string;
}> {
  const def = getExecutorDefinition(executorKey);
  if (!def) {
    return { success: false, error: `Unknown executor: ${executorKey}` };
  }

  const osType = getOSType();
  const installCommands = osType === 'macos' ? def.installCommands.macos : def.installCommands.linux;

  if (!installCommands || installCommands.length === 0) {
    return {
      success: false,
      error: `No installation method defined for ${def.friendlyName} on ${osType}`
    };
  }

  try {
    console.log(`📦 Installing ${def.friendlyName}...`);

    // Execute installation commands sequentially
    for (const cmd of installCommands) {
      console.log(`   Running: ${cmd}`);
      execCommand(cmd, false);
    }

    // Verify installation succeeded
    const verification = await verifyExecutor(executorKey);
    if (!verification.installed) {
      return {
        success: false,
        error: `Installation completed but verification failed: ${verification.error}`
      };
    }

    console.log(`✅ ${def.friendlyName} installed successfully!`);
    return { success: true };
  } catch (error: any) {
    return {
      success: false,
      error: `Installation failed: ${error.message}`
    };
  }
}

/**
 * Authenticate/login to an executor
 */
export async function authenticateExecutor(executorKey: string): Promise<{
  success: boolean;
  username?: string;
  error?: string;
}> {
  const def = getExecutorDefinition(executorKey);
  if (!def) {
    return { success: false, error: `Unknown executor: ${executorKey}` };
  }

  if (!def.requiresAuth) {
    return { success: true }; // No auth required
  }

  if (!def.loginCommand) {
    return {
      success: false,
      error: `${def.friendlyName} requires authentication but no login command defined`
    };
  }

  try {
    console.log(`🔑 Authenticating ${def.friendlyName}...`);
    console.log(`   Please follow the prompts to complete authentication.`);

    // Execute login command interactively
    execCommand(def.loginCommand, false);

    console.log(`✅ ${def.friendlyName} authenticated successfully!`);
    return { success: true };
  } catch (error: any) {
    return {
      success: false,
      error: `Authentication failed: ${error.message}`
    };
  }
}

/**
 * Interactive executor selection menu
 */
export async function selectExecutorInteractive(): Promise<string | null> {
  const executors = Object.values(EXECUTOR_DEFINITIONS);

  console.log('\n🧞 ✨ SELECT YOUR AI EXECUTOR ✨');
  console.log('━'.repeat(60));
  console.log('');

  executors.forEach((exec, index) => {
    console.log(`${index + 1}. ${exec.friendlyName.padEnd(20)} - ${exec.description}`);
  });

  console.log('');
  console.log('Enter number (1-' + executors.length + '): ');

  // Read from stdin (this will be implemented in the CLI command)
  // For now, return null to indicate interactive selection needed
  return null;
}

/**
 * Complete executor setup workflow
 */
export async function setupExecutor(executorKey: string): Promise<{
  success: boolean;
  needsAuth: boolean;
  error?: string;
}> {
  const def = getExecutorDefinition(executorKey);
  if (!def) {
    return { success: false, needsAuth: false, error: `Unknown executor: ${executorKey}` };
  }

  console.log(`\n🔍 Checking if ${def.friendlyName} is installed...`);

  // Verify installation
  const verification = await verifyExecutor(executorKey);

  if (!verification.installed) {
    console.log(`❌ ${def.friendlyName} is not installed`);
    console.log(`   Error: ${verification.error}`);

    // Prompt for installation (in CLI command)
    console.log(`\n📦 Would you like to install ${def.friendlyName} now? (y/n)`);
    // Return needsAuth flag for CLI to handle
    return { success: false, needsAuth: def.requiresAuth, error: 'Not installed' };
  }

  console.log(`✅ ${def.friendlyName} is already installed (${verification.version})`);

  // Check if authentication is needed
  if (def.requiresAuth) {
    return { success: true, needsAuth: true };
  }

  return { success: true, needsAuth: false };
}

/**
 * Get list of all executor keys
 */
export function getAllExecutorKeys(): string[] {
  return Object.keys(EXECUTOR_DEFINITIONS);
}

/**
 * Get executor display info
 */
export function getExecutorInfo(executorKey: string): {
  key: string;
  name: string;
  description: string;
  website: string;
} | null {
  const def = getExecutorDefinition(executorKey);
  if (!def) return null;

  return {
    key: def.key,
    name: def.friendlyName,
    description: def.description,
    website: def.website
  };
}
