import { describe, expect, test } from 'bun:test';
import { REQUIRED_STEP_IDS, validateLiveDogfoodEvidence } from './validate-live-dogfood-evidence.ts';

const SNAPSHOT = {
  nIdentity: 'dev:12/ino:3400 v5.260721.7',
  tIdentity: 'dev:12/ino:3401 v5.260721.8',
  inventoryDigest: 'b'.repeat(64),
};

function validManifest(): Record<string, unknown> {
  return {
    kind: 'live-dogfood-evidence',
    schemaVersion: 1,
    candidate: { commit: 'a'.repeat(40), version: '5.260721.8', channel: 'homolog' },
    inertness: {
      codexPluginList: { before: { ...SNAPSHOT }, after: { ...SNAPSHOT } },
      genieDoctor: { before: { ...SNAPSHOT }, after: { ...SNAPSHOT } },
    },
    steps: REQUIRED_STEP_IDS.map((id) => ({
      id,
      command: `run ${id}`,
      exit: id === 'update-delivery-exit2' ? 2 : 0,
      output: id === 'update-delivery-exit2' ? '{"schemaVersion":1,"deliveryComplete":true}' : `${id} ok`,
    })),
    nNonGuarantee: 'Retired task N may be gone after activation and requires /hooks review plus a new task to resume.',
  };
}

const DOCTOR_PAYLOAD = {
  ok: true,
  checks: [{ id: 'codex', ok: true }],
  integrationSummary: { state: 'current', actionRequired: false, deliveryComplete: true },
};

function buildEvidence(manifest: unknown, doctor: unknown = DOCTOR_PAYLOAD, extra = ''): string {
  return [
    '# Live dogfood evidence',
    '',
    '```json',
    JSON.stringify(manifest, null, 2),
    '```',
    '',
    '## doctor --json payload',
    '',
    '```json',
    JSON.stringify(doctor, null, 2),
    '```',
    extra,
  ].join('\n');
}

describe('validate-live-dogfood-evidence', () => {
  test('a complete synthetic fixture passes', () => {
    expect(validateLiveDogfoodEvidence(buildEvidence(validManifest()))).toEqual([]);
  });

  test('rejects a nonempty file with no manifest block', () => {
    const errors = validateLiveDogfoodEvidence('# just prose, no json\n\nlots of words but nothing structural.');
    expect(errors.some((e) => e.includes('no live-dogfood-evidence manifest'))).toBe(true);
  });

  test('rejects a wrong commit format', () => {
    const manifest = validManifest();
    (manifest.candidate as Record<string, unknown>).commit = 'ABCDEF';
    const errors = validateLiveDogfoodEvidence(buildEvidence(manifest));
    expect(errors.some((e) => e.includes('candidate.commit'))).toBe(true);
  });

  test('rejects a version outside the release grammar', () => {
    const manifest = validManifest();
    (manifest.candidate as Record<string, unknown>).version = '5.x.9';
    const errors = validateLiveDogfoodEvidence(buildEvidence(manifest));
    expect(errors.some((e) => e.includes('candidate.version'))).toBe(true);
  });

  test('rejects a channel that is not homolog', () => {
    const manifest = validManifest();
    (manifest.candidate as Record<string, unknown>).channel = 'stable';
    const errors = validateLiveDogfoodEvidence(buildEvidence(manifest));
    expect(errors.some((e) => e.includes("channel must be 'homolog'"))).toBe(true);
  });

  test('rejects a non-inert query snapshot (before != after)', () => {
    const manifest = validManifest();
    const inertness = manifest.inertness as Record<string, { after: { inventoryDigest: string } }>;
    inertness.genieDoctor.after.inventoryDigest = 'c'.repeat(64);
    const errors = validateLiveDogfoodEvidence(buildEvidence(manifest));
    expect(errors.some((e) => e.includes('genieDoctor is not inert'))).toBe(true);
  });

  test('rejects an invalid inventory digest', () => {
    const manifest = validManifest();
    const inertness = manifest.inertness as Record<string, { before: { inventoryDigest: string } }>;
    inertness.codexPluginList.before.inventoryDigest = 'short';
    const errors = validateLiveDogfoodEvidence(buildEvidence(manifest));
    expect(errors.some((e) => e.includes('inventoryDigest must be 64'))).toBe(true);
  });

  test('rejects a missing ritual step', () => {
    const manifest = validManifest();
    (manifest.steps as unknown[]).splice(2, 1); // drop n-resume-compact
    const errors = validateLiveDogfoodEvidence(buildEvidence(manifest));
    expect(errors.some((e) => e.includes('exactly 7 ordered steps'))).toBe(true);
    expect(errors.some((e) => e.includes('n-resume-compact'))).toBe(true);
  });

  test('rejects an out-of-order ritual step', () => {
    const manifest = validManifest();
    const steps = manifest.steps as Array<{ id: string }>;
    [steps[0], steps[1]] = [steps[1], steps[0]];
    const errors = validateLiveDogfoodEvidence(buildEvidence(manifest));
    expect(errors.some((e) => e.includes("must be 'n-task'"))).toBe(true);
  });

  test('rejects a bad exit code on the delivery step', () => {
    const manifest = validManifest();
    const steps = manifest.steps as Array<{ id: string; exit: number }>;
    (steps.find((s) => s.id === 'update-delivery-exit2') as { exit: number }).exit = 0;
    const errors = validateLiveDogfoodEvidence(buildEvidence(manifest));
    expect(errors.some((e) => e.includes('update-delivery-exit2.exit must be 2'))).toBe(true);
  });

  test('rejects a delivery step missing the deliveryComplete trailer field', () => {
    const manifest = validManifest();
    const steps = manifest.steps as Array<{ id: string; output: string }>;
    (steps.find((s) => s.id === 'update-delivery-exit2') as { output: string }).output = 'delivered';
    const errors = validateLiveDogfoodEvidence(buildEvidence(manifest));
    expect(errors.some((e) => e.includes('"deliveryComplete":true'))).toBe(true);
  });

  test('rejects a non-integer exit on a step', () => {
    const manifest = validManifest();
    (manifest.steps as Array<{ exit: unknown }>)[0].exit = '0';
    const errors = validateLiveDogfoodEvidence(buildEvidence(manifest));
    expect(errors.some((e) => e.includes('.exit must be an integer'))).toBe(true);
  });

  test('rejects unparseable embedded doctor JSON', () => {
    const evidence = [
      '```json',
      JSON.stringify(validManifest(), null, 2),
      '```',
      '',
      '```json',
      '{ this is not valid json',
      '```',
    ].join('\n');
    const errors = validateLiveDogfoodEvidence(evidence);
    expect(errors.some((e) => e.includes('no embedded doctor JSON block'))).toBe(true);
  });

  test('rejects a doctor payload whose integrationSummary.state is not current', () => {
    const errors = validateLiveDogfoodEvidence(
      buildEvidence(validManifest(), { ...DOCTOR_PAYLOAD, integrationSummary: { state: 'pending' } }),
    );
    expect(errors.some((e) => e.includes("state must be 'current'"))).toBe(true);
  });

  test('rejects more than one doctor payload block', () => {
    const errors = validateLiveDogfoodEvidence(
      buildEvidence(validManifest(), DOCTOR_PAYLOAD, `\n\`\`\`json\n${JSON.stringify(DOCTOR_PAYLOAD)}\n\`\`\`\n`),
    );
    expect(errors.some((e) => e.includes('more than one embedded doctor JSON block'))).toBe(true);
  });

  test('rejects a missing N non-guarantee statement', () => {
    const manifest = validManifest();
    manifest.nNonGuarantee = '';
    const errors = validateLiveDogfoodEvidence(buildEvidence(manifest));
    expect(errors.some((e) => e.includes('nNonGuarantee'))).toBe(true);
  });

  test('reports multiple failures at once', () => {
    const manifest = validManifest();
    (manifest.candidate as Record<string, unknown>).commit = 'bad';
    (manifest.candidate as Record<string, unknown>).channel = 'dev';
    manifest.nNonGuarantee = '';
    const errors = validateLiveDogfoodEvidence(buildEvidence(manifest));
    expect(errors.length).toBeGreaterThanOrEqual(3);
  });
});
