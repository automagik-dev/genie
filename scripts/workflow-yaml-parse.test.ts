import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Structural gate for the two release/CI smokes added by wish
 * `skills-everywhere` (Group 5).
 *
 * `publish.needs` is the only thing that makes a smoke a RELEASE GATE rather
 * than decoration, and a job block can be reindented or renamed by an unrelated
 * edit without any other test noticing. This parses both workflows as YAML —
 * never by grep — and asserts the wiring, including that the pre-existing Codex
 * dogfood matrix is still present and still required.
 *
 * Parser: `Bun.YAML.parse`, so no python/PyYAML and no new dependency. It is a
 * Bun builtin (present on the 1.3.11 CI pin and the 1.3.14 dev machines); the
 * first assertion below fails with an explicit message if that ever stops
 * being true, rather than throwing an opaque TypeError.
 */

const REPO_ROOT = join(import.meta.dir, '..');
const RELEASE_PUBLISH = join(REPO_ROOT, '.github', 'workflows', 'release-publish.yml');
const CI = join(REPO_ROOT, '.github', 'workflows', 'ci.yml');

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

function stepNames(definition: YamlRecord): string[] {
  const steps = definition.steps;
  if (!Array.isArray(steps)) return [];
  return steps.filter(isRecord).map((step) => String(step.name ?? step.uses ?? ''));
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
  test('both smoke jobs are defined', () => {
    expect(Object.keys(jobs(workflow(RELEASE_PUBLISH)))).toContain('skills-install-smoke');
    expect(Object.keys(jobs(workflow(RELEASE_PUBLISH)))).toContain('release-update-path-smoke');
  });

  test('publish requires both smoke jobs', () => {
    const needs = needsOf(job(workflow(RELEASE_PUBLISH), 'publish'));
    expect(needs).toContain('skills-install-smoke');
    expect(needs).toContain('release-update-path-smoke');
  });

  test('the publish gate condition demands success from both smoke jobs', () => {
    const condition = String(job(workflow(RELEASE_PUBLISH), 'publish').if ?? '');
    expect(condition).toContain("needs.skills-install-smoke.result == 'success'");
    expect(condition).toContain("needs.release-update-path-smoke.result == 'success'");
  });

  test('the Codex dogfood matrix is untouched and still required', () => {
    const names = Object.keys(jobs(workflow(RELEASE_PUBLISH)));
    expect(names).toContain('codex-native-dogfood');
    expect(names).toContain('codex-dogfood-completeness');

    const dogfood = job(workflow(RELEASE_PUBLISH), 'codex-native-dogfood');
    expect(needsOf(dogfood)).toEqual([
      'prepare-delivery-evidence',
      'attest-delivery-evidence',
      'delivery-evidence-compatibility',
    ]);
    expect(stepNames(dogfood)).toContain('Run exact N to T lifecycle and emit reusable evidence');

    expect(needsOf(job(workflow(RELEASE_PUBLISH), 'codex-dogfood-completeness'))).toEqual([
      'prepare-delivery-evidence',
      'codex-native-dogfood',
    ]);

    const needs = needsOf(job(workflow(RELEASE_PUBLISH), 'publish'));
    expect(needs).toContain('codex-dogfood-completeness');
    expect(String(job(workflow(RELEASE_PUBLISH), 'publish').if ?? '')).toContain(
      "needs.codex-dogfood-completeness.result == 'success'",
    );
  });

  test('skills-install-smoke waits on the prepared delivery evidence', () => {
    expect(needsOf(job(workflow(RELEASE_PUBLISH), 'skills-install-smoke'))).toEqual(['prepare-delivery-evidence']);
  });

  test('release-update-path-smoke waits on the full evidence chain', () => {
    expect(needsOf(job(workflow(RELEASE_PUBLISH), 'release-update-path-smoke'))).toEqual([
      'prepare-delivery-evidence',
      'attest-delivery-evidence',
      'delivery-evidence-compatibility',
    ]);
  });

  test('release-update-path-smoke derives its platforms from the candidate manifest, never a literal list', () => {
    const smoke = job(workflow(RELEASE_PUBLISH), 'release-update-path-smoke');
    const strategy = smoke.strategy;
    if (!isRecord(strategy)) throw new Error('no strategy on release-update-path-smoke');
    // A hand-written include list would make this smoke's coverage independent
    // of the manifest promotion actually endorses (scripts/release-docs.test.ts
    // forbids exactly that for the Codex matrix); this one is a projection of it.
    expect(strategy.matrix).toBe('${{ fromJSON(needs.prepare-delivery-evidence.outputs.update_path_matrix) }}');
    expect(smoke['runs-on']).toBe('${{ matrix.runner }}');
    expect(needsOf(smoke)).toContain('prepare-delivery-evidence');

    const prepare = runScripts(job(workflow(RELEASE_PUBLISH), 'prepare-delivery-evidence'));
    expect(prepare).toContain('UPDATE_PATH_MATRIX=');
    expect(prepare).toContain('candidate-dogfood-matrix.json');
    expect(prepare).toContain('select(.platform == "linux-x64-glibc" or .platform == "linux-x64-musl")');
    expect(prepare).toContain('update_path_matrix=${UPDATE_PATH_MATRIX}');
    // The projection is only evidence if an empty or narrowed selection fails.
    expect(prepare).toContain("jq -er '.include | length'");
    expect(runScripts(smoke)).toContain('scripts/run-musl-dogfood.sh');
  });

  test('release-update-path-smoke runs the update-side delivery path and asserts its contract', () => {
    const smoke = runScripts(job(workflow(RELEASE_PUBLISH), 'release-update-path-smoke'));
    // The one thing here that no earlier job does on a plain, Codex-free host.
    expect(smoke).toContain('update --publish-local-delivery');
    expect(smoke).toContain('GENIE_RELEASE_DOGFOOD=1');
    expect(smoke).toContain('.code == "activation-pending"');
    expect(smoke).toContain('.deliveryComplete == true');
    expect(smoke).toContain('"$status" -eq 2');
    // Still the signed-bytes gate it always was.
    expect(smoke).toContain('bash scripts/verify-release.sh --local');
    expect(smoke).toContain('bun scripts/verify-delivery-evidence-pack.ts');
  });

  test('skills-install-smoke keeps the OpenAI secret off every step but the codex exec', () => {
    const smoke = job(workflow(RELEASE_PUBLISH), 'skills-install-smoke');
    const jobEnv = smoke.env;
    if (!isRecord(jobEnv)) throw new Error('skills-install-smoke has no job env');
    // Only a boolean is job-wide; the secret itself must never be visible to
    // the third-party `npx -y skills@...` download.
    expect(jobEnv.HAS_OPENAI_KEY).toBe("${{ secrets.OPENAI_API_KEY != '' }}");
    expect(Object.keys(jobEnv)).not.toContain('OPENAI_API_KEY');

    const steps = Array.isArray(smoke.steps) ? smoke.steps.filter(isRecord) : [];
    const withSecret = steps.filter((step) => {
      const stepEnv = step.env;
      return isRecord(stepEnv) && String(stepEnv.OPENAI_API_KEY ?? '').includes('secrets.OPENAI_API_KEY');
    });
    expect(withSecret.map((step) => String(step.name))).toEqual([
      'Prove Codex can invoke an installed skill non-interactively',
    ]);
    for (const step of steps) {
      expect(String(step.if ?? '')).not.toContain('env.OPENAI_API_KEY');
    }
  });

  test('both pinned skills.sh invocations are attempt-bounded, not fire-once', () => {
    for (const [file, jobId] of [
      [RELEASE_PUBLISH, 'skills-install-smoke'],
      [CI, 'skills-inventory-parity'],
    ] as const) {
      const script = runScripts(job(workflow(file), jobId));
      expect(script).toContain('until npx -y skills@');
      expect(script).toContain('attempt >= 3');
      expect(script).toContain('sleep $(( attempt * 15 ))');
    }
  });

  test('the installed skill tree is compared whole, not one entry file', () => {
    const smoke = runScripts(job(workflow(RELEASE_PUBLISH), 'skills-install-smoke'));
    expect(smoke).toContain('diff -r --no-dereference -- "skills/${name}" "${home}/${name}"');
    // The physical-file check on SKILL.md stays: `diff -r` alone would accept a
    // symlink whose target happens to match.
    expect(smoke).toContain('! -f "$installed" || -L "$installed"');
    expect(smoke).not.toContain('cmp -s --');
  });
});

describe('ci.yml gates', () => {
  test('the inventory parity check is its own job, and unit stays network-free', () => {
    const names = Object.keys(jobs(workflow(CI)));
    expect(names).toContain('skills-inventory-parity');
    expect(names).toEqual(expect.arrayContaining(['unit', 'e2e', 'codex-smoke', 'quality-gate']));

    const parity = runScripts(job(workflow(CI), 'skills-inventory-parity'));
    expect(parity).toContain('skills-inventory-parity.ts');
    expect(parity).toContain('--list');

    const unit = runScripts(job(workflow(CI), 'unit'));
    expect(unit).not.toContain('skills-inventory-parity');
    expect(unit).not.toContain('npx -y skills@');
  });
});

describe('pins agree across the workflows and the shipped source', () => {
  const installer = readFileSync(join(REPO_ROOT, 'src', 'lib', 'skills-installer.ts'), 'utf8');
  const releasePublishText = readFileSync(RELEASE_PUBLISH, 'utf8');
  const ciText = readFileSync(CI, 'utf8');

  test('every workflow invocation uses the pinned SKILLS_CLI_VERSION', () => {
    const pinned = installer.match(/SKILLS_CLI_VERSION = '([^']+)'/)?.[1];
    expect(pinned).toBeDefined();
    const invocation = `npx -y skills@${pinned as string} add`;
    expect(releasePublishText).toContain(invocation);
    expect(ciText).toContain(invocation);
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

  test('the new smoke reuses the Codex pin and the Alpine image digest already in use', () => {
    const codexPins = [...releasePublishText.matchAll(/@openai\/codex@([\w.]+)/g)].map((match) => match[1]);
    expect(codexPins.length).toBeGreaterThan(1);
    expect(new Set(codexPins).size).toBe(1);

    const adapterImage = readFileSync(join(REPO_ROOT, 'scripts', 'run-musl-dogfood.sh'), 'utf8').match(
      /alpine:[\w.]+@sha256:[0-9a-f]{64}/,
    )?.[0];
    expect(adapterImage).toBeDefined();
    const workflowImages = [...releasePublishText.matchAll(/alpine:[\w.]+@sha256:[0-9a-f]{64}/g)].map(
      (match) => match[0],
    );
    expect(workflowImages).toHaveLength(2);
    expect(new Set(workflowImages)).toEqual(new Set([adapterImage as string]));
  });
});
