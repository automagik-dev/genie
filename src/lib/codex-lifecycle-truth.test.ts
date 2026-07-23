import { describe, expect, test } from 'bun:test';
import { join, resolve } from 'node:path';
import type { CodexActivationSnapshot } from './codex-activation.js';
import { parseReleaseVersion } from './codex-activation.js';
import { DELIVERY_INCOMPLETE_RECOVERY } from './codex-host-observation.js';
import {
  type RouteLayerInput,
  assessSnapshotDelivery,
  classifyRouteLayers,
  projectTrustState,
  snapshotDeliveryReadState,
} from './codex-lifecycle-truth.js';

const T = '5.260722.1';
const DIGEST = 'a'.repeat(64);

function ver(s: string) {
  const parsed = parseReleaseVersion(s);
  if (!parsed) throw new Error(`bad test version ${s}`);
  return parsed;
}

function snapshot(over: Partial<CodexActivationSnapshot> = {}): CodexActivationSnapshot {
  return {
    canonical: { status: 'ok', version: ver(T), digest: DIGEST, identity: '10:100' },
    query: { status: 'ok', registration: { present: true, enabled: true, version: ver(T) } },
    cache: { kind: 'present', digest: DIGEST, identity: '10:200' },
    receipt: { status: 'absent' },
    delivery: { status: 'absent' },
    intent: { status: 'absent' },
    receiptConsumed: false,
    observationWitness: {
      before: { status: 'present', digest: 'f'.repeat(64), identity: '10:300' },
      after: { status: 'present', digest: 'f'.repeat(64), identity: '10:300' },
    },
    observedAt: '2026-07-22T00:00:00.000Z',
    ...over,
  };
}

function matchingDelivery(over: Partial<Record<string, string>> = {}): CodexActivationSnapshot['delivery'] {
  return {
    status: 'present',
    record: {
      schemaVersion: 1,
      deliveryId: 'c'.repeat(32),
      targetVersion: T,
      canonicalPayloadSha256: DIGEST,
      channel: 'stable',
      deliveredAt: '2026-07-22T00:00:00.000Z',
      ...over,
    },
  };
}

describe('assessSnapshotDelivery (Decision 9 shared gate)', () => {
  test('matching record binding the canonical target passes', () => {
    expect(assessSnapshotDelivery(snapshot({ delivery: matchingDelivery() }))).toEqual({ kind: 'matching' });
  });

  test('absent record is the one consistent delivery-incomplete result with the recovery command', () => {
    const gate = assessSnapshotDelivery(snapshot());
    if (gate.kind !== 'incomplete') throw new Error(`expected incomplete, got ${gate.kind}`);
    expect(gate.result).toMatchObject({
      code: 'delivery-incomplete',
      authority: 'none',
      exit: 1,
      deliveryComplete: false,
      assessment: 'absent',
      recovery: DELIVERY_INCOMPLETE_RECOVERY,
    });
  });

  test('invalid record classifies invalid, never mismatch', () => {
    const gate = assessSnapshotDelivery(snapshot({ delivery: { status: 'invalid', detail: 'corrupt json' } }));
    if (gate.kind !== 'incomplete') throw new Error(`expected incomplete, got ${gate.kind}`);
    expect(gate.result.assessment).toBe('invalid');
  });

  test('record bound to a different target version is a mismatch', () => {
    const gate = assessSnapshotDelivery(snapshot({ delivery: matchingDelivery({ targetVersion: '5.260711.9' }) }));
    if (gate.kind !== 'incomplete') throw new Error(`expected incomplete, got ${gate.kind}`);
    expect(gate.result.assessment).toBe('mismatch');
  });

  test('record bound to a different payload digest is a mismatch', () => {
    const gate = assessSnapshotDelivery(
      snapshot({ delivery: matchingDelivery({ canonicalPayloadSha256: 'b'.repeat(64) }) }),
    );
    if (gate.kind !== 'incomplete') throw new Error(`expected incomplete, got ${gate.kind}`);
    expect(gate.result.assessment).toBe('mismatch');
  });

  test('missing canonical payload is unassessable — the earlier payload guard owns that state', () => {
    const gate = assessSnapshotDelivery(
      snapshot({ canonical: { status: 'error', detail: 'payload root not found' }, delivery: matchingDelivery() }),
    );
    expect(gate).toEqual({ kind: 'unassessable', detail: 'canonical payload is unavailable: payload root not found' });
  });

  test('snapshotDeliveryReadState maps all three fact arms', () => {
    expect(snapshotDeliveryReadState(snapshot()).status).toBe('absent');
    expect(snapshotDeliveryReadState(snapshot({ delivery: { status: 'invalid', detail: 'x' } }))).toEqual({
      status: 'invalid',
      detail: 'x',
    });
    expect(snapshotDeliveryReadState(snapshot({ delivery: matchingDelivery() })).status).toBe('present');
  });
});

describe('classifyRouteLayers (typed config-layer diagnostics)', () => {
  const root = resolve('/repo');
  function input(over: Partial<RouteLayerInput> = {}): RouteLayerInput {
    return {
      worktreeRoot: root,
      cwd: root,
      route: { route: 'fallback', detail: 'project fallback' },
      globalConfigPath: '/codex-home/config.toml',
      readFile: () => null,
      exists: () => false,
      ...over,
    };
  }
  const trustedGlobal = `[projects."${root}"]\ntrust_level = "trusted"\n`;

  test('an intact trusted route yields zero findings', () => {
    const findings = classifyRouteLayers(
      input({ readFile: (path) => (path === '/codex-home/config.toml' ? trustedGlobal : null) }),
    );
    expect(findings).toEqual([]);
  });

  test('plugin+project conflict is a route-collision', () => {
    const findings = classifyRouteLayers(
      input({
        route: { route: 'conflict', detail: 'both routes effective' },
        readFile: (path) => (path === '/codex-home/config.toml' ? trustedGlobal : null),
      }),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ kind: 'route-collision' });
    expect(findings[0]?.detail).toContain('both routes effective');
  });

  test('a user-owned same-key project route is a route-collision that names user resolution', () => {
    const findings = classifyRouteLayers(
      input({
        route: { route: 'unmanaged-fallback', detail: 'unmanaged [mcp_servers.genie]' },
        readFile: (path) => (path === '/codex-home/config.toml' ? trustedGlobal : null),
      }),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ kind: 'route-collision' });
    expect(findings[0]?.detail).toContain('user-owned');
    expect(findings[0]?.detail).toContain('user resolution');
  });

  test('a nested .codex/config.toml nearer to the CWD shadows the root marker (nearest owner reported)', () => {
    const nested = join(root, 'packages', 'web');
    const mid = join(root, 'packages');
    const shadowConfig = '[mcp_servers.genie]\ncommand = "other"\n';
    const files: Record<string, string> = {
      [join(nested, '.codex', 'config.toml')]: shadowConfig,
      [join(mid, '.codex', 'config.toml')]: shadowConfig,
      '/codex-home/config.toml': trustedGlobal,
    };
    const findings = classifyRouteLayers(
      input({
        cwd: nested,
        readFile: (path) => files[path] ?? null,
        exists: (path) => path in files,
      }),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ kind: 'route-shadowed', ownerPath: nested });
  });

  test('a nested config without a genie route does not shadow', () => {
    const nested = join(root, 'packages');
    const files: Record<string, string> = {
      [join(nested, '.codex', 'config.toml')]: '[mcp_servers.other]\ncommand = "x"\n',
      '/codex-home/config.toml': trustedGlobal,
    };
    const findings = classifyRouteLayers(
      input({ cwd: nested, readFile: (path) => files[path] ?? null, exists: (path) => path in files }),
    );
    expect(findings).toEqual([]);
  });

  test('a CWD outside the worktree root never walks the chain', () => {
    const findings = classifyRouteLayers(
      input({
        cwd: '/elsewhere',
        readFile: (path) => (path === '/codex-home/config.toml' ? trustedGlobal : null),
        exists: () => {
          throw new Error('chain walk must not run for an outside CWD');
        },
      }),
    );
    expect(findings).toEqual([]);
  });

  test('the dotted-key route spelling (the marker form) is detected in nested and global layers', () => {
    const nested = join(root, 'packages');
    const dottedConfig = 'mcp_servers.genie.command = "/elsewhere/genie"\nmcp_servers.genie.args = ["mcp"]\n';
    const files: Record<string, string> = {
      [join(nested, '.codex', 'config.toml')]: dottedConfig,
      '/codex-home/config.toml': `${dottedConfig}${trustedGlobal}`,
    };
    const findings = classifyRouteLayers(
      input({ cwd: nested, readFile: (path) => files[path] ?? null, exists: (path) => path in files }),
    );
    expect(findings.map((finding) => finding.kind).sort()).toEqual(['global-route-same-key', 'route-shadowed']);
  });

  test('a dotted-key inline-table route (mcp_servers.genie = {…}) is detected', () => {
    const findings = classifyRouteLayers(
      input({
        readFile: (path) =>
          path === '/codex-home/config.toml'
            ? `mcp_servers.genie = { command = "/old/genie", args = [] }\n${trustedGlobal}`
            : null,
      }),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ kind: 'global-route-same-key' });
  });

  test('a non-genie dotted key or unrelated assignment does not false-positive', () => {
    const findings = classifyRouteLayers(
      input({
        readFile: (path) =>
          path === '/codex-home/config.toml'
            ? `mcp_servers.other.command = "/x"\nsome_genie_note = "mcp_servers.genie"\n${trustedGlobal}`
            : null,
      }),
    );
    expect(findings).toEqual([]);
  });

  test('a global same-key route is reported and preserved', () => {
    const findings = classifyRouteLayers(
      input({
        readFile: (path) =>
          path === '/codex-home/config.toml' ? `[mcp_servers.genie]\ncommand = "old"\n${trustedGlobal}` : null,
      }),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ kind: 'global-route-same-key', path: '/codex-home/config.toml' });
  });

  test('an explicit non-trusted trust_level is untrusted-config', () => {
    const findings = classifyRouteLayers(
      input({
        readFile: (path) =>
          path === '/codex-home/config.toml' ? `[projects."${root}"]\ntrust_level = "untrusted"\n` : null,
      }),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ kind: 'untrusted-config' });
    expect(findings[0]?.detail).toContain("'untrusted'");
  });

  test('no trust entry at all is project-trust-required', () => {
    const findings = classifyRouteLayers(input());
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ kind: 'project-trust-required' });
  });

  test('trust entry for a DIFFERENT project does not trust this one', () => {
    const findings = classifyRouteLayers(
      input({
        readFile: (path) =>
          path === '/codex-home/config.toml' ? `[projects."/other/repo"]\ntrust_level = "trusted"\n` : null,
      }),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ kind: 'project-trust-required' });
  });
});

describe('projectTrustState (bounded targeted parse)', () => {
  const root = resolve('/repo');

  test('trusted entry is trusted', () => {
    expect(projectTrustState(`[projects."${root}"]\ntrust_level = "trusted"\n`, root)).toEqual({ state: 'trusted' });
  });

  test('trust_level read stops at the next section header', () => {
    const config = `[projects."${root}"]\nother = 1\n[projects."/other"]\ntrust_level = "trusted"\n`;
    expect(projectTrustState(config, root)).toEqual({ state: 'unknown' });
  });

  test('null config (absent/unreadable/oversized) is unknown', () => {
    expect(projectTrustState(null, root)).toEqual({ state: 'unknown' });
  });
});
