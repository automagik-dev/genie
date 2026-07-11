#!/usr/bin/env node
'use strict';

/**
 * Portable plugin-local launcher for `genie hook dispatch`.
 *
 * The launcher intentionally selects the wire protocol through an environment
 * variable, not a CLI flag, so older Genie binaries still parse the command.
 * Codex responses are buffered and schema-checked before they reach the host;
 * spawn errors, timeouts, non-zero exits, and malformed output become a valid
 * event-specific deny instead of an infrastructure failure that Codex allows.
 */

const { spawn } = require('node:child_process');
const { constants, accessSync, lstatSync, realpathSync } = require('node:fs');
const { homedir } = require('node:os');
const path = require('node:path');

const MAX_STDIN_BYTES = 1024 * 1024;
const MAX_STDOUT_BYTES = 64 * 1024;

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseEntry(raw) {
  try {
    const value = JSON.parse(raw);
    if (!isRecord(value)) return { error: 'payload must be a JSON object' };
    return {
      event: typeof value.hook_event_name === 'string' ? value.hook_event_name : undefined,
      tool: typeof value.tool_name === 'string' ? value.tool_name : undefined,
      input: value.tool_input,
    };
  } catch {
    return { error: 'payload is not valid JSON' };
  }
}

function codexInputError(entry) {
  if (entry.error) return entry.error;
  if (!entry.event) return 'hook_event_name must be a non-empty string';
  if (entry.event !== 'PreToolUse' && entry.event !== 'PermissionRequest') {
    return `unsupported Codex dispatch event: ${entry.event}`;
  }
  if (!entry.tool) return 'tool_name must be a non-empty string';
  if (entry.tool.length > 128) return 'tool_name must be at most 128 characters';
  if (/\s|[\u0000-\u001f\u007f]/u.test(entry.tool)) {
    return 'tool_name must not contain whitespace or control characters';
  }
  if (!isRecord(entry.input)) return 'tool_input must be a JSON object';
  if ((entry.tool === 'Bash' || entry.tool === 'apply_patch') && typeof entry.input.command !== 'string') {
    return `${entry.tool} tool_input.command must be a string`;
  }
  return null;
}

function codexFailureOutput(raw, reason) {
  const { event, tool } = parseEntry(raw);
  if (event === 'PermissionRequest') {
    return JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior: 'deny', message: reason },
      },
    });
  }
  if (event === 'PreToolUse' && tool !== 'AskUserQuestion') {
    return JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      },
    });
  }
  return JSON.stringify({ decision: 'block', reason });
}

function validCodexOutput(raw, event) {
  if (raw.trim() === '') return true;
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    return false;
  }
  if (!isRecord(value)) return false;
  if (typeof value.systemMessage === 'string' && Object.keys(value).length === 1) return true;

  if (event === 'PreToolUse') {
    if (value.decision === 'block' && typeof value.reason === 'string') return true;
    const output = value.hookSpecificOutput;
    if (!isRecord(output) || output.hookEventName !== 'PreToolUse') return false;
    const decision = output.permissionDecision;
    if (decision !== undefined && decision !== 'allow' && decision !== 'deny') return false;
    if (decision === 'deny' && typeof output.permissionDecisionReason !== 'string') return false;
    if (output.updatedInput !== undefined && (decision !== 'allow' || !isRecord(output.updatedInput))) return false;
    return (
      decision !== undefined ||
      typeof output.additionalContext === 'string' ||
      typeof value.systemMessage === 'string'
    );
  }

  if (event === 'PermissionRequest') {
    const output = value.hookSpecificOutput;
    if (!isRecord(output) || output.hookEventName !== 'PermissionRequest' || !isRecord(output.decision)) return false;
    if (output.decision.behavior !== 'allow' && output.decision.behavior !== 'deny') return false;
    return output.decision.behavior !== 'deny' || typeof output.decision.message === 'string';
  }

  return false;
}

function resolveGenieCommand(env = process.env, platform = process.platform, fsApi = {}) {
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  const home = env.GENIE_HOME || pathApi.join(homedir(), '.genie');
  if (!pathApi.isAbsolute(home)) {
    return { error: 'GENIE_HOME must be an absolute path' };
  }

  // A command hook is a host-side trust boundary. Never let cwd, PATH, PATHEXT,
  // or a command-shell shim select what executable receives hook stdin. Windows
  // release installs use the native .exe; extensionless binaries remain a
  // compatibility candidate, but .cmd/.bat files are intentionally excluded
  // because Node can only execute them through a shell.
  const candidates =
    platform === 'win32'
      ? [pathApi.join(home, 'bin', 'genie.exe'), pathApi.join(home, 'bin', 'genie')]
      : [pathApi.join(home, 'bin', 'genie')];
  const inspect = {
    lstat: fsApi.lstat || lstatSync,
    realpath: fsApi.realpath || realpathSync.native,
    access: fsApi.access || accessSync,
  };
  const canonical = candidates.find((candidate) => {
    try {
      const stat = inspect.lstat(candidate);
      if (!stat.isFile() || stat.isSymbolicLink()) return false;
      const resolved = inspect.realpath(candidate);
      const expected = pathApi.resolve(candidate);
      const samePath = platform === 'win32' ? resolved.toLowerCase() === expected.toLowerCase() : resolved === expected;
      if (!samePath) return false;
      if (platform !== 'win32' && (stat.mode & 0o111) === 0) return false;
      inspect.access(candidate, platform === 'win32' ? constants.F_OK : constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
  if (canonical) return { command: canonical, shell: false };
  return { error: `canonical Genie hook dispatcher not found under ${pathApi.join(home, 'bin')}` };
}

function childTimeoutMs(event, runtime, env = process.env) {
  const maximum = event === 'PermissionRequest' || runtime === 'claude' ? 115_000 : 12_000;
  const override = Number(env.GENIE_HOOK_CHILD_TIMEOUT_MS);
  if (Number.isFinite(override) && override > 0) return Math.min(Math.floor(override), maximum);
  return maximum;
}

function killGraceMs(env = process.env) {
  const override = Number(env.GENIE_HOOK_KILL_GRACE_MS);
  return Number.isFinite(override) && override > 0 ? Math.min(Math.floor(override), 1_000) : 1_000;
}

async function launch(runtime, raw, deps = {}) {
  const writeStdout = deps.writeStdout || ((value) => process.stdout.write(value));
  const writeStderr = deps.writeStderr || ((value) => process.stderr.write(value));
  if (runtime !== 'codex' && runtime !== 'claude') {
    writeStdout(codexFailureOutput(raw, `genie hook launcher: unsupported runtime ${JSON.stringify(runtime)}`));
    return 0;
  }
  if (Buffer.byteLength(raw, 'utf8') > MAX_STDIN_BYTES) {
    const message = 'genie hook launcher: input exceeded the safety limit';
    if (runtime === 'codex') {
      writeStdout(codexFailureOutput(raw, message));
      return 0;
    }
    writeStderr(`${message}\n`);
    return 1;
  }

  const entry = parseEntry(raw);
  if (runtime === 'codex') {
    const inputError = codexInputError(entry);
    if (inputError) {
      writeStdout(codexFailureOutput(raw, `genie hook launcher: ${inputError}`));
      return 0;
    }
  }
  const resolved = (deps.resolveCommand || resolveGenieCommand)(process.env, process.platform);
  if (resolved.error || !resolved.command || resolved.shell) {
    const message = `could not start Genie hook dispatcher: ${resolved.error || 'unsafe command resolution'}`;
    if (runtime === 'codex') {
      writeStdout(codexFailureOutput(raw, message));
      return 0;
    }
    writeStderr(`${message}\n`);
    return 1;
  }
  const spawnImpl = deps.spawn || spawn;
  let child;
  try {
    const childEnv = { ...process.env, GENIE_HOOK_RUNTIME: runtime };
    // Plugin-first rollout compatibility: the canonical binary can be one
    // release behind this launcher. Older dispatchers registered Omni on
    // PreToolUse, so explicitly disable it for H4. PermissionRequest remains
    // the only phase allowed to inherit the operator's Omni setting.
    if (runtime === 'codex' && entry.event === 'PreToolUse') {
      childEnv.OMNI_APPROVALS_ENABLED = '0';
    }
    child = spawnImpl(resolved.command, ['hook', 'dispatch'], {
      env: childEnv,
      shell: resolved.shell,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
  } catch (error) {
    const message = `could not start Genie hook dispatcher: ${error instanceof Error ? error.message : String(error)}`;
    if (runtime === 'codex') {
      writeStdout(codexFailureOutput(raw, message));
      return 0;
    }
    writeStderr(`${message}\n`);
    return 1;
  }

  let stdout = '';
  let outputOverflow = false;
  let timedOut = false;
  let settled = false;
  let forceTimer;
  const terminateChild = (signal = 'SIGTERM') => {
    child.kill(signal);
    if (!forceTimer) {
      forceTimer = setTimeout(() => {
        if (!settled) child.kill('SIGKILL');
      }, killGraceMs());
      if (typeof forceTimer.unref === 'function') forceTimer.unref();
    }
  };
  const timer = setTimeout(() => {
    timedOut = true;
    terminateChild();
  }, childTimeoutMs(entry.event, runtime));
  if (typeof timer.unref === 'function') timer.unref();

  let forwardedSignal = null;
  const forwardedSignals = ['SIGINT', 'SIGTERM'].map((signal) => {
    const listener = () => {
      if (forwardedSignal) return;
      forwardedSignal = signal;
      terminateChild(signal);
    };
    process.once(signal, listener);
    return { signal, listener };
  });
  const cleanup = () => {
    clearTimeout(timer);
    if (forceTimer) clearTimeout(forceTimer);
    for (const { signal, listener } of forwardedSignals) process.off(signal, listener);
  };

  child.stdout.on('data', (chunk) => {
    if (outputOverflow) return;
    stdout += chunk.toString();
    if (Buffer.byteLength(stdout, 'utf8') > MAX_STDOUT_BYTES) {
      outputOverflow = true;
      terminateChild();
    }
  });
  child.stderr.on('data', (chunk) => writeStderr(chunk.toString()));
  // A child that fails before consuming stdin can emit EPIPE on this stream in
  // addition to the ChildProcess `error` event. The latter is the one that
  // drives the documented fail-closed response; absorb the duplicate stream
  // error so it cannot crash the launcher first.
  child.stdin.on('error', () => {});
  child.stdin.end(raw);

  return await new Promise((resolve) => {
    const finish = (code, signal, spawnError) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (runtime === 'codex') {
        const failure = spawnError
          ? `could not start Genie hook dispatcher: ${spawnError.message}`
          : timedOut
            ? 'Genie hook dispatcher timed out'
            : outputOverflow
              ? 'Genie hook dispatcher output exceeded the safety limit'
              : code !== 0 || signal
                ? `Genie hook dispatcher failed${signal ? ` with ${signal}` : ` with exit ${code}`}`
                : null;
        if (failure) writeStdout(codexFailureOutput(raw, failure));
        else if (!validCodexOutput(stdout, entry.event)) {
          writeStdout(codexFailureOutput(raw, 'Genie hook dispatcher returned an invalid Codex response'));
        } else writeStdout(stdout);
        resolve(0);
        if (forwardedSignal) process.kill(process.pid, forwardedSignal);
        return;
      }

      writeStdout(stdout);
      resolve(typeof code === 'number' ? code : signal ? 1 : 1);
      if (forwardedSignal) process.kill(process.pid, forwardedSignal);
    };
    child.once('error', (error) => finish(null, null, error));
    child.once('close', (code, signal) => finish(code, signal, null));
  });
}

async function readBoundedStdin(stream = process.stdin, maxBytes = MAX_STDIN_BYTES) {
  const chunks = [];
  let retained = 0;
  let overflow = false;
  for await (const chunk of stream) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const remaining = maxBytes + 1 - retained;
    if (remaining > 0) {
      const kept = bytes.subarray(0, remaining);
      chunks.push(kept);
      retained += kept.byteLength;
    }
    if (retained > maxBytes || bytes.byteLength > Math.max(remaining, 0)) {
      overflow = true;
      if (typeof stream.destroy === 'function') stream.destroy();
      break;
    }
  }
  return { raw: Buffer.concat(chunks).toString('utf8'), overflow };
}

async function main() {
  const { raw, overflow } = await readBoundedStdin();
  if (overflow) {
    const message = 'genie hook launcher: input exceeded the safety limit';
    if (process.argv[2] === 'codex') {
      process.stdout.write(codexFailureOutput(raw, message));
      process.exitCode = 0;
    } else {
      process.stderr.write(`${message}\n`);
      process.exitCode = 1;
    }
    return;
  }
  process.exitCode = await launch(process.argv[2], raw);
}

module.exports = {
  childTimeoutMs,
  codexFailureOutput,
  launch,
  parseEntry,
  readBoundedStdin,
  resolveGenieCommand,
  validCodexOutput,
};

if (require.main === module) {
  main().catch((error) => {
    const raw = '';
    process.stdout.write(codexFailureOutput(raw, `genie hook launcher crashed: ${error instanceof Error ? error.message : String(error)}`));
    process.exitCode = 0;
  });
}
