import { expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { engineAccountingBlockers, validateNativeManifestBinding, workingTreeSha256 } from './engine-experiment';
import { fileSha256 } from './engine-experiment-runtime.mjs';

const script = fileURLToPath(new URL('./engine-experiment.ts', import.meta.url));

test('operator help is repeatable and never creates experiment or caller state', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'engine-experiment-help-'));
  try {
    for (let run = 0; run < 2; run++) {
      const result = Bun.spawnSync([process.execPath, script, '--help'], {
        cwd,
        env: { PATH: process.env.PATH, HOME: cwd, GENIE_HOME: join(cwd, 'genie-home') },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      expect(result.exitCode).toBe(0);
      expect(result.stderr.toString()).toBe('');
    }
    for (const state of ['.mikro', '.genie', 'genie-home']) expect(existsSync(join(cwd, state))).toBe(false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('missing, malformed and unrecognized experiment inputs cannot fall back to an ambient production run', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'engine-experiment-refusal-'));
  try {
    const invalid = join(cwd, 'invalid.json');
    const credential = 'synthetic-experiment-credential-for-leak-check';
    writeFileSync(invalid, '{');
    for (const argv of [[], ['--manifest'], ['--manifest', invalid], ['--unregistered-cell'], [`--${credential}`]]) {
      const result = Bun.spawnSync([process.execPath, script, ...argv], {
        cwd,
        env: { PATH: process.env.PATH, HOME: cwd, GENIE_HOME: join(cwd, 'genie-home'), DEEPSEEK_API_KEY: credential },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      expect(result.exitCode).toBe(1);
      expect(result.stdout.toString()).toBe('');
      expect(result.stdout.toString()).not.toContain(credential);
      expect(result.stderr.toString()).not.toContain(credential);
      for (const state of ['.mikro', '.genie', 'genie-home']) expect(existsSync(join(cwd, state))).toBe(false);
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('unknown and partially observed SDK totals block the owning cell without discarding its subtotal', () => {
  for (const subtotal of [null, 0.125]) {
    const record = {
      cell: { id: 'accounting-cell' },
      receiptProblems: [],
      sdkNominalKnownSubtotalUsd: subtotal,
      sdkNominalTotalUsd: null,
    };
    const blockers = engineAccountingBlockers([record]);
    expect(blockers).toHaveLength(1);
    expect(blockers[0].startsWith(`${record.cell.id}:`)).toBe(true);
    expect(record.sdkNominalKnownSubtotalUsd).toBe(subtotal);
    expect(record.sdkNominalTotalUsd).toBeNull();
  }
});

test('known SDK totals including actual zero have coverage, but do not erase existing provenance blockers', () => {
  for (const total of [0, 0.125]) {
    const record = {
      cell: { id: 'accounting-cell' },
      receiptProblems: [],
      sdkNominalTotalUsd: total,
    };
    expect(engineAccountingBlockers([record])).toEqual([]);
    const blockers = engineAccountingBlockers([{ ...record, receiptProblems: ['fixture identity changed'] }]);
    expect(blockers).toHaveLength(1);
    expect(blockers[0].startsWith(`${record.cell.id}:`)).toBe(true);
  }
});

// Identity/resource metadata only: no scored run, model response, smoke success or native completion is invented.
function nativeBindingMetadata(root: string) {
  const cell = (id: string) => ({
    id,
    cwd: join(root, 'repositories', id),
    gitCommonDir: join(root, 'git', id),
    runRoot: join(root, 'runs', id),
    args: { objective: 'binding metadata', model: 'deepseek-flash', offload: false, offloadEngine: 'rlm' },
    offloadLedgerRoots: [join(root, 'ledgers', id)],
    launch: { offloadReceiptRoot: join(root, 'sdk', id), seals: [] },
    remotePolicy: { mode: 'authorized-github' },
  });
  const workflow = {
    schemaVersion: 1,
    receiptPath: join(root, 'comparison.json'),
    smokeReceiptPath: join(root, 'smoke.json'),
    runtime: { root: join(root, 'runtime'), version: '0.2.0-rc.1' },
    loader: { root: join(root, 'loader') },
    auth: { controlKeyFile: join(root, 'private-key-reference') },
    smoke: cell('smoke'),
    cells: Array.from({ length: 18 }, (_, index) => cell(`cell-${index}`)),
  };
  const nativePath = join(root, 'native-input.json');
  writeFileSync(nativePath, JSON.stringify({ workflow }));
  const manifest = {
    workflow: {
      ...workflow,
      nativeManifest: { kind: 'file' as const, path: nativePath, sha256: fileSha256(nativePath) },
    },
    outputRoot: join(root, 'engine-output'),
    protectedRoots: [],
    fixtures: [],
    harnessSeals: [],
  };
  const enginePath = join(root, 'engine-input.json');
  writeFileSync(enginePath, JSON.stringify(manifest));
  return { manifest, nativePath, enginePath };
}

test('native binding consumes the independent frozen input identity, not the engine identity', () => {
  const root = mkdtempSync(join(tmpdir(), 'native-binding-identity-'));
  try {
    const { manifest, nativePath, enginePath } = nativeBindingMetadata(root);
    const binding = validateNativeManifestBinding(manifest, enginePath);
    expect(binding.sha256).toBe(fileSha256(nativePath));
    expect(binding.sha256).not.toBe(fileSha256(enginePath));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('native input byte tampering cannot retain its frozen identity even when the JSON meaning is unchanged', () => {
  const root = mkdtempSync(join(tmpdir(), 'native-binding-tamper-'));
  try {
    const { manifest, nativePath, enginePath } = nativeBindingMetadata(root);
    const { nativeManifest, ...workflow } = manifest.workflow;
    writeFileSync(nativePath, `${JSON.stringify({ workflow })}\n`);
    expect(fileSha256(nativePath)).not.toBe(nativeManifest.sha256);
    expect(() => validateNativeManifestBinding(manifest, enginePath)).toThrow();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('registered native IDs, resources, arguments and runtime controls cannot diverge from the independent input', () => {
  const root = mkdtempSync(join(tmpdir(), 'native-binding-controls-'));
  try {
    const { manifest, enginePath } = nativeBindingMetadata(root);
    const changes = [
      (workflow: typeof manifest.workflow) => {
        workflow.cells[0].id = 'different-cell';
      },
      (workflow: typeof manifest.workflow) => {
        workflow.cells[0].cwd = join(root, 'other-repository');
      },
      (workflow: typeof manifest.workflow) => {
        workflow.cells[0].gitCommonDir = join(root, 'other-git');
      },
      (workflow: typeof manifest.workflow) => {
        workflow.cells[0].runRoot = join(root, 'other-state');
      },
      (workflow: typeof manifest.workflow) => {
        workflow.cells[0].launch.offloadReceiptRoot = join(root, 'other-sdk');
      },
      (workflow: typeof manifest.workflow) => {
        workflow.cells[0].args.objective = 'different objective';
      },
      (workflow: typeof manifest.workflow) => {
        workflow.smoke.args.model = 'different control';
      },
      (workflow: typeof manifest.workflow) => {
        workflow.runtime.root = join(root, 'other-runtime');
      },
      (workflow: typeof manifest.workflow) => {
        workflow.loader.root = join(root, 'other-loader');
      },
      (workflow: typeof manifest.workflow) => {
        workflow.auth.controlKeyFile = join(root, 'other-key-reference');
      },
    ];
    for (const change of changes) {
      const altered = structuredClone(manifest);
      change(altered.workflow);
      expect(() => validateNativeManifestBinding(altered, enginePath)).toThrow();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('native input cannot also be engine input or belong to mutable engine/native state', () => {
  const root = mkdtempSync(join(tmpdir(), 'native-binding-roots-'));
  try {
    const { manifest, nativePath, enginePath } = nativeBindingMetadata(root);
    expect(() => validateNativeManifestBinding(manifest, nativePath)).toThrow();
    expect(() => validateNativeManifestBinding({ ...manifest, outputRoot: root }, enginePath)).toThrow();
    manifest.workflow.smoke.runRoot = root;
    const { nativeManifest, ...workflow } = manifest.workflow;
    writeFileSync(nativePath, JSON.stringify({ workflow }));
    nativeManifest.sha256 = fileSha256(nativePath);
    expect(() => validateNativeManifestBinding(manifest, enginePath)).toThrow();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function fixtureHashTree(root: string) {
  const tree = join(root, 'checkout');
  mkdirSync(join(tree, 'nested', '.git'), { recursive: true });
  mkdirSync(join(tree, 'empty'));
  mkdirSync(join(tree, '.git'));
  writeFileSync(join(tree, 'file.txt'), 'parent bytes');
  writeFileSync(join(tree, '.hidden'), 'hidden parent bytes');
  writeFileSync(join(tree, 'nested', '.git', 'config'), 'nested physical bytes');
  writeFileSync(join(tree, '.git', 'config'), 'root administrative bytes');
  return tree;
}

test('fixture identity accepts root/nested/dangling/external links without depending on target contents', () => {
  const root = mkdtempSync(join(tmpdir(), 'fixture-links-'));
  try {
    const tree = fixtureHashTree(root);
    const outside = join(root, 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, 'target'), 'outside before');
    symlinkSync(tree, join(outside, 'cycle'));
    symlinkSync(outside, join(tree, 'docs'));
    symlinkSync(join(outside, 'target'), join(tree, 'external-file'));
    symlinkSync('../file.txt', join(tree, 'nested', 'internal-link'));
    symlinkSync('../../absent-target', join(tree, 'nested', 'dangling'));
    symlinkSync(join(root, 'absent-root-target'), join(tree, 'root-dangling'));
    const before = workingTreeSha256(tree);
    expect(workingTreeSha256(tree)).toBe(before);
    writeFileSync(join(outside, 'target'), 'outside after');
    writeFileSync(join(outside, 'added'), 'outside added');
    expect(workingTreeSha256(tree)).toBe(before);
    rmSync(outside, { recursive: true });
    expect(workingTreeSha256(tree)).toBe(before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('fixture identity binds root and nested link text even when the resolved target stays the same', () => {
  const root = mkdtempSync(join(tmpdir(), 'fixture-link-text-'));
  try {
    const tree = fixtureHashTree(root);
    for (const [path, target] of [
      [join(tree, 'root-link'), 'file.txt'],
      [join(tree, 'nested', 'nested-link'), '../file.txt'],
    ]) {
      symlinkSync(target, path);
      const before = workingTreeSha256(tree);
      unlinkSync(path);
      symlinkSync(join(tree, 'file.txt'), path);
      expect(workingTreeSha256(tree)).not.toBe(before);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('fixture identity binds bytes, names, empty directories, hidden paths and nested Git entries', () => {
  const mutations = [
    (tree: string) => writeFileSync(join(tree, 'file.txt'), 'different parent bytes'),
    (tree: string) => renameSync(join(tree, 'file.txt'), join(tree, 'renamed.txt')),
    (tree: string) => mkdirSync(join(tree, 'new-empty')),
    (tree: string) => writeFileSync(join(tree, '.hidden'), 'different hidden bytes'),
    (tree: string) => writeFileSync(join(tree, 'nested', '.git', 'config'), 'different nested Git bytes'),
  ];
  for (const mutate of mutations) {
    const root = mkdtempSync(join(tmpdir(), 'fixture-structure-'));
    try {
      const tree = fixtureHashTree(root);
      const before = workingTreeSha256(tree);
      mutate(tree);
      expect(workingTreeSha256(tree)).not.toBe(before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test('fixture identity is traversal-order independent and excludes only root Git administration', () => {
  const root = mkdtempSync(join(tmpdir(), 'fixture-order-'));
  try {
    const first = join(root, 'first');
    const second = join(root, 'second');
    for (const [tree, names] of [
      [first, ['z', 'a', '.hidden']],
      [second, ['.hidden', 'a', 'z']],
    ] as const) {
      mkdirSync(tree);
      for (const name of names) writeFileSync(join(tree, name), `bytes:${name}`);
      symlinkSync('absent', join(tree, 'dangling'));
    }
    const before = workingTreeSha256(first);
    expect(workingTreeSha256(second)).toBe(before);
    mkdirSync(join(first, '.git'));
    writeFileSync(join(first, '.git', 'config'), 'excluded administration');
    mkdirSync(join(first, '.git', 'empty'));
    expect(workingTreeSha256(first)).toBe(before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
