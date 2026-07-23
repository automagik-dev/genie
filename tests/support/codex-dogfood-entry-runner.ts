#!/usr/bin/env bun

import type { DeliveryEvidencePlatformId } from '../../src/lib/codex-delivery-evidence.js';
import { type DogfoodEntryInput, type GenerationInputPaths, runDogfoodEntry } from './codex-dogfood-harness.js';

const ENV_KEYS = {
  previousArtifact: 'DOGFOOD_N_ARTIFACT',
  previousManifest: 'DOGFOOD_N_MANIFEST',
  previousProvenance: 'DOGFOOD_N_PROVENANCE',
  previousBundle: 'DOGFOOD_N_BUNDLE',
  candidateArtifact: 'DOGFOOD_T_ARTIFACT',
  candidateManifest: 'DOGFOOD_T_MANIFEST',
  candidateDescriptor: 'DOGFOOD_T_DESCRIPTOR',
  candidateBundle: 'DOGFOOD_T_BUNDLE',
  platformId: 'DOGFOOD_PLATFORM_ID',
  outputEvidence: 'DOGFOOD_EVIDENCE_OUT',
  executionAdapter: 'DOGFOOD_EXECUTION_ADAPTER',
} as const;

const ARG_KEYS: Record<string, keyof typeof ENV_KEYS> = {
  '--previous-artifact': 'previousArtifact',
  '--previous-manifest': 'previousManifest',
  '--previous-provenance': 'previousProvenance',
  '--previous-bundle': 'previousBundle',
  '--candidate-artifact': 'candidateArtifact',
  '--candidate-manifest': 'candidateManifest',
  '--candidate-descriptor': 'candidateDescriptor',
  '--candidate-bundle': 'candidateBundle',
  '--platform-id': 'platformId',
  '--output-evidence': 'outputEvidence',
  '--execution-adapter': 'executionAdapter',
};

function parseArgs(argv: string[]): Record<keyof typeof ENV_KEYS, string | undefined> {
  const values = Object.fromEntries(Object.entries(ENV_KEYS).map(([key, env]) => [key, process.env[env]])) as Record<
    keyof typeof ENV_KEYS,
    string | undefined
  >;
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    const key = flag === undefined ? undefined : ARG_KEYS[flag];
    if (key === undefined || value === undefined || value === '') throw new Error(`invalid argument: ${flag ?? ''}`);
    values[key] = value;
  }
  return values;
}

function required(values: Record<keyof typeof ENV_KEYS, string | undefined>, key: keyof typeof ENV_KEYS): string {
  const value = values[key];
  if (value === undefined || value === '') {
    throw new Error(`missing --${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)} or ${ENV_KEYS[key]}`);
  }
  return value;
}

function generation(
  values: Record<keyof typeof ENV_KEYS, string | undefined>,
  prefix: 'previous' | 'candidate',
): GenerationInputPaths {
  return {
    artifact: required(values, `${prefix}Artifact`),
    manifest: required(values, `${prefix}Manifest`),
    identity: prefix === 'previous' ? required(values, 'previousProvenance') : required(values, 'candidateDescriptor'),
    bundle: required(values, `${prefix}Bundle`),
    identityKind: prefix === 'previous' ? 'slsa-provenance' : 'delivery-descriptor',
  };
}

async function main(): Promise<void> {
  const values = parseArgs(process.argv.slice(2));
  const input: DogfoodEntryInput = {
    previous: generation(values, 'previous'),
    candidate: generation(values, 'candidate'),
    platformId: required(values, 'platformId') as DeliveryEvidencePlatformId,
    outputEvidence: required(values, 'outputEvidence'),
    executionAdapter: values.executionAdapter,
    evidenceKind: 'host-native',
  };
  const result = await runDogfoodEntry(input);
  process.stdout.write(`codex-dogfood-entry: OK ${result.outputEvidence}\n`);
}

try {
  await main();
} catch (error) {
  process.stderr.write(`codex-dogfood-entry: FAIL — ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
