/**
 * Group E — the ONE bounded Codex host observation per doctor run.
 *
 * Doctor previously spawned `codex plugin list --json` twice — once through
 * `probeCodexGeniePlugin` (feeding the check list) and once through
 * `observeCodexActivation` (feeding the integration summary/trailer/exit) —
 * with divergent stderr policy: the probe ignored exit-0 stderr while the
 * activation observer failed closed on ANY stderr. A single benign sandbox
 * PATH advisory therefore produced a healthy check list alongside a
 * query-failed integration summary and exit 1: two contradictory answers to
 * one question from one host.
 *
 * This module runs the bounded query EXACTLY ONCE, classifies the result
 * through Group B's `parseCodexHostObservation` (Decision 11: exit 0 plus
 * exactly one schema-valid JSON stdout value succeeds; bounded advisory stderr
 * is retained only as sanitized diagnostic metadata, never a second policy
 * decision), and derives every downstream doctor input from that single
 * observation:
 *
 *  - a `CodexPluginProbe` via `probeCodexGeniePlugin`'s replay seam;
 *  - a replay `CommandRunner` for `observeCodexActivation` — the SAME captured
 *    bytes, with advisory stderr blanked ONLY when the observation succeeded,
 *    so the fail-closed activation parser cannot contradict the check list
 *    while every real failure (timeout, overflow, nonzero exit, malformed or
 *    duplicate JSON) replays raw and fails both surfaces consistently;
 *  - the sanitized advisory text for diagnostics.
 *
 * Pure over the injected seams; the only IO is the one bounded subprocess and
 * Group B's bounded cache-family witness.
 */

import {
  type CodexHostObservation,
  type HostQueryProjection,
  parseCodexHostObservation,
  projectHostQuery,
  witnessCodexCacheFamily,
} from './codex-host-observation.js';
import { type CodexPluginProbe, type CodexProbeCommandResult, probeCodexGeniePlugin } from './codex-project-mcp.js';
import { resolveCodexDir } from './genie-home.js';
import { type CommandResult, type CommandRunner, runBoundedIntegrationCommand } from './runtime-integrations.js';

/** Same bounds `observeCodexActivation` applies to its own plugin query. */
const PLUGIN_LIST_TIMEOUT_MS = 5_000;
const PLUGIN_LIST_MAX_BYTES = 64 * 1024;

export interface DoctorCodexObservationDeps {
  /** Codex CLI resolution seam; default is a safe `Bun.which`. */
  which?: (name: string) => string | null;
  /** Bounded subprocess seam; default is the shared integration runner. */
  runner?: CommandRunner;
  codexHome?: string;
  cwd?: string;
}

export interface DoctorCodexObservation {
  /** Absolute Codex CLI path, or null when the CLI is absent (Claude-only host). */
  codexCommand: string | null;
  /** Group B's typed observation of the one bounded query; null when the CLI is absent. */
  observation: CodexHostObservation | null;
  /** The single projection every doctor surface derives from; null when the CLI is absent. */
  projection: HostQueryProjection | null;
  /** Sanitized, bounded advisory stderr (e.g. the real sandbox PATH advisory); diagnostic metadata only. */
  advisory: string | null;
  /** The check-list probe, derived from the SAME captured query result. */
  probe: CodexPluginProbe;
  /** Replay runner for `observeCodexActivation`; null when the CLI is absent. */
  activationRunner: CommandRunner | null;
}

/**
 * Observe the Codex host once and derive every doctor-side consumer input.
 * Spawns exactly one bounded `codex plugin list --json` when the CLI is
 * present, and nothing at all when it is absent.
 */
export function observeDoctorCodexHost(deps: DoctorCodexObservationDeps = {}): DoctorCodexObservation {
  const which = deps.which ?? safeWhich;
  const codexCommand = which('codex');
  if (codexCommand === null) {
    return {
      codexCommand: null,
      observation: null,
      projection: null,
      advisory: null,
      probe: probeCodexGeniePlugin({ which: () => null }),
      activationRunner: null,
    };
  }
  const codexHome = deps.codexHome ?? resolveCodexDir();
  const cacheFamily = witnessCodexCacheFamily(codexHome);
  const runner = deps.runner ?? runBoundedIntegrationCommand;
  const result = runner(codexCommand, ['plugin', 'list', '--json'], {
    timeoutMs: PLUGIN_LIST_TIMEOUT_MS,
    maxOutputBytes: PLUGIN_LIST_MAX_BYTES,
  });
  const observation = parseCodexHostObservation({ result, cacheFamily });
  const projection = projectHostQuery(observation);
  const probe = probeCodexGeniePlugin({
    which: () => codexCommand,
    codexHome,
    cwd: deps.cwd,
    run: () => replayProbeResult(result),
  });
  // Decision 11 applied once, at the seam: an ok observation already proved
  // exit 0 + exactly one schema-valid JSON value, so its advisory stderr is
  // metadata — blank it for the fail-closed activation parser. Every failed
  // observation replays the raw bytes so both parsers fail for the same fact.
  const activationRunner: CommandRunner =
    observation.status === 'ok' ? () => ({ ...result, stderr: '' }) : () => result;
  return {
    codexCommand,
    observation,
    projection,
    advisory: projection.advisory,
    probe,
    activationRunner,
  };
}

/** Map the captured bounded result onto the probe's replay-runner shape. */
function replayProbeResult(result: CommandResult): CodexProbeCommandResult {
  if (result.outputOverflow === true) {
    // The probe runner shape has no overflow flag; a truncated stdout must not
    // parse as a smaller valid answer (e.g. "not installed"), so overflow
    // replays as an explicit command failure on both surfaces.
    return {
      exitCode: 1,
      stdout: '',
      stderr: 'codex plugin list exceeded the bounded output cap',
      timedOut: false,
    };
  }
  return {
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    timedOut: result.timedOut === true,
  };
}

function safeWhich(name: string): string | null {
  try {
    return Bun.which(name);
  } catch {
    return null;
  }
}
