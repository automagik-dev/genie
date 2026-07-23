import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = join(import.meta.dir, 'release-generic-provenance.sh');
const CONTROL_SHA = 'b'.repeat(40);
const SOURCE_SHA = 'a'.repeat(40);
const ARTIFACT_SHA256 = 'd'.repeat(64);
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function predicate<T extends Record<string, unknown>>(invocation: T) {
  return {
    predicateType: 'https://slsa.dev/provenance/v0.2',
    subject: [{ name: 'genie-5.260714.2-linux-x64-glibc.tar.gz', digest: { sha256: ARTIFACT_SHA256 } }],
    predicate: {
      builder: {
        id: 'https://github.com/slsa-framework/slsa-github-generator/.github/workflows/generator_generic_slsa3.yml@refs/tags/v2.1.0',
      },
      buildType: 'https://github.com/slsa-framework/slsa-github-generator/generic@v1',
      invocation,
      materials: [
        {
          uri: 'git+https://github.com/automagik-dev/genie@refs/heads/main',
          digest: { sha1: CONTROL_SHA },
        },
      ],
    },
  };
}

function automatedStatement() {
  return predicate({
    configSource: {
      uri: 'git+https://github.com/automagik-dev/genie@refs/heads/main',
      digest: { sha1: CONTROL_SHA },
      entryPoint: '.github/workflows/version.yml',
    },
    environment: {
      github_event_name: 'workflow_run',
      github_ref: 'refs/heads/main',
      github_sha1: CONTROL_SHA,
      github_event_payload: {
        workflow_run: {
          id: 123456,
          path: '.github/workflows/ci.yml',
          event: 'push',
          status: 'completed',
          conclusion: 'success',
          head_sha: SOURCE_SHA,
          head_branch: 'dev',
          repository: { full_name: 'automagik-dev/genie' },
        },
      },
    },
  });
}

function dispatchStatement() {
  return predicate({
    configSource: {
      uri: 'git+https://github.com/automagik-dev/genie@refs/heads/main',
      digest: { sha1: CONTROL_SHA },
      entryPoint: '.github/workflows/release.yml',
    },
    parameters: {
      event_inputs: {
        version: '5.260714.2',
        channel: 'stable',
        source_sha: SOURCE_SHA,
        source_branch: 'main',
        source_ci_run_id: '123456',
      },
    },
    environment: {
      github_event_name: 'workflow_dispatch',
      github_ref: 'refs/heads/main',
      github_sha1: CONTROL_SHA,
      github_event_payload: { inputs: { channel: 'stable' } },
    },
  });
}

function invoke(
  mode: 'verify-exact' | 'verify-exact-subject' | 'verify-reusable',
  value: unknown,
  overrides: Record<string, string> = {},
) {
  const root = mkdtempSync(join(tmpdir(), 'genie-generic-provenance-'));
  roots.push(root);
  const path = join(root, 'statement.json');
  writeFileSync(path, JSON.stringify(value));
  return Bun.spawnSync(['bash', SCRIPT, mode, path], {
    env: {
      ...process.env,
      RELEASE_REPOSITORY: 'automagik-dev/genie',
      VERSION: '5.260714.2',
      CHANNEL: 'dev',
      SOURCE_SHA,
      SOURCE_BRANCH: 'dev',
      SOURCE_CI_RUN_ID: '123456',
      CONTROL_SHA,
      ARTIFACT_SHA256,
      ...overrides,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
}

describe('verified generic SLSA provenance policy', () => {
  test('binds automated provenance to Version main control and the exact successful CI workflow_run', () => {
    expect(invoke('verify-exact', automatedStatement()).exitCode).toBe(0);
  });

  test('binds stable provenance to Release main control and exact human dispatch inputs', () => {
    expect(
      invoke('verify-exact', dispatchStatement(), {
        CHANNEL: 'stable',
        SOURCE_BRANCH: 'main',
      }).exitCode,
    ).toBe(0);
  });

  test('rejects automated control or authorizing CI identity drift in every signed field', () => {
    const mutations: Array<(value: ReturnType<typeof automatedStatement>) => void> = [
      (value) => {
        value.predicate.invocation.configSource.digest.sha1 = 'c'.repeat(40);
      },
      (value) => {
        value.predicate.invocation.environment.github_sha1 = 'c'.repeat(40);
      },
      (value) => {
        value.predicate.materials[0].digest.sha1 = 'c'.repeat(40);
      },
      (value) => {
        value.predicate.invocation.configSource.entryPoint = '.github/workflows/other.yml';
      },
      (value) => {
        value.predicate.invocation.environment.github_event_name = 'workflow_dispatch';
      },
      (value) => {
        value.predicate.invocation.environment.github_event_payload.workflow_run.id = 654321;
      },
      (value) => {
        value.predicate.invocation.environment.github_event_payload.workflow_run.head_sha = 'c'.repeat(40);
      },
      (value) => {
        value.predicate.invocation.environment.github_event_payload.workflow_run.path =
          '.github/workflows/attacker.yml';
      },
      (value) => {
        value.predicate.invocation.environment.github_event_payload.workflow_run.repository.full_name =
          'attacker/genie';
      },
      (value) => {
        value.predicate.builder.id = 'https://example.invalid/builder';
      },
    ];
    for (const mutate of mutations) {
      const value = automatedStatement();
      mutate(value);
      expect(invoke('verify-exact', value).exitCode).not.toBe(0);
    }
  });

  test('emits identity only after the verified statement binds the exact artifact subject', () => {
    const verified = invoke('verify-exact-subject', automatedStatement());
    expect(verified.exitCode).toBe(0);
    expect(JSON.parse(verified.stdout.toString())).toEqual({
      artifactSha256: ARTIFACT_SHA256,
      sourceSha: SOURCE_SHA,
      sourceBranch: 'dev',
      sourceCiRunId: '123456',
      controlSha: CONTROL_SHA,
      entryPoint: '.github/workflows/version.yml',
    });

    expect(
      invoke('verify-exact-subject', automatedStatement(), {
        ARTIFACT_SHA256: 'e'.repeat(64),
      }).exitCode,
    ).not.toBe(0);
  });

  test('reusable policy accepts both pipeline generations and rejects malformed signed identity', () => {
    expect(invoke('verify-reusable', automatedStatement(), { CONTROL_SHA: 'c'.repeat(40) }).exitCode).toBe(0);
    expect(invoke('verify-reusable', dispatchStatement(), { CONTROL_SHA: 'c'.repeat(40) }).exitCode).toBe(0);

    const malformed = automatedStatement();
    malformed.predicate.invocation.environment.github_event_payload.workflow_run.head_branch = 'main';
    expect(invoke('verify-reusable', malformed).exitCode).not.toBe(0);

    const wrongType = automatedStatement();
    wrongType.predicateType = 'https://example.invalid/predicate';
    expect(invoke('verify-reusable', wrongType).exitCode).not.toBe(0);
  });
});
