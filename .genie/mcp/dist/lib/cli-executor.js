"use strict";
/**
 * CLI Executor - Shell-out pattern for Genie CLI invocation
 *
 * Provides utilities for invoking Genie CLI commands from MCP server.
 * Uses subprocess execution to maintain behavioral equivalence with CLI.
 *
 * Extracted from server.ts per Amendment #10 (File Size Discipline).
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveCliInvocation = resolveCliInvocation;
exports.quoteArg = quoteArg;
exports.normalizeOutput = normalizeOutput;
exports.runCliCommand = runCliCommand;
exports.formatCliFailure = formatCliFailure;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const child_process_1 = require("child_process");
const util_1 = require("util");
const execFileAsync = (0, util_1.promisify)(child_process_1.execFile);
/**
 * Resolve CLI invocation strategy (dist, local script, or npx)
 *
 * @param workspaceRoot - Workspace root directory
 * @returns CLI invocation configuration
 */
function resolveCliInvocation(workspaceRoot) {
    const distEntry = path_1.default.join(workspaceRoot, '.genie/cli/dist/genie-cli.js');
    if (fs_1.default.existsSync(distEntry)) {
        return { command: process.execPath, args: [distEntry] };
    }
    const localScript = path_1.default.join(workspaceRoot, 'genie');
    if (fs_1.default.existsSync(localScript)) {
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
function quoteArg(value) {
    if (!value.length)
        return '""';
    if (/^[A-Za-z0-9._\-\/]+$/.test(value))
        return value;
    return '"' + value.replace(/"/g, '\\"') + '"';
}
/**
 * Normalize CLI output (handle string/Buffer/undefined)
 *
 * @param data - Raw output data
 * @returns Normalized string output
 */
function normalizeOutput(data) {
    if (data === undefined || data === null)
        return '';
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
async function runCliCommand(workspaceRoot, subArgs, timeoutMs = 120000) {
    const invocation = resolveCliInvocation(workspaceRoot);
    const execArgs = [...invocation.args, ...subArgs];
    const commandLine = [invocation.command, ...execArgs.map(quoteArg)].join(' ');
    const options = {
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
    }
    catch (error) {
        const err = error;
        const wrapped = new Error(err.message || 'CLI execution failed');
        wrapped.stdout = normalizeOutput(err.stdout);
        wrapped.stderr = normalizeOutput(err.stderr);
        wrapped.commandLine = commandLine;
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
function formatCliFailure(action, error) {
    const message = error instanceof Error ? error.message : String(error);
    const stdout = error && typeof error === 'object' ? error.stdout : '';
    const stderr = error && typeof error === 'object' ? error.stderr : '';
    const commandLine = error && typeof error === 'object' ? error.commandLine : '';
    const sections = [`Failed to ${action}:`, message];
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
