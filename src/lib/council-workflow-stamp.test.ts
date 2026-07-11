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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const { stampCouncilWorkflow, inspectManagedWorkflow, resolveStampInputs, PLACEHOLDER, WORKFLOW_MANIFEST_NAME } =
  require('../../plugins/genie/scripts/council-stamp.cjs') as {
    stampCouncilWorkflow: (opts: {
      templatePath: string;
      pluginRoot: string;
      targetDir: string;
      version?: string | null;
      now?: () => Date;
    }) => {
      action: 'written' | 'skipped' | 'kept-unmanaged' | 'kept-modified' | 'metadata-corrupt';
      targetPath: string;
    };
    inspectManagedWorkflow: (targetDir: string) => {
      targetPath: string;
      manifestPath: string;
      state: 'unmanaged' | 'managed-clean' | 'managed-modified' | 'corrupt-metadata';
    };
    resolveStampInputs: (opts: { claudePluginRoot: string; genieHome: string; exists?: (p: string) => boolean }) => {
      pluginRoot: string;
      templatePath: string;
    };
    PLACEHOLDER: string;
    WORKFLOW_MANIFEST_NAME: string;
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
    const res = stampCouncilWorkflow({
      templatePath,
      pluginRoot,
      targetDir,
      version: '9.9.9',
      now: () => new Date('2026-07-11T12:00:00.000Z'),
    });

    expect(res.action).toBe('written');
    expect(res.targetPath).toBe(join(targetDir, 'council.js'));

    const out = readFileSync(res.targetPath, 'utf8');
    expect(out).toContain(`const LENS_ROOT = ${JSON.stringify(pluginRoot)};`);
    expect(out).not.toContain(PLACEHOLDER);
    expect(inspectManagedWorkflow(targetDir).state).toBe('managed-clean');
    expect(JSON.parse(readFileSync(join(targetDir, WORKFLOW_MANIFEST_NAME), 'utf8'))).toMatchObject({
      managedBy: 'genie-agent-sync',
      version: '9.9.9',
      syncedAt: '2026-07-11T12:00:00.000Z',
    });
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

  test('an exact inventory-missing legacy workflow remains byte-identical and unmanaged', () => {
    mkdirSync(targetDir, { recursive: true });
    const targetPath = join(targetDir, 'council.js');
    const personal = TEMPLATE_BODY.split(PLACEHOLDER).join('/abs/plugins/genie');
    writeFileSync(targetPath, personal, 'utf8');

    const result = stampCouncilWorkflow({ templatePath, pluginRoot: '/abs/plugins/genie', targetDir });

    expect(result.action).toBe('kept-unmanaged');
    expect(readFileSync(targetPath, 'utf8')).toBe(personal);
    expect(existsSync(join(targetDir, WORKFLOW_MANIFEST_NAME))).toBe(false);
    expect(existsSync(join(dirname(targetDir), '.genie-recovery', 'council-bootstrap'))).toBe(false);
    expect(inspectManagedWorkflow(targetDir).state).toBe('unmanaged');
  });

  test('a digest-owned workflow modified by the user is preserved byte-identically', () => {
    const targetPath = join(targetDir, 'council.js');
    stampCouncilWorkflow({ templatePath, pluginRoot: '/old/plugins/genie', targetDir });
    const modified = `${readFileSync(targetPath, 'utf8')}\n// personal edit\n`;
    writeFileSync(targetPath, modified, 'utf8');
    const sidecarBefore = readFileSync(join(targetDir, WORKFLOW_MANIFEST_NAME), 'utf8');

    const result = stampCouncilWorkflow({ templatePath, pluginRoot: '/new/plugins/genie', targetDir });

    expect(result.action).toBe('kept-modified');
    expect(readFileSync(targetPath, 'utf8')).toBe(modified);
    expect(readFileSync(join(targetDir, WORKFLOW_MANIFEST_NAME), 'utf8')).toBe(sidecarBefore);
    expect(inspectManagedWorkflow(targetDir).state).toBe('managed-modified');
  });

  test('corrupt ownership metadata fails closed without rewriting the target or sidecar', () => {
    const targetPath = join(targetDir, 'council.js');
    const sidecarPath = join(targetDir, WORKFLOW_MANIFEST_NAME);
    stampCouncilWorkflow({ templatePath, pluginRoot: '/old/plugins/genie', targetDir });
    const targetBefore = readFileSync(targetPath, 'utf8');
    writeFileSync(sidecarPath, '{broken', 'utf8');

    const result = stampCouncilWorkflow({ templatePath, pluginRoot: '/new/plugins/genie', targetDir });

    expect(result.action).toBe('metadata-corrupt');
    expect(readFileSync(targetPath, 'utf8')).toBe(targetBefore);
    expect(readFileSync(sidecarPath, 'utf8')).toBe('{broken');
    expect(inspectManagedWorkflow(targetDir).state).toBe('corrupt-metadata');
  });

  test('throws when a required path argument is missing', () => {
    // @ts-expect-error — intentionally omitting required args to prove the guard fires
    expect(() => stampCouncilWorkflow({ templatePath, pluginRoot: '/x' })).toThrow(/requires/);
  });
});

describe('resolveStampInputs (stable-root preference)', () => {
  const claudePluginRoot = '/home/user/.claude/plugins/genie';
  const genieHome = '/home/user/.genie';
  const stableRoot = join(genieHome, 'plugins', 'genie');
  const stableTemplate = join(stableRoot, 'workflows', 'council.js');

  test('prefers the stable ~/.genie/plugins/genie root when it carries the template', () => {
    const res = resolveStampInputs({
      claudePluginRoot,
      genieHome,
      exists: (p) => p === stableTemplate,
    });
    expect(res.pluginRoot).toBe(stableRoot);
    expect(res.templatePath).toBe(stableTemplate);
  });

  test('falls back to claudePluginRoot when the stable template is absent', () => {
    const res = resolveStampInputs({
      claudePluginRoot,
      genieHome,
      exists: () => false,
    });
    expect(res.pluginRoot).toBe(claudePluginRoot);
    expect(res.templatePath).toBe(join(claudePluginRoot, 'workflows', 'council.js'));
  });

  test('exists() is injectable — the preference probes the stable template path', () => {
    const probed: string[] = [];
    resolveStampInputs({
      claudePluginRoot,
      genieHome,
      exists: (p) => {
        probed.push(p);
        return false;
      },
    });
    expect(probed).toContain(stableTemplate);
  });
});
