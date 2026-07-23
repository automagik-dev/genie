import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateLiveDogfoodEvidenceFile } from '../../scripts/validate-live-dogfood-evidence.js';
import { FIXTURE_N, FIXTURE_T, buildDogfoodFixture } from '../support/codex-dogfood-fixture.js';
import { runDogfoodEntry } from '../support/codex-dogfood-harness.js';

let root: string | null = null;
afterEach(() => {
  if (root !== null) rmSync(root, { recursive: true, force: true });
  root = null;
});

describe('parameterized previous-release to candidate dogfood entry', () => {
  test('verified N remains active through repair, then exact T activates and emits reusable evidence', async () => {
    root = mkdtempSync(join(tmpdir(), 'genie-dogfood-cross-version-'));
    const fixture = buildDogfoodFixture(root);
    const result = await runDogfoodEntry(fixture.input, fixture.dependencies);
    const lifecycle = result.manifest.lifecycle as Record<string, any>;
    expect(lifecycle.previousVersion).toBe(FIXTURE_N);
    expect(lifecycle.candidateVersion).toBe(FIXTURE_T);
    expect(lifecycle.stages[1].activeVersion).toBe(FIXTURE_N);
    expect(lifecycle.stages[2]).toMatchObject({
      id: 't-delivery-repair',
      exit: 2,
      activeVersion: FIXTURE_N,
      trailer: { code: 'activation-pending', deliveryComplete: true },
    });
    expect(lifecycle.stages[3]).toMatchObject({ id: 'activation-consent', activeVersion: FIXTURE_T });
    expect(lifecycle.delivery).toMatchObject({
      targetVersion: FIXTURE_T,
      platformId: fixture.input.platformId,
      artifactSha256: lifecycle.artifacts.candidate.artifactSha256,
      installedBinarySha256: lifecycle.artifacts.candidate.binarySha256,
      canonicalPayloadSha256: lifecycle.artifacts.candidate.payloadSha256,
    });
    expect(result.doctor.integrationSummary).toMatchObject({
      schemaVersion: 1,
      codexPlugin: {
        state: 'current',
        installedVersion: FIXTURE_T,
        targetVersion: FIXTURE_T,
        deliveryComplete: true,
      },
    });
    const evidencePath = fixture.input.outputEvidence as string;
    expect(validateLiveDogfoodEvidenceFile(evidencePath, join(evidencePath, '..'))).toEqual([]);
    expect(readFileSync(evidencePath, 'utf8')).toContain('"evidenceKind": "verified-local-fixture"');
  }, 120_000);

  test('an unavailable or mismatched artifact fails before evidence is emitted', async () => {
    root = mkdtempSync(join(tmpdir(), 'genie-dogfood-cross-version-fail-'));
    const fixture = buildDogfoodFixture(root);
    fixture.input.candidate.artifact = join(root, 'missing.tar.gz');
    await expect(runDogfoodEntry(fixture.input, fixture.dependencies)).rejects.toThrow(/unavailable/);
  });
});
