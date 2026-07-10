'use strict';

/**
 * council-stamp: stamp the /council workflow template into ~/.claude/workflows.
 *
 * Plugins cannot ship Claude Code workflows directly, so the template lives in
 * the plugin (plugins/genie/workflows/council.js) with a `__GENIE_LENS_ROOT__`
 * placeholder, and the SessionStart hook (smart-install.js) calls this on every
 * start to write the stamped file to ~/.claude/workflows/council.js.
 *
 * Pure and dependency-injectable: all paths are arguments, so the unit test can
 * drive it entirely inside a tmpdir. CommonJS (.cjs) so it is requireable from
 * the ESM smart-install.js via createRequire, and from bun:test.
 */

const fs = require('node:fs');
const path = require('node:path');

const PLACEHOLDER = '__GENIE_LENS_ROOT__';
const TARGET_NAME = 'council.js';

/**
 * Stamp the template's LENS_ROOT placeholder with the absolute plugin path and
 * write it to <targetDir>/council.js.
 *
 * Idempotent: the stamped bytes are a pure function of (template, pluginRoot),
 * so an unchanged template and an unchanged root produce output identical to
 * what is already on disk — in that case we skip the write. Any drift (template
 * updated, root changed, or the target hand-edited) makes the bytes differ and
 * we rewrite, which is also self-healing.
 *
 * @param {{templatePath: string, pluginRoot: string, targetDir: string}} opts
 * @returns {{action: 'written'|'skipped', targetPath: string}}
 */
function stampCouncilWorkflow({ templatePath, pluginRoot, targetDir } = {}) {
  if (!templatePath || !pluginRoot || !targetDir) {
    throw new Error('stampCouncilWorkflow requires templatePath, pluginRoot, and targetDir');
  }

  const template = fs.readFileSync(templatePath, 'utf8');
  const stamped = template.split(PLACEHOLDER).join(pluginRoot);
  const targetPath = path.join(targetDir, TARGET_NAME);

  if (fs.existsSync(targetPath) && fs.readFileSync(targetPath, 'utf8') === stamped) {
    return { action: 'skipped', targetPath };
  }

  fs.mkdirSync(targetDir, { recursive: true });
  fs.writeFileSync(targetPath, stamped, 'utf8');
  return { action: 'written', targetPath };
}

/**
 * Resolve which plugin root to stamp from. Prefers the STABLE canonical source
 * `<genieHome>/plugins/genie` whenever it actually carries the workflow template
 * (`workflows/council.js`), because that path never changes across plugin
 * versions — using it kills the stale-cache downgrade ping-pong where the
 * marketplace `CLAUDE_PLUGIN_ROOT` (which changes on every plugin update) stamps
 * an older-then-newer LENS_ROOT. Falls back to `claudePluginRoot` when the
 * stable template is absent (plugin-only machines with no genie CLI install).
 *
 * `exists` is injectable (default fs.existsSync) so the preference logic is
 * unit-testable without touching the real filesystem.
 *
 * @param {{claudePluginRoot: string, genieHome: string, exists?: (p: string) => boolean}} opts
 * @returns {{pluginRoot: string, templatePath: string}}
 */
function resolveStampInputs({ claudePluginRoot, genieHome, exists = fs.existsSync } = {}) {
  const stableRoot = path.join(genieHome, 'plugins', 'genie');
  const stableTemplate = path.join(stableRoot, 'workflows', TARGET_NAME);
  if (exists(stableTemplate)) {
    return { pluginRoot: stableRoot, templatePath: stableTemplate };
  }
  return {
    pluginRoot: claudePluginRoot,
    templatePath: path.join(claudePluginRoot, 'workflows', TARGET_NAME),
  };
}

module.exports = { stampCouncilWorkflow, resolveStampInputs, PLACEHOLDER, TARGET_NAME };
