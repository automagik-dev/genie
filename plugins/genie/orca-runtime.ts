import {
  OrcaAdapterError,
  type OrcaAdapterResponse,
  type OrcaOperation,
  type OrcaOrchestrationAdapter,
  createOrcaOrchestrationAdapter,
} from '../../src/lib/orca-orchestration-adapter';

export const ORCA_MINIMUM_RUNTIME_VERSION = '1.4.193';
export const ORCA_REQUIRED_CONTRACT = 'orchestration.contract.v1';

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

function versionParts(value: string): readonly number[] | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(value);
  if (match === null) return undefined;
  return match.slice(1).map(Number);
}

function versionAtLeast(actual: string, minimum: string): boolean {
  const left = versionParts(actual);
  const right = versionParts(minimum);
  if (left === undefined || right === undefined) return false;
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] > right[index];
  }
  return true;
}

async function probe(adapter: OrcaOrchestrationAdapter): Promise<OrcaPluginCompatibility> {
  try {
    const response = await adapter.execute({ operation: 'run-list', limit: 1 });
    const runtimeId = response._meta?.runtimeId;
    const runtimeVersion = response._meta?.runtimeVersion;
    if (
      runtimeId === undefined ||
      runtimeVersion === undefined ||
      !versionAtLeast(runtimeVersion, ORCA_MINIMUM_RUNTIME_VERSION)
    ) {
      throw unsupportedEnvironment('Orca runtime compatibility metadata is absent or outside the supported range.');
    }
    return Object.freeze({ runtimeId, runtimeVersion, contract: ORCA_REQUIRED_CONTRACT });
  } catch (error) {
    if (error instanceof OrcaAdapterError && error.code === 'unsupported_environment') throw error;
    throw unsupportedEnvironment('The Orca compatibility probe could not complete through the public adapter.');
  }
}

export function createOrcaPluginRuntime(
  adapter: OrcaOrchestrationAdapter = createOrcaOrchestrationAdapter(),
): OrcaPluginRuntime {
  return Object.freeze({
    probe: () => probe(adapter),
    async execute(operation: OrcaOperation): Promise<OrcaAdapterResponse> {
      await probe(adapter);
      return adapter.execute(operation);
    },
  });
}
