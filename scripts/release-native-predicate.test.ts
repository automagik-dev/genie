import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = join(import.meta.dir, 'release-native-predicate.sh');
const SOURCE_SHA = 'a'.repeat(40);
const CONTROL_SHA = 'b'.repeat(40);
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const env = {
  ...process.env,
  RELEASE_REPOSITORY: 'automagik-dev/genie',
  VERSION: '5.260714.2',
  CHANNEL: 'dev',
  SOURCE_SHA,
  SOURCE_BRANCH: 'dev',
  SOURCE_CI_RUN_ID: '123456',
  CONTROL_SHA,
  RUN_ID: '987654',
  RUN_ATTEMPT: '2',
};

function invoke(
  mode: 'create' | 'verify' | 'verify-reusable' | 'reusable-control-sha',
  path: string,
  overrides: Record<string, string> = {},
) {
  return Bun.spawnSync(['bash', SCRIPT, mode, path], {
    env: { ...env, ...overrides },
    stdout: 'pipe',
    stderr: 'pipe',
  });
}

describe('native release attestation predicate', () => {
  test('records distinct exact source and trusted control dependencies', () => {
    const root = mkdtempSync(join(tmpdir(), 'genie-native-predicate-'));
    roots.push(root);
    const predicatePath = join(root, 'predicate.json');
    expect(invoke('create', predicatePath).exitCode).toBe(0);
    const predicate = JSON.parse(readFileSync(predicatePath, 'utf8'));
    expect(predicate.buildDefinition.externalParameters.source_sha).toBe(SOURCE_SHA);
    expect(predicate.buildDefinition.externalParameters.control_sha).toBe(CONTROL_SHA);
    expect(predicate.buildDefinition.resolvedDependencies).toEqual([
      {
        uri: 'git+https://github.com/automagik-dev/genie@refs/heads/dev',
        digest: { gitCommit: SOURCE_SHA },
      },
      {
        uri: 'git+https://github.com/automagik-dev/genie@refs/heads/main',
        digest: { gitCommit: CONTROL_SHA },
      },
    ]);
  });

  test('verification requires the exact source and control identities', () => {
    const root = mkdtempSync(join(tmpdir(), 'genie-native-policy-'));
    roots.push(root);
    const predicatePath = join(root, 'predicate.json');
    const resultPath = join(root, 'result.json');
    expect(invoke('create', predicatePath).exitCode).toBe(0);
    const predicate = JSON.parse(readFileSync(predicatePath, 'utf8'));
    const verification = [
      {
        verificationResult: {
          statement: { predicateType: 'https://github.com/automagik-dev/genie/release-tarballs/v1', predicate },
        },
      },
    ];
    writeFileSync(resultPath, JSON.stringify(verification));
    expect(invoke('verify', resultPath).exitCode).toBe(0);

    predicate.buildDefinition.resolvedDependencies[0].digest.gitCommit = 'c'.repeat(40);
    writeFileSync(resultPath, JSON.stringify(verification));
    expect(invoke('verify', resultPath).exitCode).not.toBe(0);

    predicate.buildDefinition.resolvedDependencies[0].digest.gitCommit = SOURCE_SHA;
    predicate.buildDefinition.resolvedDependencies[1].digest.gitCommit = 'd'.repeat(40);
    writeFileSync(resultPath, JSON.stringify(verification));
    expect(invoke('verify', resultPath).exitCode).not.toBe(0);
  });

  test('malformed source identity is rejected before predicate creation', () => {
    const root = mkdtempSync(join(tmpdir(), 'genie-native-invalid-'));
    roots.push(root);
    expect(invoke('create', join(root, 'predicate.json'), { SOURCE_SHA: 'not-a-sha' }).exitCode).toBe(2);
  });

  test('reusable policy returns only an internally consistent trusted control digest', () => {
    const root = mkdtempSync(join(tmpdir(), 'genie-native-reusable-'));
    roots.push(root);
    const predicatePath = join(root, 'predicate.json');
    const resultPath = join(root, 'result.json');
    expect(invoke('create', predicatePath).exitCode).toBe(0);
    const predicate = JSON.parse(readFileSync(predicatePath, 'utf8'));
    const result = [
      {
        verificationResult: {
          statement: { predicateType: 'https://github.com/automagik-dev/genie/release-tarballs/v1', predicate },
        },
      },
    ];
    writeFileSync(resultPath, JSON.stringify(result));
    const control = invoke('reusable-control-sha', resultPath);
    expect(control.exitCode).toBe(0);
    expect(control.stdout.toString().trim()).toBe(CONTROL_SHA);
    expect(invoke('verify-reusable', resultPath).exitCode).toBe(0);

    predicate.buildDefinition.buildType = 'https://example.invalid/build';
    writeFileSync(resultPath, JSON.stringify(result));
    expect(invoke('reusable-control-sha', resultPath).exitCode).not.toBe(0);

    predicate.buildDefinition.buildType = 'https://github.com/automagik-dev/genie/release-tarballs/v1';
    predicate.buildDefinition.resolvedDependencies[1].digest.gitCommit = 'd'.repeat(40);
    writeFileSync(resultPath, JSON.stringify(result));
    expect(invoke('reusable-control-sha', resultPath).exitCode).not.toBe(0);
  });
});
