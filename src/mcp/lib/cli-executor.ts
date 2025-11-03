/**
 * CLI Executor - Shell-out pattern for Genie CLI invocation
 *
 * Provides utilities for invoking Genie CLI commands from MCP server.
 * Uses subprocess execution to maintain behavioral equivalence with CLI.
 *
 * Extracted from server.ts per Amendment #10 (File Size Discipline).
 */

import fs from 'fs';
import path from 'path';
import { execFile, ExecFileOptions } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

/**
 * CLI invocation configuration (command + args)
 */
export interface CliInvocation {
  command: string;
  args: string[];
}

/**
 * CLI execution result with stdout/stderr/command line
 */
export interface CliResult {
  stdout: string;
  stderr: string;
  commandLine: string;
}

/**
 * Resolve CLI invocation strategy (dist, local script, or npx)
 *
 * @param workspaceRoot - Workspace root directory
 * @returns CLI invocation configuration
 */
export function resolveCliInvocation(workspaceRoot: string): CliInvocation {
  const distEntry = path.join(workspaceRoot, 'dist/cli/genie-cli.js');
  if (fs.existsSync(distEntry)) {
    return { command: process.execPath, args: [distEntry] };
  }

  const localScript = path.join(workspaceRoot, 'genie');
  if (fs.existsSync(localScript)) {
    return { command: localScript, args: [] };
  }

  return { command: 'npx', args: ['automagik-genie'] };
}

/**
 * Quote CLI argument if needed (handles spaces and special characters)
 *
 * @param value - Argument value to quote
 * @returns Quoted argument string
 */
export function quoteArg(value: string): string {
  if (!value.length) return '""';
  if (/^[A-Za-z0-9._\-\/]+$/.test(value)) return value;
  return '"' + value.replace(/"/g, '\\"') + '"';
}

/**
 * Normalize CLI output (handle string/Buffer/undefined)
 *
 * @param data - Raw output data
 * @returns Normalized string output
 */
export function normalizeOutput(data: string | Buffer | undefined): string {
  if (data === undefined || data === null) return '';
  return typeof data === 'string' ? data : data.toString('utf8');
}

/**
 * Execute Genie CLI command via subprocess
 *
 * @param workspaceRoot - Workspace root directory
 * @param subArgs - CLI subcommand arguments
 * @param timeoutMs - Execution timeout in milliseconds (default: 120000)
 * @returns CLI execution result
 * @throws Error if CLI execution fails
 */
export async function runCliCommand(
  workspaceRoot: string,
  subArgs: string[],
  timeoutMs = 120000
): Promise<CliResult> {
  const invocation = resolveCliInvocation(workspaceRoot);
  const execArgs = [...invocation.args, ...subArgs];
  const commandLine = [invocation.command, ...execArgs.map(quoteArg)].join(' ');
  const options: ExecFileOptions = {
    cwd: workspaceRoot,
    maxBuffer: 10 * 1024 * 1024,
    timeout: timeoutMs
  };

  try {
    const { stdout, stderr } = await execFileAsync(invocation.command, execArgs, options);
    return {
      stdout: normalizeOutput(stdout),
      stderr: normalizeOutput(stderr),
      commandLine
    };
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { stdout?: string | Buffer; stderr?: string | Buffer };
    const wrapped = new Error(err.message || 'CLI execution failed');
    (wrapped as any).stdout = normalizeOutput(err.stdout);
    (wrapped as any).stderr = normalizeOutput(err.stderr);
    (wrapped as any).commandLine = commandLine;
    throw wrapped;
  }
}

/**
 * Format CLI execution failure for user-friendly error messages
 *
 * @param action - Action description (e.g., "start agent session")
 * @param error - Error object from CLI execution
 * @returns Formatted error message with stdout/stderr/command line
 */
export function formatCliFailure(action: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const stdout = error && typeof error === 'object' ? (error as any).stdout : '';
  const stderr = error && typeof error === 'object' ? (error as any).stderr : '';
  const commandLine = error && typeof error === 'object' ? (error as any).commandLine : '';

  const sections: string[] = [`Failed to ${action}:`, message];
  if (stdout) {
    sections.push(`Stdout:\n${stdout}`);
  }
  if (stderr) {
    sections.push(`Stderr:\n${stderr}`);
  }
  if (commandLine) {
    sections.push(`Command: ${commandLine}`);
  }
  return sections.join('\n\n');
}
