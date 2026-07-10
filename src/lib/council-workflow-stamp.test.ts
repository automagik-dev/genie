/**
 * Tests for council-stamp.cjs: the install-time stamp that writes the /council
 * workflow template into ~/.claude/workflows with LENS_ROOT resolved.
 *
 * The implementation is CommonJS (it is required from the ESM SessionStart
 * hook), so we load it through createRequire. Everything runs inside a tmpdir;
 * afterEach removes it, so no global state is touched.
 *
 * Run with: bun test src/lib/council-workflow-stamp.test.ts
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { stampCouncilWorkflow, PLACEHOLDER } = require('../../plugins/genie/scripts/council-stamp.cjs') as {
  stampCouncilWorkflow: (opts: { templatePath: string; pluginRoot: string; targetDir: string }) => {
    action: 'written' | 'skipped';
    targetPath: string;
  };
  PLACEHOLDER: string;
};

const TEMPLATE_BODY = [
  "export const meta = { name: 'council' };",
  `const LENS_ROOT = '${PLACEHOLDER}';`,
  'export default async function council() {',
  '  log(LENS_ROOT);',
  '}',
  '',
].join('\n');

describe('stampCouncilWorkflow', () => {
  let dir: string;
  let templatePath: string;
  let targetDir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'council-stamp-'));
    templatePath = join(dir, 'council.template.js');
    targetDir = join(dir, 'nested', 'workflows'); // nested so we also prove mkdir recursive
    writeFileSync(templatePath, TEMPLATE_BODY, 'utf8');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('replaces the placeholder with the absolute plugin root and writes council.js', () => {
    const pluginRoot = '/opt/plugins/genie';
    const res = stampCouncilWorkflow({ templatePath, pluginRoot, targetDir });

    expect(res.action).toBe('written');
    expect(res.targetPath).toBe(join(targetDir, 'council.js'));

    const out = readFileSync(res.targetPath, 'utf8');
    expect(out).toContain(`const LENS_ROOT = '${pluginRoot}';`);
    expect(out).not.toContain(PLACEHOLDER);
  });

  test('target lands exactly at <targetDir>/council.js (creating parent dirs)', () => {
    expect(existsSync(targetDir)).toBe(false);
    const res = stampCouncilWorkflow({ templatePath, pluginRoot: '/abs/plugins/genie', targetDir });

    expect(res.targetPath).toBe(join(targetDir, 'council.js'));
    expect(existsSync(join(targetDir, 'council.js'))).toBe(true);
  });

  test('idempotent — an unchanged re-run skips the write', () => {
    const pluginRoot = '/abs/plugins/genie';
    expect(stampCouncilWorkflow({ templatePath, pluginRoot, targetDir }).action).toBe('written');
    expect(stampCouncilWorkflow({ templatePath, pluginRoot, targetDir }).action).toBe('skipped');
  });

  test('rewrites when the plugin root changes (update-safe re-stamp)', () => {
    stampCouncilWorkflow({ templatePath, pluginRoot: '/root/one/plugins/genie', targetDir });
    const changed = stampCouncilWorkflow({ templatePath, pluginRoot: '/root/two/plugins/genie', targetDir });

    expect(changed.action).toBe('written');
    const out = readFileSync(join(targetDir, 'council.js'), 'utf8');
    expect(out).toContain('/root/two/plugins/genie');
    expect(out).not.toContain('/root/one/plugins/genie');
  });

  test('rewrites when the template content changes (self-healing on plugin update)', () => {
    const pluginRoot = '/abs/plugins/genie';
    stampCouncilWorkflow({ templatePath, pluginRoot, targetDir });
    writeFileSync(templatePath, `${TEMPLATE_BODY}\n// updated template\n`, 'utf8');

    const res = stampCouncilWorkflow({ templatePath, pluginRoot, targetDir });
    expect(res.action).toBe('written');
    expect(readFileSync(res.targetPath, 'utf8')).toContain('// updated template');
  });

  test('throws when a required path argument is missing', () => {
    // @ts-expect-error — intentionally omitting required args to prove the guard fires
    expect(() => stampCouncilWorkflow({ templatePath, pluginRoot: '/x' })).toThrow(/requires/);
  });
});
