import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const VALIDATOR_PATH = join(import.meta.dir, 'validate-wish.cjs');
const validator = require('./validate-wish.cjs') as {
  TEMPLATE_CONTRACT_DATE: string;
  WISH_FILE_SIZE_CAP: number;
  isLegacyWish: (content: string) => boolean;
  normaliseStatus: (raw: string | null | undefined) => string | null;
  parseHookInput: (raw: string) => Record<string, unknown> | null;
  parseWishTemplateContract: (template: string) => {
    sections: string[];
    subsections: string[];
    groupHeadingSource: string;
    groupHeadingPattern: RegExp;
    checkboxPattern: RegExp;
  };
  proposedWishContent: (current: string, hook: Record<string, unknown>) => string | null;
  readWishDate: (content: string) => string | null;
  readWishFile: (path: string) => { kind: 'content' | 'missing' | 'error'; content?: string; reason?: string };
  readWishStatus: (content: string) => string | null;
  validateWish: (content: string) => { passed: boolean; issues: Array<{ line: number; message: string }> };
};

const REPO_ROOT = join(import.meta.dir, '..', '..', '..');
const TEMPLATE_PATH = join(REPO_ROOT, 'skills', 'wish', 'templates', 'wish-template.md');

const NEW_DATE = '2026-08-13';
const LEGACY_DATE = '2026-07-01';

function templateDoc(overrides: { date?: string; status?: string } = {}): string {
  const template = readFileSync(TEMPLATE_PATH, 'utf8');
  return template
    .replace(/\{\{date\}\}/g, overrides.date ?? NEW_DATE)
    .replace(/\{\{slug\}\}/g, 'fixture')
    .replace(/\|\s*\*\*Status\*\*\s*\|[^|]*\|/, `| **Status** | ${overrides.status ?? 'DRAFT'} |`);
}

function legacyDoc(status = 'DONE — historical'): string {
  return `# Wish: Fixture

**Status:** ${status}
**Date:** ${LEGACY_DATE}

## Execution Group 1: something

**Goal:** fixture.
`;
}

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'genie-validate-wish-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function writeWish(content: string, name = 'WISH.md'): string {
  const dir = join(root, '.genie', 'wishes', 'fixture');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, content);
  return path;
}

function runCli(args: string[], stdin?: string): { code: number; stderr: string } {
  const result = Bun.spawnSync(['node', VALIDATOR_PATH, ...args], {
    stdin: stdin === undefined ? undefined : Buffer.from(stdin),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return { code: result.exitCode, stderr: result.stderr.toString() };
}

function hookEvent(event: string, toolInput: Record<string, unknown>): string {
  return JSON.stringify({ hook_event_name: event, tool_input: toolInput });
}

describe('template-derived parser', () => {
  test('the raw template fixture validates clean — digit groups, table status, checkboxes included', () => {
    const result = validator.validateWish(readFileSync(TEMPLATE_PATH, 'utf8'));
    expect(result.passed).toBe(true);
    expect(result.issues).toEqual([]);
  });

  test('the contract is parsed from the template fixture', () => {
    const contract = validator.parseWishTemplateContract(readFileSync(TEMPLATE_PATH, 'utf8'));
    expect(contract.sections).toContain('Summary');
    expect(contract.sections).toContain('Execution Groups');
    expect(contract.subsections).toEqual(['IN', 'OUT']);
    expect(contract.groupHeadingSource).toBe('Group 1:');
  });

  test('removing any template section fails and names the missing section', () => {
    const template = templateDoc();
    for (const heading of ['## Summary', '## Scope', '## Success Criteria', '## Execution Groups']) {
      const broken = template.replace(new RegExp(`^${heading}\\s*$\\n`, 'm'), '');
      const result = validator.validateWish(broken);
      expect(result.passed).toBe(false);
      expect(result.issues.some((issue) => issue.message.includes(heading))).toBe(true);
    }
  });

  test('a doc dated on/after the contract date is strict even when it looks legacy', () => {
    const result = validator.validateWish(legacyDoc().replace(LEGACY_DATE, NEW_DATE));
    expect(result.passed).toBe(false);
    expect(result.issues.some((issue) => issue.message.includes('## Execution Groups'))).toBe(true);
  });

  test('a doc with an invalid date cannot bypass the contract', () => {
    const result = validator.validateWish(legacyDoc().replace(LEGACY_DATE, '{{date}}'));
    expect(result.passed).toBe(false);
    expect(result.issues.some((issue) => issue.message.includes('## Execution Groups'))).toBe(true);
  });
});

describe('legacy formats tolerated', () => {
  test('a pre-contract legacy doc passes with a title and a status', () => {
    const result = validator.validateWish(legacyDoc());
    expect(result.passed).toBe(true);
    expect(result.issues).toEqual([]);
  });

  test('a legacy doc without a status is rejected', () => {
    const result = validator.validateWish(legacyDoc().replace(/^\*\*Status:\*\*.*$/m, ''));
    expect(result.passed).toBe(false);
    expect(result.issues.some((issue) => issue.message.includes('Status'))).toBe(true);
  });

  test('a new doc without a Wish title is rejected', () => {
    const result = validator.validateWish(templateDoc().replace(/^# Wish:.*$/m, '# Notes'));
    expect(result.passed).toBe(false);
    expect(result.issues.some((issue) => issue.message.includes('# Wish:'))).toBe(true);
  });

  test('legacy **Status:** lines are read when the table row is absent', () => {
    expect(validator.readWishStatus(legacyDoc())).toBe('DONE');
  });

  test('the table-row status is read in precedence over the legacy line', () => {
    const doc = `${legacyDoc()}\n| **Status** | SHIPPED |\n`;
    expect(validator.readWishStatus(doc)).toBe('SHIPPED');
  });

  test('status annotations are normalised like the corpus linter does', () => {
    expect(validator.normaliseStatus('SHIPPED — QA pending')).toBe('SHIPPED');
    expect(validator.normaliseStatus('DONE (2026-07-02)')).toBe('DONE');
    expect(validator.normaliseStatus('MERGED — QA pending')).toBe('MERGED');
  });
});

describe('checkbox rule and completed docs', () => {
  test('a new DRAFT doc needs checkbox items under Success Criteria', () => {
    const doc = templateDoc().replace(/- \[ \] <TODO: testable criterion 1>\n/, '').replace(/- \[ \] <TODO: testable criterion 2>\n/, '');
    const result = validator.validateWish(doc);
    expect(result.passed).toBe(false);
    expect(result.issues.some((issue) => issue.message.includes('checkbox items'))).toBe(true);
  });

  test('checked boxes satisfy the rule', () => {
    const doc = templateDoc().replaceAll('- [ ] <TODO: testable criterion', '- [x] <TODO: testable criterion');
    const result = validator.validateWish(doc);
    expect(result.passed).toBe(true);
  });

  test('a completed doc is exempt from the checkbox rule entirely', () => {
    const doc = templateDoc({ status: 'SHIPPED' })
      .replace(/- \[ \] <TODO: testable criterion 1>\n/, '')
      .replace(/- \[ \] <TODO: testable criterion 2>\n/, '');
    const result = validator.validateWish(doc);
    expect(result.passed).toBe(true);
  });
});

describe('execution groups', () => {
  test('named groups satisfy the template-derived group shape', () => {
    const doc = templateDoc().replace('### Group 1: <TODO: Group 1 title>', '### Group validator: template-derived');
    expect(validator.validateWish(doc).passed).toBe(true);
  });

  test('a group without Acceptance Criteria or Validation is rejected', () => {
    const doc = templateDoc().replace('**Acceptance Criteria:**', '**Notes:**');
    const result = validator.validateWish(doc);
    expect(result.passed).toBe(false);
    expect(result.issues.some((issue) => issue.message.includes('Acceptance Criteria'))).toBe(true);
  });

  test('an Execution Groups section without any group heading is rejected', () => {
    const doc = templateDoc().replace('### Group 1: <TODO: Group 1 title>\n', '');
    const result = validator.validateWish(doc);
    expect(result.passed).toBe(false);
    expect(result.issues.some((issue) => issue.message.includes('group heading'))).toBe(true);
  });
});

describe('symlink reject and size cap', () => {
  test('a symlinked wish file is refused with a named error', () => {
    const target = join(root, 'real-wish.md');
    writeFileSync(target, templateDoc());
    const link = writeWish('ignored');
    rmSync(link);
    symlinkSync(target, link);
    const read = validator.readWishFile(link);
    expect(read.kind).toBe('error');
    expect(read.reason).toContain('symbolic link');
  });

  test('a file over the size cap is refused with a named error', () => {
    const big = `${templateDoc()}\n${'x'.repeat(validator.WISH_FILE_SIZE_CAP)}\n`;
    const read = validator.readWishFile(writeWish(big));
    expect(read.kind).toBe('error');
    expect(read.reason).toContain('size cap');
  });

  test('a file at the size cap is read', () => {
    const fit = 'x'.repeat(validator.WISH_FILE_SIZE_CAP - 10);
    const doc = templateDoc().slice(0, validator.WISH_FILE_SIZE_CAP - fit.length - 1);
    const read = validator.readWishFile(writeWish(doc));
    expect(read.kind).toBe('content');
  });

  test('a missing file reads as missing (a new wish being created)', () => {
    const read = validator.readWishFile(join(root, '.genie', 'wishes', 'fixture', 'WISH.md'));
    expect(read.kind).toBe('missing');
  });

  test('a stat failure other than ENOENT is a named refusal, not a skip', () => {
    const dir = join(root, '.genie', 'wishes', 'fixture');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'WISH.md');
    writeFileSync(path, templateDoc());
    const { chmodSync } = require('node:fs') as typeof import('node:fs');
    chmodSync(dir, 0o000);
    try {
      const read = validator.readWishFile(path);
      expect(read.kind).toBe('error');
      expect(read.reason).toContain('unable to stat wish file');
    } finally {
      chmodSync(dir, 0o755);
    }
  });
});

describe('corpus: every current genie wish passes', () => {
  test('validateWish exits 0 on 100% of the current genie corpus', () => {
    const wishesDir = join(REPO_ROOT, '.genie', 'wishes');
    const slugs = readdirSync(wishesDir).filter((slug) => existsSync(join(wishesDir, slug, 'WISH.md')));
    expect(slugs.length).toBeGreaterThan(30);
    for (const slug of slugs) {
      const content = readFileSync(join(wishesDir, slug, 'WISH.md'), 'utf8');
      const result = validator.validateWish(content);
      expect(result.issues, `${slug}: ${result.issues.map((issue) => issue.message).join('; ')}`).toEqual([]);
    }
  });
});

describe('CLI', () => {
  test('--file exits 0 on the template and prints the pass message', () => {
    const result = runCli(['--file', writeWish(templateDoc())]);
    expect(result.code).toBe(0);
    expect(result.stderr).toContain('validation passed');
  });

  test('--file exits 1 on a structurally broken doc', () => {
    const broken = templateDoc().replace(/^## Summary\s*$/m, '');
    const result = runCli(['--file', writeWish(broken)]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('## Summary');
  });

  test('--file exits 0 when the wish does not exist yet (new wish)', () => {
    const result = runCli(['--file', join(root, '.genie', 'wishes', 'fixture', 'WISH.md')]);
    expect(result.code).toBe(0);
    expect(result.stderr).toContain('skipping');
  });

  test('--file exits 1 on a symlinked wish', () => {
    const target = join(root, 'real-wish.md');
    writeFileSync(target, templateDoc());
    const link = writeWish('ignored');
    rmSync(link);
    symlinkSync(target, link);
    const result = runCli(['--file', link]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('symbolic link');
  });

  test('--help exits 0', () => {
    expect(runCli(['--help']).code).toBe(0);
  });

  test('non-wish paths pass silently', () => {
    const result = runCli(['--file', join(root, 'notes.md')]);
    expect(result.code).toBe(0);
  });

  test('PreToolUse Write exits 2 and names the violation when the proposed content is broken', () => {
    const path = writeWish(templateDoc());
    const broken = templateDoc().replace(/^## Scope\s*$/m, '');
    const result = runCli([], hookEvent('PreToolUse', { file_path: path, content: broken }));
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('## Scope');
  });

  test('PreToolUse Edit that fixes a broken doc is allowed', () => {
    const broken = templateDoc().replace(/^## Scope\s*$/m, '');
    const path = writeWish(broken);
    const result = runCli(
      [],
      hookEvent('PreToolUse', {
        file_path: path,
        old_string: '# Wish:',
        new_string: '## Scope\n\n### IN\n\n- fixed\n\n### OUT\n\n- fixed\n\n# Wish:',
      }),
    );
    expect(result.code).toBe(0);
  });

  test('PreToolUse on a new wish passes without a file on disk', () => {
    const path = join(root, '.genie', 'wishes', 'fixture', 'WISH.md');
    const result = runCli([], hookEvent('PreToolUse', { file_path: path, content: templateDoc() }));
    expect(result.code).toBe(0);
  });

  test('PostToolUse exits 2 with the violations on stderr (fed back to the agent)', () => {
    const path = writeWish(templateDoc().replace(/^## Decisions\s*$/m, ''));
    const result = runCli([], hookEvent('PostToolUse', { file_path: path }));
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('## Decisions');
  });

  test('hook-driven symlink refusal exits 2 while the --file symlink refusal keeps exit 1', () => {
    const target = join(root, 'real-wish.md');
    writeFileSync(target, templateDoc());
    const link = writeWish('ignored');
    rmSync(link);
    symlinkSync(target, link);
    expect(runCli([], hookEvent('PreToolUse', { file_path: link })).code).toBe(2);
    expect(runCli(['--file', link]).code).toBe(1);
  });
});
