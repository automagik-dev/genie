import {
  OrcaAdapterError,
  type OrcaAdapterOptions,
  type OrcaAdapterResponse,
  type OrcaOperation,
  type OrcaOrchestrationAdapter,
  createOrcaOrchestrationAdapter,
} from '../../src/lib/orca-orchestration-adapter';

export const ORCA_MINIMUM_RUNTIME_VERSION = '1.4.205';
export const ORCA_REQUIRED_CONTRACT = 'orchestration.contract.v1';

/**
 * Process bound for every adapter call a palette handler makes. Orca rejects a
 * plugin command after 30 000 ms, so the send path's two reads (8 s each) and
 * the start path's own 15 s `worker-start` all fit inside one host window.
 */
export const ORCA_PLUGIN_ADAPTER_TIMEOUT_MS = 8_000;

export interface OrcaPluginCompatibility {
  readonly runtimeId: string;
  readonly runtimeVersion: string;
  readonly contract: typeof ORCA_REQUIRED_CONTRACT;
}

export interface OrcaPluginRuntime {
  probe(): Promise<OrcaPluginCompatibility>;
  execute(operation: OrcaOperation): Promise<OrcaAdapterResponse>;
}

function unsupportedEnvironment(message: string): OrcaAdapterError {
  return new OrcaAdapterError(
    'unsupported_environment',
    'runtime',
    'resolve',
    'safe',
    'Run this plugin in a supported Orca host with the public orchestration contract and child-process access.',
    message,
  );
}

interface ParsedVersion {
  readonly release: readonly number[];
  readonly prerelease: readonly string[];
}

/**
 * Semver parse. Build metadata is discarded (it never affects precedence); the
 * prerelease identifiers are kept, because dropping them made `1.4.205-rc.1`
 * compare equal to the released `1.4.205` and satisfy `>=1.4.205`.
 */
function parseVersion(value: string): ParsedVersion | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(value);
  if (match === null) return undefined;
  return {
    release: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] === undefined ? [] : match[4].split('.'),
  };
}

/** Semver §11 precedence for prerelease identifiers; a release outranks any prerelease. */
function comparePrerelease(left: readonly string[], right: readonly string[]): number {
  if (left.length === 0 || right.length === 0) return right.length - left.length;
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const a = left[index];
    const b = right[index];
    if (a === undefined || b === undefined) return a === undefined ? -1 : 1;
    const aNumeric = /^\d+$/.test(a);
    const bNumeric = /^\d+$/.test(b);
    // Numeric identifiers always rank below alphanumeric ones.
    if (aNumeric !== bNumeric) return aNumeric ? -1 : 1;
    if (aNumeric && Number(a) !== Number(b)) return Number(a) < Number(b) ? -1 : 1;
    if (!aNumeric && a !== b) return a < b ? -1 : 1;
  }
  return 0;
}

function versionAtLeast(actual: string, minimum: string): boolean {
  const left = parseVersion(actual);
  const right = parseVersion(minimum);
  if (left === undefined || right === undefined) return false;
  for (let index = 0; index < 3; index += 1) {
    if (left.release[index] !== right.release[index]) return left.release[index] > right.release[index];
  }
  return comparePrerelease(left.prerelease, right.prerelease) >= 0;
}

async function probe(adapter: OrcaOrchestrationAdapter): Promise<OrcaPluginCompatibility> {
  try {
    const response = await adapter.status();
    const runtimeId = response.result.runtime.runtimeId;
    const runtimeVersion = response.result.runtime.appVersion;
    if (
      !versionAtLeast(runtimeVersion, ORCA_MINIMUM_RUNTIME_VERSION) ||
      !response.result.runtime.capabilities.includes(ORCA_REQUIRED_CONTRACT)
    ) {
      throw unsupportedEnvironment('Orca runtime version or orchestration contract is outside the supported range.');
    }
    return Object.freeze({ runtimeId, runtimeVersion, contract: ORCA_REQUIRED_CONTRACT });
  } catch (error) {
    if (error instanceof OrcaAdapterError && error.code === 'unsupported_environment') throw error;
    throw unsupportedEnvironment('The Orca compatibility probe could not complete through the public adapter.');
  }
}

export function createOrcaPluginRuntime(
  adapter?: OrcaOrchestrationAdapter,
  createAdapter: (options: OrcaAdapterOptions) => OrcaOrchestrationAdapter = createOrcaOrchestrationAdapter,
): OrcaPluginRuntime {
  let resolved = adapter;
  /**
   * Built on first use, never while the module is being imported: an Orca host
   * this plugin cannot support would otherwise make the whole plugin fail to
   * load instead of turning one palette command into one notification.
   */
  const use = (): OrcaOrchestrationAdapter => {
    resolved ??= createAdapter({ timeoutMs: ORCA_PLUGIN_ADAPTER_TIMEOUT_MS });
    return resolved;
  };
  /**
   * One probe per runtime instance (design decision 16). A per-call probe spent
   * one of the few child processes the host's 30 s command window allows. A
   * REJECTED probe is deliberately not remembered, so a host that becomes
   * healthy is probed again on the next invocation.
   */
  let probed: Promise<OrcaPluginCompatibility> | undefined;
  const compatibility = (): Promise<OrcaPluginCompatibility> => {
    probed ??= probe(use()).catch((error: unknown) => {
      probed = undefined;
      throw error;
    });
    return probed;
  };
  return Object.freeze({
    probe: compatibility,
    async execute(operation: OrcaOperation): Promise<OrcaAdapterResponse> {
      await compatibility();
      // The operation passes through unchanged, so its own `timeoutMs` reaches
      // the adapter and bounds that one child process.
      return use().execute(operation);
    },
  });
}
