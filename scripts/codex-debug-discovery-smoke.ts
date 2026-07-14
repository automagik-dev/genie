#!/usr/bin/env bun

/**
 * C3 — parse REAL `codex debug prompt-input` output from an isolated CODEX_HOME
 * with the built plugin installed, and prove Codex loads owner-qualified Genie
 * skills (`genie:wish`, `genie:work`) while exposing NO Genie-managed bare
 * product names and NO managed source paths.
 *
 * Grounding (spike-verified against real codex 0.144.1): prompt-input returns a
 * JSON array of messages; the final message carries a `<skills_instructions>`
 * block whose `### Available skills` list has one line per provider:
 *
 *   - <provider>: <description> (file: <CODEX_HOME>/plugins/cache/automagik/genie/<version>/skills/<name>/SKILL.md)
 *
 * The negative assertion is STRUCTURAL, not a substring scan (A9): bare
 * canonical names like `wish`/`work` are common English words and appear in
 * prose, so we extract provider IDENTIFIERS from the catalog lines and assert
 * none EQUALS a bare canonical Genie skill name. "No managed source paths" stays
 * a substring check against the distinctive isolated GENIE_HOME path.
 *
 * If real codex in the isolated home surfaces zero genie providers, that is a
 * FINDING to fix (fail with a `codex plugin list --json` dump), never a reason
 * to mock.
 *
 * Why only 20 of 23 installed skills surface as `genie:*` providers (review
 * carryover): codex's implicit-invocation catalog lists ONLY skills that permit
 * implicit invocation. Three Genie skills (`dream`, `omni`, `wizard`) deliberately
 * declare `policy.allow_implicit_invocation: false` in `agents/openai.yaml` — they
 * are heavy orchestration/setup flows that must never auto-trigger. Their omission
 * is intended codex behavior driven by our own policy, NOT a payload/frontmatter
 * defect. We assert this EXACTLY: the loaded set equals the installed skills whose
 * openai.yaml does not opt out, so a real frontmatter/payload regression (an
 * implicit-invocation skill going missing) fails loudly.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  SmokeFailure,
  activePluginRoot,
  assertNoStaleTempHomes,
  buildCliOnce,
  fail,
  installGenieHome,
  linkRealCodex,
  readCodexGeniePlugin,
  runCli,
  runCodex,
  withIsolatedHome,
} from './codex-smoke-harness.ts';

interface PromptInputContent {
  text?: unknown;
}
interface PromptInputMessage {
  content?: unknown;
}

/** Concatenate every `input_text` payload; fail loudly on empty/garbled output (A9). */
function concatPromptInputText(raw: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    fail(`codex debug prompt-input did not return JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!Array.isArray(parsed) || parsed.length === 0) fail('codex debug prompt-input returned an empty message array');
  const parts: string[] = [];
  for (const message of parsed as PromptInputMessage[]) {
    const content = message.content;
    if (!Array.isArray(content)) continue;
    for (const chunk of content as PromptInputContent[]) {
      if (typeof chunk.text === 'string') parts.push(chunk.text);
    }
  }
  const text = parts.join('\n');
  if (text.trim() === '') fail('codex debug prompt-input carried no text content');
  return text;
}

/** Extract provider identifiers from the loaded-skills catalog (structural, not prose). */
function parseSkillProviders(promptText: string): string[] {
  const start = promptText.indexOf('<skills_instructions>');
  if (start < 0) fail('codex prompt-input has no <skills_instructions> catalog block');
  const end = promptText.indexOf('</skills_instructions>', start);
  const section = promptText.slice(start, end < 0 ? promptText.length : end);
  const providers: string[] = [];
  for (const line of section.split('\n')) {
    const match = /^- (.+?): /.exec(line.trim());
    if (match) providers.push(match[1]);
  }
  return providers;
}

function main(): void {
  try {
    assertNoStaleTempHomes();
    buildCliOnce();
    withIsolatedHome((iso) => {
      installGenieHome(iso);
      linkRealCodex(iso);
      const install = runCli(iso, ['install', '--integrations', 'codex']);
      if (install.exitCode !== 0)
        fail(`install --integrations codex failed: ${install.stderr.trim() || install.stdout.trim()}`);

      const version = readCodexGeniePlugin(iso).version;
      const canonicalNames = readdirSync(join(activePluginRoot(iso, version), 'skills'), { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
      if (canonicalNames.length === 0) fail('installed plugin exposes no skills to compare against');

      const promptInput = runCodex(iso, ['debug', 'prompt-input']);
      if (promptInput.exitCode !== 0 || promptInput.stdout.trim() === '') {
        const dump = runCodex(iso, ['plugin', 'list', '--json']);
        fail(
          `codex debug prompt-input failed (exit ${promptInput.exitCode}); plugin list: ${dump.stdout.trim().slice(0, 400)}`,
        );
      }
      const promptText = concatPromptInputText(promptInput.stdout);
      const providers = parseSkillProviders(promptText);
      const genieProviders = providers.filter((provider) => provider.startsWith('genie:'));

      // FINDING gate (F1/A9): zero genie providers means real codex did not load
      // the plugin — fix, do not mock.
      if (genieProviders.length === 0) {
        const dump = runCodex(iso, ['plugin', 'list', '--json']);
        fail(
          `real codex loaded NO genie:* providers from the isolated plugin — FINDING. Providers: [${providers.join(', ')}]; plugin list: ${dump.stdout.trim().slice(0, 400)}`,
        );
      }

      // Positive: owner-qualified genie:wish and genie:work are present.
      for (const required of ['genie:wish', 'genie:work']) {
        if (!genieProviders.includes(required)) {
          fail(`prompt-input catalog is missing ${required}; genie providers: [${genieProviders.join(', ')}]`);
        }
      }
      // Negative (structural): no provider identifier equals a bare canonical name.
      const bare = canonicalNames.filter((name) => providers.includes(name));
      if (bare.length > 0) {
        fail(`prompt-input catalog exposes Genie-managed BARE product providers: [${bare.join(', ')}]`);
      }
      // Negative (substring): no managed source path leaks into the catalog.
      const start = promptText.indexOf('<skills_instructions>');
      const section = promptText.slice(start);
      for (const forbidden of [iso.genieHome, join(iso.genieHome, 'plugins', 'genie')]) {
        if (section.includes(forbidden)) fail(`prompt-input catalog leaks a managed source path: ${forbidden}`);
      }

      // Exact-parity gate for the 20/23 catalog gap: prove the ONLY installed
      // skills codex omits are exactly those that opted out of implicit invocation
      // (`allow_implicit_invocation: false`), so the omission is intended policy —
      // not a payload/frontmatter defect. A regression that drops an
      // implicit-invocation skill (missing) or surfaces an opted-out one
      // (wronglyLoaded) fails here.
      const loadedCanonical = new Set(genieProviders.map((provider) => provider.slice('genie:'.length)));
      const phantom = [...loadedCanonical].filter((name) => !canonicalNames.includes(name));
      if (phantom.length > 0)
        fail(`genie:* providers with no installed skill (phantom catalog entry): [${phantom.join(', ')}]`);
      const skillsRoot = join(activePluginRoot(iso, version), 'skills');
      const implicitDenied = canonicalNames
        .filter((name) => {
          const yaml = join(skillsRoot, name, 'agents', 'openai.yaml');
          return existsSync(yaml) && /allow_implicit_invocation:\s*false/.test(readFileSync(yaml, 'utf8'));
        })
        .sort();
      const expectedLoaded = canonicalNames.filter((name) => !implicitDenied.includes(name));
      const missing = expectedLoaded.filter((name) => !loadedCanonical.has(name));
      if (missing.length > 0)
        fail(
          `implicit-invocation skills MISSING from the loaded catalog — payload/frontmatter defect, not policy: [${missing.join(', ')}]`,
        );
      const wronglyLoaded = [...loadedCanonical].filter((name) => implicitDenied.includes(name)).sort();
      if (wronglyLoaded.length > 0)
        fail(`skills that opted OUT of implicit invocation were surfaced anyway: [${wronglyLoaded.join(', ')}]`);

      console.log(
        `codex-debug-discovery-smoke: OK — real codex 0.144.1 loaded ${genieProviders.length}/${canonicalNames.length} genie:* providers (incl. genie:wish, genie:work); the ${implicitDenied.length} omitted (${implicitDenied.join(', ')}) are exactly the skills declaring allow_implicit_invocation:false — intended codex behavior, not a payload defect; zero bare product names, zero managed source paths`,
      );
    });
  } catch (error) {
    if (!(error instanceof SmokeFailure)) throw error;
    console.error(`codex-debug-discovery-smoke: FAIL — ${error.message}`);
    process.exit(1);
  }
}

if (import.meta.main) main();
