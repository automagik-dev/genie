import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Structural gate for the release-publish chain and the CI skills.sh parity job.
 *
 * `publish.needs` is the only thing that makes a job a RELEASE GATE rather than
 * decoration, and a job block can be reindented or renamed by an unrelated edit
 * without any other test noticing. This parses the workflows as YAML — never by
 * grep — and asserts the wiring. Since the 2026-11-05 owner decision the chain
 * carries no caller-admission job, no candidate smoke and no separate security
 * gate: publish waits on the delivery-evidence endorsements and the production
 * verifier's compatibility check, and on nothing else.
 *
 * Parser: `Bun.YAML.parse`, so no python/PyYAML and no new dependency. It is a
 * Bun builtin (present on both CI Bun lines, 1.3.11 and 1.4.4); the
 * first assertion below fails with an explicit message if that ever stops
 * being true, rather than throwing an opaque TypeError.
 */

const REPO_ROOT = join(import.meta.dir, '..');
const RELEASE_PUBLISH = join(REPO_ROOT, '.github', 'workflows', 'release-publish.yml');
const CI = join(REPO_ROOT, '.github', 'workflows', 'ci.yml');
const WORKFLOWS = join(REPO_ROOT, '.github', 'workflows');

type YamlRecord = Record<string, unknown>;

function isRecord(value: unknown): value is YamlRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseWorkflow(path: string): YamlRecord {
  const parsed = Bun.YAML.parse(readFileSync(path, 'utf8'));
  if (!isRecord(parsed)) throw new Error(`${path} did not parse as a YAML mapping`);
  return parsed;
}

function jobs(workflow: YamlRecord): YamlRecord {
  const value = workflow.jobs;
  if (!isRecord(value)) throw new Error('workflow has no jobs mapping');
  return value;
}

function job(workflow: YamlRecord, id: string): YamlRecord {
  const value = jobs(workflow)[id];
  if (!isRecord(value)) throw new Error(`workflow has no job "${id}"`);
  return value;
}

/** `needs` is either a single string or a sequence; normalize both. */
function needsOf(definition: YamlRecord): string[] {
  const value = definition.needs;
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.map((entry) => String(entry));
  return [];
}

function runScripts(definition: YamlRecord): string {
  const steps = definition.steps;
  if (!Array.isArray(steps)) return '';
  return steps
    .filter(isRecord)
    .map((step) => (typeof step.run === 'string' ? step.run : ''))
    .join('\n');
}

/**
 * Parsed lazily and memoized: at module top level the very first `Bun.YAML`
 * call would happen during collection, so the guard test below could never run
 * on a runtime without it — it would die with an opaque TypeError before any
 * test body executed. Nothing here parses until a test asks for a workflow.
 */
const parsedWorkflows = new Map<string, YamlRecord>();

function workflow(path: string): YamlRecord {
  const cached = parsedWorkflows.get(path);
  if (cached !== undefined) return cached;
  const parsed = parseWorkflow(path);
  parsedWorkflows.set(path, parsed);
  return parsed;
}

describe('Bun.YAML availability', () => {
  test('the builtin parser this suite depends on exists', () => {
    expect(typeof Bun.YAML?.parse).toBe('function');
  });
});

describe('release-publish.yml gates', () => {
  const REMOVED = [
    'admit',
    'skills-install-smoke',
    'release-update-path-smoke',
    'stable-release-security-gate',
    'codex-native-dogfood',
    'codex-dogfood-completeness',
  ];

  test('the removed gates are gone and nothing needs them', () => {
    const names = Object.keys(jobs(workflow(RELEASE_PUBLISH)));
    for (const removed of REMOVED) expect(names).not.toContain(removed);
    for (const id of names) {
      for (const removed of REMOVED) {
        expect(needsOf(job(workflow(RELEASE_PUBLISH), id))).not.toContain(removed);
        expect(String(job(workflow(RELEASE_PUBLISH), id).if ?? '')).not.toContain(`needs.${removed}.`);
      }
    }
  });

  /**
   * Pinning the full set (and the matching `if:` guard for each survivor) is
   * what makes a future accidental drop of the evidence check a test failure
   * rather than a silently weaker release.
   */
  test('publish requires exactly the two delivery-evidence gates, each with its if-guard', () => {
    const publish = job(workflow(RELEASE_PUBLISH), 'publish');
    const needs = needsOf(publish);
    expect(needs).toEqual(['attest-delivery-evidence', 'delivery-evidence-compatibility']);
    const condition = String(publish.if ?? '');
    expect(condition).toContain('always()');
    for (const gate of needs) {
      expect(condition).toContain(`needs.${gate}.result == 'success'`);
    }
  });

  test('the evidence chain runs prepare -> attest -> compatibility in order', () => {
    expect(needsOf(job(workflow(RELEASE_PUBLISH), 'prepare-delivery-evidence'))).toEqual([]);
    expect(needsOf(job(workflow(RELEASE_PUBLISH), 'attest-delivery-evidence'))).toEqual(['prepare-delivery-evidence']);
    expect(needsOf(job(workflow(RELEASE_PUBLISH), 'delivery-evidence-compatibility'))).toEqual([
      'attest-delivery-evidence',
    ]);
    expect(needsOf(job(workflow(RELEASE_PUBLISH), 'finalize'))).toEqual(['publish']);
    expect(needsOf(job(workflow(RELEASE_PUBLISH), 'manifests'))).toEqual(['finalize']);
  });

  /**
   * The #2674 replay guard was the second step of the deleted admit job. It is
   * not a caller gate — it refuses a re-dispatch whose failure would otherwise
   * land after the release is published and locked — so it moved, verbatim, to
   * be the first step of prepare-delivery-evidence (release-replay-guard.test.ts
   * runs its body).
   */
  test('the replay guard is the first step of prepare-delivery-evidence', () => {
    const steps = job(workflow(RELEASE_PUBLISH), 'prepare-delivery-evidence').steps;
    if (!Array.isArray(steps) || !isRecord(steps[0])) throw new Error('prepare-delivery-evidence has no steps');
    expect(steps[0].name).toBe('Refuse re-dispatch of an already published release');
  });

  test('prepare-delivery-evidence still derives the platform inventory from candidate-dogfood-matrix.ts', () => {
    expect(runScripts(job(workflow(RELEASE_PUBLISH), 'prepare-delivery-evidence'))).toContain(
      'bun scripts/candidate-dogfood-matrix.ts',
    );
  });

  /**
   * G6 deleted three executable release controls. A workflow that still invokes
   * one of them is green locally and red only in a real release run, so every
   * `run:` block in every workflow is checked against the deleted set.
   */
  test('no workflow invokes a script deleted with the dogfood matrix', () => {
    const deleted = [
      'tests/support/codex-dogfood-entry-runner.ts',
      'tests/support/codex-dogfood-harness.ts',
      'scripts/validate-live-dogfood-evidence.ts',
      'scripts/validate-dogfood-matrix-evidence.ts',
      'scripts/build.js',
      'scripts/sync.js',
    ];
    for (const name of readdirSync(join(REPO_ROOT, '.github', 'workflows')).filter((entry) => entry.endsWith('.yml'))) {
      const source = readFileSync(join(REPO_ROOT, '.github', 'workflows', name), 'utf8');
      for (const path of deleted) {
        expect(`${name}: ${source.includes(path)}`).toBe(`${name}: false`);
      }
    }
  });
});

describe('ci.yml gates', () => {
  test('the inventory parity check is its own job, and unit stays network-free', () => {
    const names = Object.keys(jobs(workflow(CI)));
    expect(names).toContain('skills-inventory-parity');
    expect(names).toEqual(expect.arrayContaining(['unit', 'e2e', 'quality-gate']));

    const parity = runScripts(job(workflow(CI), 'skills-inventory-parity'));
    expect(parity).toContain('skills-inventory-parity.ts');
    expect(parity).toContain('--list');

    const unit = runScripts(job(workflow(CI), 'unit'));
    expect(unit).not.toContain('skills-inventory-parity');
    expect(unit).not.toContain('npx -y skills@');
  });

  test('the pinned skills.sh invocation is attempt-bounded, not fire-once', () => {
    const script = runScripts(job(workflow(CI), 'skills-inventory-parity'));
    expect(script).toContain('until npx -y skills@');
    expect(script).toContain('attempt >= 3');
    expect(script).toContain('sleep $(( attempt * 15 ))');
  });

  /**
   * #2942: the legacy-skills catalog was regenerated by hand and gated by
   * nothing. It cannot join `bun run check` — the generator walks `git log
   * --all`, and a shallow checkout would regenerate an incomplete catalog —
   * so the gate is a CI step whose checkout fetches the FULL history. The
   * depth assertion is the load-bearing half: the step alone, on a depth-1
   * checkout, would be a check that proves nothing.
   */
  test('the legacy-skills catalog check runs in unit, on a full-history checkout', () => {
    const unit = job(workflow(CI), 'unit');
    expect(runScripts(unit)).toContain('legacy-skills-catalog.ts --check');

    const steps = unit.steps;
    if (!Array.isArray(steps)) throw new Error('unit job has no steps');
    const checkout = steps
      .filter(isRecord)
      .find((step) => typeof step.uses === 'string' && step.uses.startsWith('actions/checkout@'));
    if (checkout === undefined) throw new Error('unit job has no checkout step');
    const withBlock = checkout.with;
    if (!isRecord(withBlock)) throw new Error('unit checkout has no `with:` block');
    expect(withBlock['fetch-depth']).toBe(0);
  });
});

describe('pins agree across the workflows and the shipped source', () => {
  const installer = readFileSync(join(REPO_ROOT, 'src', 'lib', 'skills-installer.ts'), 'utf8');
  const releasePublishText = readFileSync(RELEASE_PUBLISH, 'utf8');
  const ciText = readFileSync(CI, 'utf8');

  test('every workflow invocation uses the pinned SKILLS_CLI_VERSION', () => {
    const pinned = installer.match(/SKILLS_CLI_VERSION = '([^']+)'/)?.[1];
    expect(pinned).toBeDefined();
    expect(ciText).toContain(`npx -y skills@${pinned as string} add`);
    // No unpinned or differently pinned invocation anywhere in either file.
    // The version class deliberately excludes `<`/`>` so the prose reference
    // `skills@<SKILLS_CLI_VERSION>` in a comment is not read as a pin.
    for (const text of [releasePublishText, ciText]) {
      expect(text).not.toContain('npx -y skills add');
      for (const match of text.matchAll(/npx -y skills@([\w.-]+) add/g)) {
        expect(match[1]).toBe(pinned as string);
      }
    }
  });

  /**
   * The Codex and Alpine pins in release-publish.yml lived only in the two
   * candidate smokes deleted on 2026-11-05. A pin reintroduced there would be
   * a second copy nothing keeps in step with the musl adapter, so it fails here.
   */
  test('release-publish.yml carries no Codex or Alpine pin since the smokes left', () => {
    expect(releasePublishText).not.toMatch(/@openai\/codex@/);
    expect(releasePublishText).not.toMatch(/alpine:[\w.]+@sha256:/);
  });
});

/**
 * The Bun pin set (#3194, council 2026-11-03). Genie must stay seamless on both
 * supported Bun lines, so the two unit legs run each one as a REQUIRED matrix
 * entry; every other job, and in particular everything that builds a shipped
 * artifact, stays on the 1.3 line until the 1.4 pin move lands on its own.
 */
describe('Bun pin set', () => {
  const SUPPORTED_BUN_LINES = ['1.3.11', '1.4.4'];
  const ARTIFACT_PIN = '1.3.11';

  function setupBunVersions(definition: YamlRecord): unknown[] {
    const steps = definition.steps;
    if (!Array.isArray(steps)) return [];
    return steps
      .filter(isRecord)
      .filter((step) => typeof step.uses === 'string' && step.uses.startsWith('oven-sh/setup-bun@'))
      .map((step) => (isRecord(step.with) ? step.with['bun-version'] : undefined));
  }

  test('unit and unit-darwin run every supported Bun line, and the Quality Gate requires them all', () => {
    const ci = workflow(CI);
    for (const id of ['unit', 'unit-darwin']) {
      const definition = job(ci, id);
      const strategy = definition.strategy;
      if (!isRecord(strategy) || !isRecord(strategy.matrix)) throw new Error(`${id} has no strategy.matrix`);
      expect(strategy.matrix.bun).toEqual(SUPPORTED_BUN_LINES);
      // fail-fast would cancel the other line on the first red one and hide it.
      expect(strategy['fail-fast']).toBe(false);
      expect(setupBunVersions(definition)).toEqual(['${{ matrix.bun }}']);
      expect(String(definition.name)).toContain('${{ matrix.bun }}');
    }
    // A matrix job's `needs.<id>.result` is success only when EVERY entry
    // succeeded, so needing both jobs makes each entry a required check.
    expect(needsOf(job(ci, 'quality-gate'))).toEqual(expect.arrayContaining(['unit', 'unit-darwin']));
  });

  test('every other setup-bun step in every workflow is pinned to the artifact line', () => {
    const pins: string[] = [];
    for (const file of readdirSync(WORKFLOWS).filter((name) => /\.ya?ml$/.test(name))) {
      for (const [id, definition] of Object.entries(jobs(workflow(join(WORKFLOWS, file))))) {
        if (!isRecord(definition)) continue;
        if (file === 'ci.yml' && (id === 'unit' || id === 'unit-darwin')) continue;
        for (const version of setupBunVersions(definition)) pins.push(`${file}:${id}=${String(version)}`);
      }
    }
    // release-publish and build-tarballs build the shipped binaries and must
    // never drift to an unreviewed line; they are named so a rename is caught.
    expect(pins.some((pin) => pin.startsWith('release-publish.yml:'))).toBe(true);
    expect(pins.some((pin) => pin.startsWith('build-tarballs.yml:'))).toBe(true);
    expect(pins.filter((pin) => !pin.endsWith(`=${ARTIFACT_PIN}`))).toEqual([]);
  });
});
