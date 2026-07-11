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
const { createHash, timingSafeEqual } = require('node:crypto');
const { constants, accessSync, lstatSync, readFileSync, realpathSync } = require('node:fs');
const { homedir } = require('node:os');
const path = require('node:path');

const MAX_STDIN_BYTES = 1024 * 1024;
const MAX_STDOUT_BYTES = 64 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;
const CODEX_EVENTS = new Set(['PreToolUse', 'PermissionRequest']);
const CODEX_LAUNCHER_CONTRACT = 'genie-codex-dispatch-v1';

/** @typedef {'codex' | 'claude'} HookRuntime */
/** @typedef {{error?: string, event?: string, tool?: string, input?: unknown}} ParsedEntry */
/**
 * @typedef {object} ResolverFs
 * @property {typeof lstatSync} [lstat]
 * @property {typeof realpathSync.native} [realpath]
 * @property {typeof accessSync} [access]
 */
/**
 * @typedef {object} LaunchDeps
 * @property {(value: string) => void} [writeStdout]
 * @property {(value: string) => void} [writeStderr]
 * @property {typeof spawn} [spawn]
 * @property {typeof resolveGenieCommand} [resolveCommand]
 */

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Hash the exact physical launcher file Codex is about to execute. A symlink is
 * rejected because its target can change without changing the reviewed hook
 * definition.
 *
 * @param {string} [launcherPath]
 * @param {{lstat?: typeof lstatSync, readFile?: typeof readFileSync}} [fsApi]
 * @returns {{digest: string} | {error: string}}
 */
function launcherSha256(launcherPath = __filename, fsApi = {}) {
  try {
    const stat = (fsApi.lstat || lstatSync)(launcherPath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      return { error: 'launcher must be a physical file' };
    }
    const bytes = (fsApi.readFile || readFileSync)(launcherPath);
    return { digest: createHash('sha256').update(bytes).digest('hex') };
  } catch (error) {
    return { error: `could not hash launcher: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/**
 * @param {string | undefined} expectedDigest
 * @param {string | undefined} expectedContract
 * @param {string} [launcherPath]
 * @param {{lstat?: typeof lstatSync, readFile?: typeof readFileSync}} [fsApi]
 * @returns {string | null}
 */
function launcherBindingError(expectedDigest, expectedContract, launcherPath = __filename, fsApi = {}) {
  if (expectedContract !== CODEX_LAUNCHER_CONTRACT) {
    return 'launcher contract version is missing or does not match the reviewed definition';
  }
  if (typeof expectedDigest !== 'string' || !/^[a-f0-9]{64}$/.test(expectedDigest)) {
    return 'launcher SHA-256 is missing or malformed';
  }
  const actual = launcherSha256(launcherPath, fsApi);
  if ('error' in actual) return actual.error;
  const matches = timingSafeEqual(Buffer.from(actual.digest, 'hex'), Buffer.from(expectedDigest, 'hex'));
  return matches ? null : 'launcher bytes do not match the reviewed hook definition';
}

/** @param {string[]} args */
function parseLauncherBindingArgs(args) {
  if (
    args.length !== 4 ||
    args[0] !== '--launcher-contract' ||
    args[2] !== '--launcher-sha256'
  ) {
    return { error: 'launcher binding flags are missing or malformed' };
  }
  return { contract: args[1], digest: args[3] };
}

/** @param {string} raw @returns {ParsedEntry} */
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

/** @param {ParsedEntry} entry @returns {string | null} */
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

/** @param {string} raw @param {string} reason @param {string | undefined} expectedEvent */
function codexFailureOutput(raw, reason, expectedEvent) {
  const parsed = parseEntry(raw);
  const event = expectedEvent !== undefined && CODEX_EVENTS.has(expectedEvent) ? expectedEvent : parsed.event;
  const { tool } = parsed;
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
  // When an oversized/malformed frame lost its event identity, H6 is the
  // conservative boundary: emit a structurally valid permission denial rather
  // than a generic shape the host can reject or ignore.
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PermissionRequest',
      decision: { behavior: 'deny', message: reason },
    },
  });
}

/** @param {string} raw @param {string | undefined} event */
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

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @param {NodeJS.Platform} [platform]
 * @param {ResolverFs} [fsApi]
 */
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

/** @param {string | undefined} event @param {HookRuntime} runtime @param {NodeJS.ProcessEnv} [env] */
function childTimeoutMs(event, runtime, env = process.env) {
  const maximum = event === 'PermissionRequest' || runtime === 'claude' ? 115_000 : 12_000;
  const override = Number(env.GENIE_HOOK_CHILD_TIMEOUT_MS);
  if (Number.isFinite(override) && override > 0) return Math.min(Math.floor(override), maximum);
  return maximum;
}

/** @param {NodeJS.ProcessEnv} [env] */
function killGraceMs(env = process.env) {
  const override = Number(env.GENIE_HOOK_KILL_GRACE_MS);
  return Number.isFinite(override) && override > 0 ? Math.min(Math.floor(override), 1_000) : 1_000;
}

/**
 * @param {string} runtime
 * @param {string} raw
 * @param {LaunchDeps} [deps]
 * @param {string} [expectedEvent]
 * @returns {Promise<number>}
 */
async function launch(runtime, raw, deps = {}, expectedEvent) {
  const writeStdout = deps.writeStdout || ((value) => process.stdout.write(value));
  const writeStderr = deps.writeStderr || ((value) => process.stderr.write(value));
  if (runtime !== 'codex' && runtime !== 'claude') {
    writeStdout(codexFailureOutput(raw, `genie hook launcher: unsupported runtime ${JSON.stringify(runtime)}`, expectedEvent));
    return 0;
  }
  if (Buffer.byteLength(raw, 'utf8') > MAX_STDIN_BYTES) {
    const message = 'genie hook launcher: input exceeded the safety limit';
    if (runtime === 'codex') {
      writeStdout(codexFailureOutput(raw, message, expectedEvent));
      return 0;
    }
    writeStderr(`${message}\n`);
    return 2;
  }

  const entry = parseEntry(raw);
  if (runtime === 'codex') {
    if (expectedEvent !== undefined && CODEX_EVENTS.has(expectedEvent) && entry.event !== expectedEvent) {
      writeStdout(codexFailureOutput(raw, `genie hook launcher: payload event does not match ${expectedEvent}`, expectedEvent));
      return 0;
    }
    const inputError = codexInputError(entry);
    if (inputError) {
      writeStdout(codexFailureOutput(raw, `genie hook launcher: ${inputError}`, expectedEvent));
      return 0;
    }
  }
  const resolved = (deps.resolveCommand || resolveGenieCommand)(process.env, process.platform);
  if (resolved.error || !resolved.command || resolved.shell) {
    const message = `could not start Genie hook dispatcher: ${resolved.error || 'unsafe command resolution'}`;
    if (runtime === 'codex') {
      writeStdout(codexFailureOutput(raw, message, expectedEvent));
      return 0;
    }
    writeStderr(`${message}\n`);
    return 2;
  }
  const spawnImpl = deps.spawn || spawn;
  /** @type {import('node:child_process').ChildProcessWithoutNullStreams} */
  let child;
  try {
    /** @type {NodeJS.ProcessEnv} */
    const childEnv = { ...process.env, GENIE_HOOK_RUNTIME: runtime };
    // Plugin-first rollout compatibility: the canonical binary can be one
    // release behind this launcher. Older dispatchers registered Omni on
    // PreToolUse, so explicitly disable it for H4. PermissionRequest remains
    // the only phase allowed to inherit the operator's Omni setting.
    if (runtime === 'codex' && entry.event === 'PreToolUse') {
      childEnv.OMNI_APPROVALS_ENABLED = '0';
    }
    child = /** @type {import('node:child_process').ChildProcessWithoutNullStreams} */ (spawnImpl(resolved.command, ['hook', 'dispatch'], {
      env: childEnv,
      shell: resolved.shell,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      // A distinct POSIX process group lets TERM→KILL reach every descendant,
      // including helpers that inherited the dispatcher pipes.
      detached: process.platform !== 'win32',
    }));
  } catch (error) {
    const message = `could not start Genie hook dispatcher: ${error instanceof Error ? error.message : String(error)}`;
    if (runtime === 'codex') {
      writeStdout(codexFailureOutput(raw, message, expectedEvent));
      return 0;
    }
    writeStderr(`${message}\n`);
    return 2;
  }

  let stdout = '';
  /** @type {Buffer[]} */
  const stderrChunks = [];
  let stderrBytes = 0;
  let stderrOverflow = false;
  let outputOverflow = false;
  let timedOut = false;
  let settled = false;
  /** @type {NodeJS.Timeout | undefined} */
  let forceTimer;
  let forceEscalated = false;
  /** @type {(() => void) | undefined} */
  let finishAfterEscalation;
  /** @param {NodeJS.Signals} signal */
  const signalChildTree = (signal) => {
    const childPid = child.pid;
    if (process.platform !== 'win32' && typeof childPid === 'number' && Number.isSafeInteger(childPid) && childPid > 0) {
      try {
        process.kill(-childPid, signal);
        return;
      } catch {
        // The group leader may have exited between observation and signalling.
      }
    }
    child.kill(signal);
  };
  /** @param {NodeJS.Signals} [signal] */
  const terminateChild = (signal = 'SIGTERM') => {
    signalChildTree(signal);
    if (!forceTimer) {
      forceTimer = setTimeout(() => {
        forceEscalated = true;
        if (!settled) signalChildTree('SIGKILL');
        if (finishAfterEscalation) {
          const finish = finishAfterEscalation;
          finishAfterEscalation = undefined;
          finish();
        }
      }, killGraceMs());
      // A POSIX parent may exit on TERM while a resistant descendant remains.
      // Keep the launcher alive until group KILL has run; direct Windows child
      // supervision retains the prior unref behavior.
      if (process.platform === 'win32' && typeof forceTimer.unref === 'function') forceTimer.unref();
    }
  };
  const timer = setTimeout(() => {
    timedOut = true;
    terminateChild();
  }, childTimeoutMs(entry.event, runtime));
  if (typeof timer.unref === 'function') timer.unref();

  /** @type {NodeJS.Signals | null} */
  let forwardedSignal = null;
  /** @type {NodeJS.Signals[]} */
  const forwardedSignalNames = ['SIGINT', 'SIGTERM'];
  const forwardedSignals = forwardedSignalNames.map((signal) => {
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

  child.stdout.on('data', (/** @type {Buffer | string} */ chunk) => {
    if (outputOverflow) return;
    stdout += chunk.toString();
    if (Buffer.byteLength(stdout, 'utf8') > MAX_STDOUT_BYTES) {
      outputOverflow = true;
      terminateChild();
    }
  });
  child.stderr.on('data', (/** @type {Buffer | string} */ chunk) => {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const remaining = MAX_STDERR_BYTES - stderrBytes;
    if (remaining > 0) {
      const kept = bytes.subarray(0, remaining);
      stderrChunks.push(kept);
      stderrBytes += kept.byteLength;
    }
    if (bytes.byteLength > Math.max(remaining, 0)) {
      stderrOverflow = true;
      // Bounded retention alone still lets a noisy or hostile dispatcher burn
      // CPU until the outer deadline. Treat overflow as a launcher failure and
      // begin the same bounded process-group teardown as stdout overflow.
      terminateChild();
    }
  });
  // A child that fails before consuming stdin can emit EPIPE on this stream in
  // addition to the ChildProcess `error` event. The latter is the one that
  // drives the documented fail-closed response; absorb the duplicate stream
  // error so it cannot crash the launcher first.
  child.stdin.on('error', () => {});
  child.stdin.end(raw);

  return await new Promise((resolve) => {
    /**
     * @param {number | null} code
     * @param {NodeJS.Signals | null} signal
     * @param {Error | null} spawnError
     */
    const finish = (code, signal, spawnError) => {
      if (settled) return;
      const childPid = child.pid;
      if (
        !forceTimer &&
        process.platform !== 'win32' &&
        typeof childPid === 'number' &&
        Number.isSafeInteger(childPid) &&
        childPid > 0
      ) {
        try {
          process.kill(-childPid, 0);
          // The direct child has closed but its group still exists: reap any
          // daemonized dispatcher helper before the launcher can return.
          terminateChild();
        } catch {
          // Empty group — normal direct-child completion.
        }
      }
      if (forceTimer && process.platform !== 'win32' && !forceEscalated) {
        let groupStillAlive = false;
        if (typeof childPid === 'number' && Number.isSafeInteger(childPid) && childPid > 0) {
          try {
            process.kill(-childPid, 0);
            groupStillAlive = true;
          } catch {
            // No process remains in the group; finish without waiting for grace.
          }
        }
        if (groupStillAlive) {
          finishAfterEscalation = () => finish(code, signal, spawnError);
          return;
        }
        forceEscalated = true;
      }
      settled = true;
      cleanup();
      if (stderrChunks.length > 0 || stderrOverflow) {
        const bounded = Buffer.concat(stderrChunks).toString('utf8');
        writeStderr(`${bounded}${stderrOverflow ? '\n[genie hook launcher: stderr truncated]\n' : ''}`);
      }
      const failure = spawnError
        ? `could not start Genie hook dispatcher: ${spawnError.message}`
        : timedOut
          ? 'Genie hook dispatcher timed out'
          : outputOverflow
            ? 'Genie hook dispatcher output exceeded the safety limit'
            : stderrOverflow
              ? 'Genie hook dispatcher stderr exceeded the safety limit'
              : code !== 0 || signal
                ? `Genie hook dispatcher failed${signal ? ` with ${signal}` : ` with exit ${code}`}`
                : null;
      if (runtime === 'codex') {
        if (failure) writeStdout(codexFailureOutput(raw, failure, expectedEvent));
        else if (!validCodexOutput(stdout, entry.event)) {
          writeStdout(codexFailureOutput(raw, 'Genie hook dispatcher returned an invalid Codex response', expectedEvent));
        } else writeStdout(stdout);
        resolve(0);
        if (forwardedSignal) process.kill(process.pid, forwardedSignal);
        return;
      }

      if (failure) {
        // Claude treats a non-zero command-hook result as blocking. Resource
        // guardrails and spawn failures are launcher failures even when a fake
        // or stale child exits zero after TERM. Never forward a truncated
        // stdout prefix that Claude could interpret as a successful response.
        if (!outputOverflow && !timedOut && !spawnError && !signal) writeStdout(stdout);
        writeStderr(`[genie hook launcher: ${failure}]\n`);
        // Claude Code only treats command-hook exit 2 as a blocking failure.
        // Normalize every launcher-generated failure, including a stale child
        // exit status, so a broken guardrail cannot silently fail open.
        resolve(2);
      } else {
        writeStdout(stdout);
        resolve(0);
      }
      if (forwardedSignal) process.kill(process.pid, forwardedSignal);
    };
    child.once('error', (error) => finish(null, null, error));
    child.once('close', (code, signal) => finish(code, signal, null));
  });
}

/**
 * @param {import('node:stream').Readable} [stream]
 * @param {number} [maxBytes]
 */
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
  const runtime = process.argv[2];
  const expectedEvent = process.argv[3];
  const binding = runtime === 'codex' ? parseLauncherBindingArgs(process.argv.slice(4)) : null;
  const { raw, overflow } = await readBoundedStdin();
  if (overflow) {
    const message = 'genie hook launcher: input exceeded the safety limit';
    if (runtime === 'codex') {
      process.stdout.write(codexFailureOutput(raw, message, expectedEvent));
      process.exitCode = 0;
    } else {
      process.stderr.write(`${message}\n`);
      process.exitCode = 2;
    }
    return;
  }
  if (runtime === 'codex') {
    const error = binding && 'error' in binding
      ? binding.error
      : launcherBindingError(binding?.digest, binding?.contract);
    if (error) {
      process.stdout.write(codexFailureOutput(raw, `genie hook launcher: ${error}`, expectedEvent));
      process.exitCode = 0;
      return;
    }
  }
  process.exitCode = await launch(runtime, raw, {}, expectedEvent);
}

module.exports = {
  childTimeoutMs,
  CODEX_LAUNCHER_CONTRACT,
  codexFailureOutput,
  launcherBindingError,
  launcherSha256,
  launch,
  parseEntry,
  parseLauncherBindingArgs,
  readBoundedStdin,
  resolveGenieCommand,
  validCodexOutput,
};

if (require.main === module) {
  main().catch((error) => {
    const message = `genie hook launcher crashed: ${error instanceof Error ? error.message : String(error)}`;
    if (process.argv[2] === 'codex') {
      process.stdout.write(codexFailureOutput('', message, process.argv[3]));
      process.exitCode = 0;
    } else {
      process.stderr.write(`${message}\n`);
      process.exitCode = 2;
    }
  });
}
