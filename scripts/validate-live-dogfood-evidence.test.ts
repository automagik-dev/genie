import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  LIVE_DOGFOOD_SCHEMA_VERSION,
  REQUIRED_STAGE_IDS,
  validateLiveDogfoodEvidence,
  validateLiveDogfoodEvidenceFile,
} from './validate-live-dogfood-evidence.ts';

const N = '5.260720.10';
const T = '5.260723.7';
const PLATFORM = 'darwin-arm64';
const HEX = (character: string, size = 64) => character.repeat(size);

function provenance(kind: 'release-tarball' | 'delivery-evidence', source: string) {
  return {
    kind,
    repository: 'automagik-dev/genie',
    predicateType:
      kind === 'release-tarball'
        ? 'https://slsa.dev/provenance/v0.2'
        : 'https://github.com/automagik-dev/genie/delivery-evidence/v1',
    workflowIdentity:
      kind === 'release-tarball'
        ? 'https://github.com/slsa-framework/slsa-github-generator/.github/workflows/generator_generic_slsa3.yml@refs/tags/v2.1.0'
        : 'https://github.com/automagik-dev/genie/.github/workflows/release-publish.yml@refs/heads/main',
    oidcIssuer: 'https://token.actions.githubusercontent.com',
    sourceCommit: source,
    controlCommit: HEX('c', 40),
    sourceBranch: 'main',
    sourceCiRunId: '1234',
    identitySha256: HEX(kind === 'release-tarball' ? '1' : '2'),
    bundleSha256: HEX(kind === 'release-tarball' ? '3' : '4'),
  };
}

function artifact(version: string, channel: string, digestChar: string, kind: 'release-tarball' | 'delivery-evidence') {
  return {
    version,
    channel,
    platformId: PLATFORM,
    platformTriple: 'darwin-arm64',
    releaseTag: `v${version}`,
    releaseName: `genie-${version}-${PLATFORM}.tar.gz`,
    manifestSha256: HEX(digestChar),
    artifactSha256: HEX(String.fromCharCode(digestChar.charCodeAt(0) + 1)),
    binarySha256: HEX(String.fromCharCode(digestChar.charCodeAt(0) + 2)),
    payloadSha256: HEX(String.fromCharCode(digestChar.charCodeAt(0) + 3)),
    evidenceDigest: HEX(String.fromCharCode(digestChar.charCodeAt(0) + 4)),
    provenance: provenance(kind, kind === 'delivery-evidence' ? HEX('a', 40) : HEX('b', 40)),
  };
}

function task(token: string, label: string) {
  return {
    wish: `dogfood-${label}-${token}`,
    taskId: `t_${label}_${token}`,
    title: `task-${label}-${token}`,
    status: 'in_progress',
    claimedBy: `worker-${label}`,
  };
}

function repo(root: string, token: string, label: string, pid: number) {
  const identity = task(token, label);
  return {
    root,
    requestedCwd: root,
    effectiveCwd: root,
    cwdIdentity: `9:${pid}`,
    childPid: pid,
    sentinel: { token, expected: { ...identity }, observed: { ...identity }, boardCount: 1 },
  };
}

function stage(id: (typeof REQUIRED_STAGE_IDS)[number]) {
  const candidateStages = REQUIRED_STAGE_IDS.slice(3);
  const activeVersion = candidateStages.includes(id) ? T : N;
  const states: Record<string, [number, string, string, unknown]> = {
    'seed-repositories': [0, 'seeded', 'seeded', null],
    'n-parent-active': [0, 'current', 'current', null],
    't-delivery-repair': [
      2,
      'activation-pending',
      'activation-pending',
      {
        schemaVersion: 1,
        code: 'activation-pending',
        deliveryComplete: true,
        retry: false,
        nextAction: 'retire tasks then setup and start a new task',
      },
    ],
    'activation-consent': [0, 'activated', 'current', null],
    'assets-converged': [0, 'current', 'current', null],
    'untouched-b-before-init': [1, 'project-database-unavailable', 'project-database-unavailable', null],
    'untouched-b-after-init': [0, 'current', 'current', null],
    'new-thread-sentinel': [0, 'current', 'current', null],
    'doctor-current': [0, 'current', 'current', null],
  };
  const [exit, humanState, jsonState, trailer] = states[id] as [number, string, string, unknown];
  const generation = id === 't-delivery-repair' || candidateStages.includes(id) ? 'candidate' : 'previous';
  const executable = `/tmp/dogfood/bin/${generation}`;
  const native = ['untouched-b-before-init', 'untouched-b-after-init', 'new-thread-sentinel'].includes(id);
  const argv = native ? ['mcpServer/tool/call', id] : [id];
  const command = {
    executable,
    executableSha256: generation === 'candidate' ? HEX('c') : HEX('7'),
    candidateBinary: executable,
    candidateBinarySha256: generation === 'candidate' ? HEX('c') : HEX('7'),
    argv,
    pid: 3000 + REQUIRED_STAGE_IDS.indexOf(id),
    requestedCwd: '/tmp/dogfood/repo-a',
    cwdIdentity: '9:2001',
    exit,
    stdout: native ? JSON.stringify({ schemaVersion: 1, kind: 'verified-local-fixture-direct-mcp', payload: {} }) : '',
    stderr: '',
  };
  const observation = { schemaVersion: 1, commands: [command] };
  return {
    id,
    command: [executable, ...argv].join(' '),
    exit,
    humanState,
    jsonState,
    activeVersion,
    trailer,
    observationPath: `observations/${id}.json`,
    observationSha256: createHash('sha256')
      .update(`${JSON.stringify(observation, null, 2)}\n`)
      .digest('hex'),
    observation,
  };
}

function validManifest(): Record<string, any> {
  const previous = artifact(N, 'stable', '5', 'release-tarball');
  const candidate = artifact(T, 'stable', 'a', 'delivery-evidence');
  const a = repo('/tmp/dogfood/repo-a', HEX('7', 40), 'a', 2001);
  const b = repo('/tmp/dogfood/repo-b', HEX('8', 40), 'b', 2002);
  return {
    kind: 'live-dogfood-evidence',
    schemaVersion: LIVE_DOGFOOD_SCHEMA_VERSION,
    entry: {
      id: `${T}-${PLATFORM}`,
      evidenceKind: 'verified-local-fixture',
      availability: 'verified',
      platformId: PLATFORM,
      platformTriple: 'darwin-arm64',
      artifactName: candidate.releaseName,
      inputs: {
        previous: {
          artifact: `previous/${previous.releaseName}`,
          manifest: 'previous/stable.json',
          identity: `previous/${previous.releaseName}.intoto.jsonl`,
          bundle: `previous/${previous.releaseName}.bundle`,
          identityKind: 'slsa-provenance',
        },
        candidate: {
          artifact: `candidate/${candidate.releaseName}`,
          manifest: 'candidate/stable.json',
          identity: `candidate/${candidate.releaseName}.stable.delivery.json`,
          bundle: `candidate/${candidate.releaseName}.stable.delivery.json.sigstore.json`,
          identityKind: 'delivery-descriptor',
        },
      },
    },
    lifecycle: {
      previousVersion: N,
      candidateVersion: T,
      channel: 'stable',
      sourceCommit: HEX('a', 40),
      artifacts: { previous, candidate },
      delivery: {
        schemaVersion: 2,
        deliveryId: HEX('d', 32),
        evidenceDigest: candidate.evidenceDigest,
        root: '/tmp/dogfood/genie-home',
        targetVersion: T,
        platformId: PLATFORM,
        platformTriple: 'darwin-arm64',
        releaseTag: candidate.releaseTag,
        releaseName: candidate.releaseName,
        releaseManifestSha256: candidate.manifestSha256,
        artifactSha256: candidate.artifactSha256,
        installedBinarySha256: candidate.binarySha256,
        canonicalPayloadSha256: candidate.payloadSha256,
      },
      convergence: {
        route: { state: 'managed-project', command: '/tmp/dogfood/genie-home/bin/genie', cwdOverride: null },
        roles: { expectedCount: 7, observedCount: 7, current: true, reviewerSha256: HEX('e') },
      },
      stages: REQUIRED_STAGE_IDS.map(stage),
    },
    repositories: {
      cacheRoot: '/tmp/dogfood/codex/plugins/cache/automagik/genie',
      a,
      b: {
        root: b.root,
        beforeInit: {
          routeState: 'absent',
          fallbackUsed: false,
          result: 'project-database-unavailable',
          returnedTasks: 0,
        },
        afterInit: { ...b, routeState: 'managed-project' },
      },
    },
  };
}

const DOCTOR = {
  ok: true,
  checks: [{ name: 'Codex plugin lifecycle', status: 'pass' }],
  integrationSummary: {
    schemaVersion: 1,
    codexPlugin: {
      state: 'current',
      installedVersion: T,
      targetVersion: T,
      actionRequired: false,
      deliveryComplete: true,
    },
  },
};

function evidence(manifest = validManifest(), doctor: unknown = DOCTOR): string {
  return `\`\`\`json\n${JSON.stringify(manifest, null, 2)}\n\`\`\`\n\n\`\`\`json\n${JSON.stringify(
    doctor,
    null,
    2,
  )}\n\`\`\`\n`;
}

function errorsAfter(mutator: (manifest: Record<string, any>) => void): string[] {
  const manifest = validManifest();
  mutator(manifest);
  return validateLiveDogfoodEvidence(evidence(manifest));
}

describe('validate-live-dogfood-evidence schema v2', () => {
  test('accepts the real nested doctor topology and complete bound entry', () => {
    expect(validateLiveDogfoodEvidence(evidence())).toEqual([]);
  });

  test('rejects obsolete flat integrationSummary.state', () => {
    const flat = { ok: true, checks: [{}], integrationSummary: { schemaVersion: 1, state: 'current' } };
    expect(validateLiveDogfoodEvidence(evidence(validManifest(), flat)).join('\n')).toContain(
      'integrationSummary.codexPlugin',
    );
  });

  test('rejects absent, duplicate, and out-of-order stages', () => {
    expect(errorsAfter((m) => m.lifecycle.stages.pop()).join('\n')).toContain('exactly 9 ordered stages');
    expect(
      errorsAfter((m) => {
        [m.lifecycle.stages[0], m.lifecycle.stages[1]] = [m.lifecycle.stages[1], m.lifecycle.stages[0]];
      }).join('\n'),
    ).toContain('stages[0].id');
    expect(errorsAfter((m) => m.lifecycle.stages.push(m.lifecycle.stages[0])).join('\n')).toContain(
      'exactly 9 ordered stages',
    );
  });

  test('rejects inconsistent human/json/trailer/exit and N retiring before consent', () => {
    expect(
      errorsAfter((m) => {
        m.lifecycle.stages[2].exit = 0;
      }).join('\n'),
    ).toContain('.exit');
    expect(
      errorsAfter((m) => {
        m.lifecycle.stages[2].humanState = 'current';
      }).join('\n'),
    ).toContain('humanState');
    expect(
      errorsAfter((m) => {
        m.lifecycle.stages[2].trailer.deliveryComplete = false;
      }).join('\n'),
    ).toContain('deliveryComplete');
    expect(
      errorsAfter((m) => {
        m.lifecycle.stages[2].activeVersion = T;
      }).join('\n'),
    ).toContain('activeVersion');
  });

  test('rejects every tampered candidate delivery binding', () => {
    for (const field of [
      'evidenceDigest',
      'targetVersion',
      'platformId',
      'platformTriple',
      'releaseTag',
      'releaseName',
      'releaseManifestSha256',
      'artifactSha256',
      'installedBinarySha256',
      'canonicalPayloadSha256',
    ]) {
      const errors = errorsAfter((m) => {
        m.lifecycle.delivery[field] = field.endsWith('Sha256') ? HEX('0') : 'bad';
      });
      expect(errors.length, field).toBeGreaterThan(0);
    }
  });

  test('rejects unavailable matrix entry and malformed provenance', () => {
    expect(
      errorsAfter((m) => {
        m.entry.availability = 'unavailable';
      }).join('\n'),
    ).toContain('availability');
    expect(
      errorsAfter((m) => {
        m.lifecycle.artifacts.previous.provenance.controlCommit = 'bad';
      }).join('\n'),
    ).toContain('controlCommit');
    expect(
      errorsAfter((m) => {
        m.lifecycle.artifacts.candidate.provenance.workflowIdentity = 'other';
      }).join('\n'),
    ).toContain('workflowIdentity');
  });

  test('requires previous stable N to be older than candidate T', () => {
    expect(
      errorsAfter((m) => {
        m.lifecycle.previousVersion = '5.260724.1';
        m.lifecycle.artifacts.previous.version = '5.260724.1';
        m.lifecycle.artifacts.previous.releaseTag = 'v5.260724.1';
        m.lifecycle.artifacts.previous.releaseName = 'genie-5.260724.1-darwin-arm64.tar.gz';
      }).join('\n'),
    ).toContain('previous stable N must be older than candidate T');
  });

  test('rejects empty/cross-repo/cache-root/stale task and repeated child PID evidence', () => {
    expect(
      errorsAfter((m) => {
        m.repositories.a.sentinel.boardCount = 0;
      }).join('\n'),
    ).toContain('boardCount');
    expect(
      errorsAfter((m) => {
        m.repositories.a.sentinel.observed = m.repositories.b.afterInit.sentinel.observed;
      }).join('\n'),
    ).toContain('exactly equal');
    expect(
      errorsAfter((m) => {
        m.repositories.a.effectiveCwd = m.repositories.cacheRoot;
      }).join('\n'),
    ).toContain('plugin cache');
    expect(
      errorsAfter((m) => {
        m.repositories.a.sentinel.observed.status = 'done';
      }).join('\n'),
    ).toContain('in_progress');
    expect(
      errorsAfter((m) => {
        m.repositories.b.afterInit.childPid = m.repositories.a.childPid;
      }).join('\n'),
    ).toContain('distinct child');
  });

  test('requires untouched B absent/no-fallback before init and managed after', () => {
    expect(
      errorsAfter((m) => {
        m.repositories.b.beforeInit.fallbackUsed = true;
      }).join('\n'),
    ).toContain('fallbackUsed');
    expect(
      errorsAfter((m) => {
        m.repositories.b.afterInit.routeState = 'absent';
      }).join('\n'),
    ).toContain('routeState');
  });
});

describe('referenced input verification', () => {
  test('rehashes every staged input and rejects missing or changed bytes', () => {
    const root = mkdtempSync(join(tmpdir(), 'dogfood-validator-'));
    try {
      const manifest = validManifest();
      for (const generation of ['previous', 'candidate']) {
        mkdirSync(join(root, generation));
        const inputs = manifest.entry.inputs[generation];
        const artifact = manifest.lifecycle.artifacts[generation];
        const files = [
          ['artifact', 'artifactSha256'],
          ['manifest', 'manifestSha256'],
          ['identity', 'identitySha256'],
          ['bundle', 'bundleSha256'],
        ];
        for (const [inputKey, digestKey] of files) {
          const bytes = `${generation}-${inputKey}`;
          const path = join(root, inputs[inputKey]);
          writeFileSync(path, bytes);
          const digest = createHash('sha256').update(bytes).digest('hex');
          if (inputKey === 'identity' || inputKey === 'bundle') artifact.provenance[digestKey] = digest;
          else artifact[digestKey] = digest;
        }
      }
      const candidate = manifest.lifecycle.artifacts.candidate;
      Object.assign(manifest.lifecycle.delivery, {
        releaseManifestSha256: candidate.manifestSha256,
        artifactSha256: candidate.artifactSha256,
        installedBinarySha256: candidate.binarySha256,
        canonicalPayloadSha256: candidate.payloadSha256,
      });
      mkdirSync(join(root, 'observations'));
      for (const stage of manifest.lifecycle.stages) {
        writeFileSync(join(root, stage.observationPath), `${JSON.stringify(stage.observation, null, 2)}\n`);
      }
      const path = join(root, 'evidence.md');
      writeFileSync(path, evidence(manifest));
      expect(validateLiveDogfoodEvidenceFile(path, root)).toEqual([]);
      writeFileSync(join(root, manifest.entry.inputs.candidate.artifact), 'tampered');
      expect(validateLiveDogfoodEvidenceFile(path, root).join('\n')).toContain('candidate artifact digest mismatch');
      rmSync(join(root, manifest.entry.inputs.previous.bundle));
      expect(validateLiveDogfoodEvidenceFile(path, root).join('\n')).toContain('previous bundle is unavailable');
      writeFileSync(join(root, manifest.lifecycle.stages[0].observationPath), '{"tampered":true}\n');
      expect(validateLiveDogfoodEvidenceFile(path, root).join('\n')).toContain('stage observation digest mismatch');
      expect(readFileSync(path, 'utf8')).toContain('"schemaVersion": 2');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
