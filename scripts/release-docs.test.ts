import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { CLAUDE_ROLE_AGENT_FILES, CODEX_ROLE_PROFILE_FILES } from './fresh-install-smoke.ts';

const ROOT = join(import.meta.dir, '..');

function read(relativePath: string): string {
  return readFileSync(join(ROOT, relativePath), 'utf8');
}

interface ReviewerProfile {
  approval_policy?: unknown;
  default_permissions?: unknown;
  sandbox_mode?: unknown;
  sandbox_workspace_write?: unknown;
  permissions?: Record<string, unknown>;
}

function reviewerPermissionViolations(profile: ReviewerProfile): string[] {
  const violations: string[] = [];
  if (profile.approval_policy !== 'never') violations.push('approval policy must be never');
  if (profile.default_permissions !== ':read-only') violations.push('built-in read-only permissions must be selected');
  if (profile.sandbox_mode !== undefined) violations.push('legacy sandbox mode must not override the named profile');
  if (profile.sandbox_workspace_write !== undefined) violations.push('legacy workspace-write grants are forbidden');
  if (Object.keys(profile.permissions ?? {}).length > 0)
    violations.push('custom writable permission profiles are forbidden');
  return violations;
}

function buildHelperInputs(): string[] {
  const pending = [...read('scripts/build-binary.sh').matchAll(/scripts\/([a-z0-9-]+\.[jt]s)/g)].map(
    (match) => `scripts/${match[1]}`,
  );
  const found = new Set<string>();
  while (pending.length > 0) {
    const relativePath = pending.shift();
    if (!relativePath || found.has(relativePath)) continue;
    found.add(relativePath);
    for (const match of read(relativePath).matchAll(/from ['"]\.\/([a-z0-9-]+\.[jt]s)['"]/g)) {
      pending.push(`scripts/${match[1]}`);
    }
  }
  return [...found].sort();
}

describe('Group E release and documentation contracts', () => {
  test('auto-version never executes dev-controlled code or accepts manual mutation', () => {
    const workflow = read('.github/workflows/version.yml');
    expect(workflow).not.toContain('workflow_dispatch:');
    expect(workflow).toContain('persist-credentials: false');
    for (const forbidden of [
      'bun install',
      'bun run version',
      'bunx ',
      'bun --print',
      'token: ${{ secrets.GITHUB_TOKEN }}',
    ]) {
      expect(workflow).not.toContain(forbidden);
    }
    for (const path of [
      'package.json',
      'plugins/genie/.claude-plugin/plugin.json',
      'plugins/genie/.codex-plugin/plugin.json',
      'plugins/genie/package.json',
      '.claude-plugin/marketplace.json',
      'plugins/hermes-genie/plugin.yaml',
    ]) {
      expect(workflow).toContain(path);
    }
    expect(workflow).toContain('git diff --cached --name-only');
    expect(workflow).toContain('git commit --no-verify');
    expect(workflow).toContain('git push --atomic origin "HEAD:refs/heads/dev"');
    expect(workflow).toContain('gh workflow run ci.yml --repo "${GITHUB_REPOSITORY}" --ref "v${VERSION}"');
    expect(workflow).not.toContain('gh workflow run ci.yml --repo "${GITHUB_REPOSITORY}" --ref dev');
    expect(workflow.indexOf('GH_TOKEN: ${{ github.token }}')).toBeGreaterThan(
      workflow.indexOf('git commit --no-verify'),
    );
    expect(read('.github/workflows/ci.yml')).toContain('workflow_dispatch:');
  });

  test('privileged reusable workflows admit only the exact channel-specific main caller', () => {
    for (const path of ['.github/workflows/sign-attest.yml', '.github/workflows/release-publish.yml']) {
      const workflow = read(path);
      expect(workflow).toContain('permissions: {}');
      expect(workflow).toContain(
        'EXPECTED_STABLE_CALLER: automagik-dev/genie/.github/workflows/release.yml@refs/heads/main',
      );
      expect(workflow).toContain(
        'EXPECTED_AUTOMATED_CALLER: automagik-dev/genie/.github/workflows/version.yml@refs/heads/main',
      );
      expect(workflow).toContain('EXPECTED_EVENT=workflow_dispatch');
      expect(workflow).toContain('EXPECTED_EVENT=workflow_run');
      expect(workflow).toContain('"$CALLER_REF" != refs/heads/main');
      expect(workflow).toContain('"$CALLER_WORKFLOW_REF" != "$EXPECTED_CALLER"');
      expect(workflow).toContain('"$CALLER_WORKFLOW_SHA" != "$CALLER_SHA"');
      expect(workflow).toContain('needs: admit');
    }
  });

  test('release stages consume only artifacts from their current orchestrator run', () => {
    for (const path of ['.github/workflows/sign-attest.yml', '.github/workflows/release-publish.yml']) {
      const workflow = read(path);
      expect(workflow).toContain('actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093');
      for (const crossRunInput of ['github-token:', 'run-id:', 'steps.runid', 'steps.src.outputs.run_id']) {
        expect(workflow).not.toContain(crossRunInput);
      }
    }
    expect(read('.github/workflows/sign-attest.yml')).toContain('pattern: genie-*-tarball');
    expect(read('.github/workflows/release-publish.yml')).toContain('pattern: genie-*-signed');

    const publishCall = read('.github/workflows/release.yml').split('\n  publish:')[1]?.split('\n    with:')[0];
    expect(publishCall).toBeDefined();
    expect(publishCall).not.toContain('actions: read');
  });

  test('release attestations bind the built source and trusted control identities', () => {
    const release = read('.github/workflows/release.yml');
    const signing = read('.github/workflows/sign-attest.yml');
    for (const input of ['channel', 'source_sha', 'source_branch', 'source_ci_run_id']) {
      expect(release).toContain(`${input}: \${{ inputs.${input} }}`);
      expect(signing).toContain(`--build-workflow-input "${input}=\${${input.toUpperCase()}}"`);
    }
    expect(signing).not.toContain('actions/attest-build-provenance@');
    expect(signing).toContain('actions/attest@67422f5511b7ff725f4dbd6fb9bd2cd925c65a8d');
    expect(signing).toContain('bash scripts/release-native-predicate.sh create');
    expect(signing).toContain('bash scripts/release-native-predicate.sh verify');
    expect(signing).toContain('bash scripts/release-generic-provenance.sh verify-exact');
    expect(signing).toContain('if [[ "$CHANNEL" == "stable" ]]');
    expect(read('scripts/release-generic-provenance.sh')).toContain(
      "AUTOMATED_ENTRY_POINT='.github/workflows/version.yml'",
    );
    expect(read('scripts/release-generic-provenance.sh')).toContain('workflow_run');
    expect(signing).toContain('--source-digest "$CONTROL_SHA"');
    // gh's flag group [cert-identity cert-identity-regex signer-repo
    // signer-workflow] is mutually exclusive; --cert-identity is the pinned
    // identity, so --signer-workflow must never reappear beside it (observed
    // 2026-07-20: the combination hard-fails gh attestation verify).
    expect(signing).not.toContain('--signer-workflow');
  });

  test('stable approval is explicit while dev and homolog remain automated', () => {
    const release = read('.github/workflows/release.yml');
    const version = read('.github/workflows/version.yml');
    const manualInputs = release.split('workflow_dispatch:')[1]?.split('workflow_call:')[0] ?? '';
    const manualChannel = manualInputs.split('channel:')[1]?.split('source_sha:')[0] ?? '';
    expect(release).toContain('workflow_call:');
    expect(manualChannel).toContain('- stable');
    expect(manualChannel).not.toContain('- homolog');
    expect(manualChannel).not.toContain('- dev');
    expect(release).toContain('CALLER_WORKFLOW_REF: ${{ github.workflow_ref }}');
    expect(release).toContain('CALLER_WORKFLOW_SHA: ${{ github.workflow_sha }}');
    expect(release).toContain('group: release-${{ inputs.version }}');
    expect(release).toContain('queue: max');
    expect(release).toContain('cancel-in-progress: false');
    expect(release).toContain('approve-stable:');
    expect(release).toContain("if: inputs.channel == 'stable'");
    expect(release).toContain('name: production');
    expect(release).toContain('needs: [guard, approve-stable]');
    expect(release).toContain("(inputs.channel != 'stable' || needs.approve-stable.result == 'success')");
    expect(release).not.toContain("&& 'production' || ''");
    expect(release).toContain('DISPATCH_ACTOR: ${{ github.actor }}');
    expect(release).toContain('TRIGGERING_ACTOR: ${{ github.triggering_actor }}');
    expect(release).toContain('RUN_ATTEMPT: ${{ github.run_attempt }}');

    expect(version).toContain('release-trigger.stable_manual_approval_required');
    expect(version).toContain("steps.context.outputs.branch == 'main'");
    expect(version).toContain('uses: ./.github/workflows/release.yml');
    expect(version).toContain("if: needs.auto-version.outputs.release_ready == 'true'");
    expect(version).toContain('channel: ${{ needs.auto-version.outputs.channel }}');
    expect(version).not.toContain('gh workflow run release.yml');
    expect(version).not.toContain('CHANNEL="stable"');
    expect(version).not.toContain('--field channel=stable');

    for (const path of ['.github/workflows/ci.yml', '.github/workflows/version.yml']) {
      expect(read(path)).toContain('branches: [main, homolog, dev]');
    }
    expect(read('.github/workflows/version.yml')).toContain(
      "!contains(github.event.workflow_run.head_commit.message, '[release-manifest]')",
    );
  });

  test('promotion and tag equivalence exclude only generated channel manifests', () => {
    for (const path of ['.github/workflows/version.yml', 'scripts/release-guard.sh']) {
      const source = read(path);
      expect(source).not.toContain("':(exclude).well-known'");
      for (const manifest of ['latest.json', 'homolog.json', 'dev.json']) {
        expect(source).toContain(`':(exclude).well-known/${manifest}'`);
      }
    }
  });

  test('docs and commit lint use immutable actions and locked local tools', () => {
    const commitlint = read('.github/workflows/commitlint.yml');
    expect(commitlint).not.toContain('wagoid/commitlint-github-action');
    expect(commitlint).toContain('bun install --frozen-lockfile --ignore-scripts');
    expect(commitlint).toContain('bun x --no-install commitlint');
    expect(commitlint).toContain('git cat-file -e "${BASE_SHA}^{commit}"');
    const docs = read('.github/workflows/docs-lint.yml');
    expect(docs).toContain('oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6');
    expect(docs).toContain('bun install --frozen-lockfile --ignore-scripts');
    expect(docs).not.toContain('bunx ');
    const pkg = JSON.parse(read('package.json')) as { devDependencies: Record<string, string> };
    expect(pkg.devDependencies['@commitlint/cli']).toBeDefined();
    expect(pkg.devDependencies['@commitlint/config-conventional']).toBeDefined();
    expect(pkg.devDependencies['markdownlint-cli2']).toBe('0.23.0');
    expect(pkg.devDependencies['markdown-link-check']).toBe('3.14.2');
  });

  test('secret-bearing CI never delegates to a mutable container tag', () => {
    const workflow = read('.github/workflows/ci.yml');
    const action = read('.github/actions/ggshield/action.yml');
    expect(workflow).toContain('uses: ./.github/actions/ggshield');
    expect(workflow).not.toContain('GitGuardian/ggshield-action@');
    expect(action).toContain(
      'docker://gitguardian/ggshield@sha256:11057725f4a47b587735351b69b1873435bf393050f946916ef05b1b0c4b1cf4',
    );
    expect(action).not.toMatch(/image:\s*docker:\/\/[^\s@]+:[^\s]+/);
  });

  test('every workflow pins its top-level token permissions in repository code', () => {
    for (const name of readdirSync(join(ROOT, '.github/workflows')).filter((entry) => entry.endsWith('.yml'))) {
      expect(read(`.github/workflows/${name}`), name).toMatch(/^permissions:(?:\s*\{\}|\n)/m);
    }
  });

  test('Node setup is immutable in every workflow, including the signed release build', () => {
    const pin = 'actions/setup-node@a0853c24544627f65ddf259abe73b1d18a591444';
    for (const path of [
      '.github/workflows/audit-next-tag.yml',
      '.github/workflows/build-tarballs.yml',
      '.github/workflows/ci.yml',
    ]) {
      expect(read(path)).toContain(pin);
      expect(read(path)).not.toMatch(/actions\/setup-node@(?![a-f0-9]{40}\b)/);
    }
  });

  test('every remote workflow dependency is commit-pinned except the required exact SLSA builder tag', () => {
    const slsaTagException =
      'slsa-framework/slsa-github-generator/.github/workflows/generator_generic_slsa3.yml@v2.1.0';
    for (const name of readdirSync(join(ROOT, '.github/workflows')).filter((entry) => entry.endsWith('.yml'))) {
      const workflow = read(`.github/workflows/${name}`);
      for (const match of workflow.matchAll(/^\s*(?:-\s*)?uses:\s*([^\s#]+)/gm)) {
        const reference = match[1];
        if (reference.startsWith('./') || reference === slsaTagException) continue;
        expect(reference, `${name}: ${reference}`).toMatch(/@[a-f0-9]{40}$/);
      }
    }
  });

  test('Build Tarballs PR filter covers every release-payload input class', () => {
    const workflow = read('.github/workflows/build-tarballs.yml');
    for (const path of [
      "'src/**'",
      "'skills/**'",
      "'templates/**'",
      "'plugins/**'",
      "'package.json'",
      "'LICENSE'",
      "'bun.lock'",
      "'bunfig.toml'",
      "'tsconfig.json'",
      "'scripts/build-binary.sh'",
      "'scripts/build.js'",
      "'scripts/json-top-level-string.js'",
      "'scripts/hook-bundle-parity.ts'",
      "'scripts/hook-content-binding.ts'",
      "'scripts/plugin-executables-check.ts'",
      "'scripts/sync-plugin-skills.ts'",
      "'scripts/fresh-install-smoke.ts'",
      "'scripts/skills-lint.ts'",
      "'scripts/release-payload-version.ts'",
      "'.agents/plugins/marketplace.json'",
      "'.claude-plugin/marketplace.json'",
      "'.github/workflows/build-tarballs.yml'",
    ]) {
      expect(workflow).toContain(`- ${path}`);
    }
    expect(workflow).toContain('skills/<name>/SKILL.md');
    expect(workflow).toContain('agents/openai.yaml');
    expect(buildHelperInputs()).toContain('scripts/skills-lint.ts');
    for (const helper of buildHelperInputs()) expect(workflow).toContain(`- '${helper}'`);
  });

  test('every native release-binary smoke proves the hidden installer transaction syscall', () => {
    const workflow = read('.github/workflows/build-tarballs.yml');
    expect(workflow.match(/__install-promote --self-test/g)).toHaveLength(3);
    expect(workflow).toContain('"${STAGE}/genie" __install-promote --self-test');
    expect(workflow).toContain('/app/genie __install-promote --self-test');
    expect(read('src/genie.ts')).toContain(".command('__install-promote', { hidden: true })");
  });

  test('release create and promotion paths retain the one-time convergence caveat', () => {
    const workflow = read('.github/workflows/release-publish.yml');
    const helper = read('scripts/reconcile-release-note.sh');
    const prepare = workflow.indexOf('bash scripts/reconcile-release-note.sh prepare');
    const firstAssets = workflow.indexOf('bash scripts/reconcile-release-assets.sh');
    const finalize = workflow.indexOf('bash scripts/reconcile-release-note.sh finalize');
    const locked = workflow.indexOf('bash scripts/release-immutability.sh release');
    const lockedAssets = workflow.lastIndexOf('bash scripts/reconcile-release-assets.sh');
    expect(prepare).toBeGreaterThan(-1);
    expect(firstAssets).toBeGreaterThan(prepare);
    expect(finalize).toBeGreaterThan(firstAssets);
    expect(locked).toBeGreaterThan(finalize);
    expect(lockedAssets).toBeGreaterThan(locked);
    expect(workflow).not.toContain('release-immutability.sh repository');
    expect(workflow).not.toContain('/immutable-releases');
    expect(workflow).not.toContain('--clobber');
    expect(workflow).toContain('name: release-manifests');
    expect(workflow).toContain('ssh-key: ${{ secrets.RELEASE_MANIFESTS_DEPLOY_KEY }}');
    expect(workflow).toContain('[release-manifest]');
    expect(workflow).toContain('cp scripts/reconcile-channel-manifests.sh "$MANIFEST_RECONCILER"');
    expect(workflow).toContain('bash "$MANIFEST_RECONCILER"');
    expect(workflow).toContain('for attempt in 1 2 3 4 5; do');
    expect(workflow).toContain('git push origin "HEAD:refs/heads/main"');
    expect(helper).toContain('genie-agent-sync-migration-v1');
    expect(helper).toContain('older than `5.260711.6`');
    expect(helper).toContain('create_args=(release create');
    expect(helper).toContain('gh release edit');
  });

  test('channel documentation does not claim unsigned manifests are signed or use GitHub latest as authority', () => {
    for (const path of ['README.md', 'SECURITY.md']) {
      const source = read(path);
      expect(source).not.toContain('signed `.well-known');
      expect(source).toContain('repository-hosted `.well-known');
      expect(source).toContain("GitHub's `/releases/latest`");
    }
  });

  test('immutable-release bootstrap ordering remains explicit and fail-closed', () => {
    const security = read('SECURITY.md');
    expect(security).toContain('drain every Version and Release run started under the old `main` workflows');
    expect(security).toContain('before enabling repository immutability');
    expect(security).toContain('before the separately approved merge to `main`');
    expect(security).toContain('must fail closed and must not advance a channel manifest');
    expect(security).toContain('freshly built and published by the merged draft-first release control');
  });

  test('operator verification docs name only the shipped bundle/provenance verifier', () => {
    for (const path of ['SECURITY.md', '.github/ISSUE_TEMPLATE/signing-key-fingerprint.md']) {
      const source = read(path);
      expect(source).toContain('scripts/verify-release.sh');
      expect(source).toContain('.tar.gz.bundle');
      expect(source).toContain('.tar.gz.intoto.jsonl');
      expect(source).not.toContain('genie sec verify-install');
      expect(source).not.toContain('.tgz.sig');
      expect(source).not.toContain('.tgz.cert');
      expect(source).not.toContain('provenance.intoto.jsonl');
    }
    expect(read('scripts/verify-release.sh')).not.toContain('genie sec verify-install');
    for (const path of ['.well-known/security.txt', '.github/cosign.pub']) {
      expect(read(path)).not.toContain('genie sec verify-install');
    }
    const issueTemplate = read('.github/ISSUE_TEMPLATE/signing-key-fingerprint.md');
    expect(issueTemplate).toContain('privacidade@namastex.ai');
    expect(issueTemplate).not.toContain('security@namastex.com');
    expect(read('SECURITY.md')).toContain('six required in-repo witnesses');
    expect(read('scripts/check-fingerprint-pinning.sh')).not.toContain('all four witnesses');
  });

  test('release packaging validates generated hooks and the extracted archive payload', () => {
    const build = read('scripts/build-binary.sh');
    expect(build).toContain('scripts/hook-bundle-parity.ts');
    expect(build).toContain('scripts/hook-content-binding.ts');
    const archive = build.indexOf('tar czf "${TARBALL}"');
    const extract = build.indexOf('tar -xzf "${TARBALL}"');
    const postExtractSmoke = build.lastIndexOf('scripts/fresh-install-smoke.ts');
    const postExtractVersion = build.lastIndexOf('scripts/release-payload-version.ts');
    expect(archive).toBeGreaterThan(-1);
    expect(extract).toBeGreaterThan(archive);
    expect(build).toContain('assert_release_tree_equal "${STAGE}" "${VERIFY_ROOT}"');
    expect(build).toContain('cmp -- "${expected_entry}" "${actual_entry}"');
    expect(build).toContain('cp "${REPO_ROOT}/LICENSE"');
    expect(build).toContain("-iname '*.test.*'");
    expect(build).toContain("-iname 'test_*.*'");
    expect(build).toContain("-iname '*_test.*'");
    expect(build).toContain("-iname 'spec_*.*'");
    expect(build).toContain("-iname '*_spec.*'");
    expect(build).toContain('assert_no_release_tests "${STAGE}"');
    expect(build).toContain('assert_no_release_tests "${VERIFY_ROOT}"');
    expect(build).toContain('! -type f ! -type d');
    expect(build).toContain('find "${expected_root}" -mindepth 1');
    expect(postExtractSmoke).toBeGreaterThan(extract);
    expect(postExtractVersion).toBeGreaterThan(extract);

    const rootPackage = JSON.parse(read('package.json')) as { license?: unknown };
    const pluginPackage = JSON.parse(read('plugins/genie/package.json')) as { license?: unknown };
    expect(rootPackage.license).toBe('MIT');
    expect(pluginPackage.license).toBe('MIT');
  });

  test('committed CI reproduces the council and generated-hook parts of the local gate', () => {
    const workflow = read('.github/workflows/ci.yml');
    const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
    expect(pkg.scripts.check).toContain('bun run lint:complexity-budget');
    expect(pkg.scripts['check:fast']).toContain('bun run lint:complexity-budget');
    expect(workflow).toContain('bun run lint:complexity-budget');
    expect(workflow).toContain('bun run lint:council-workflow');
    expect(workflow).toContain('bun run lint:hook-bundles');
    expect(workflow).toContain('bun run lint:hook-content');
    expect(workflow).toContain('bun run lint:plugin-executables');
    expect(pkg.scripts.check).toContain('bun run lint:hook-content');
    expect(pkg.scripts['check:fast']).toContain('bun run lint:hook-content');
    expect(pkg.scripts.check).toContain('bun run lint:plugin-executables');
    expect(pkg.scripts['check:fast']).toContain('bun run lint:plugin-executables');
    const executableGate = read('scripts/plugin-executables-check.ts');
    expect(executableGate).toContain("'--strict'");
    expect(read('scripts/plugin-executables-check.test.ts')).toContain('error TS7006');
  });

  test('release gates pin exact Codex and Claude role inventories through archive extraction', () => {
    expect(CODEX_ROLE_PROFILE_FILES).toEqual([
      'genie-engineer-complex.toml',
      'genie-engineer-standard.toml',
      'genie-engineer-trivial.toml',
      'genie-final-gate.toml',
      'genie-fixer.toml',
      'genie-reviewer.toml',
      'genie-scout.toml',
    ]);
    expect(CLAUDE_ROLE_AGENT_FILES).toEqual([
      'engineer-complex.md',
      'engineer-standard.md',
      'engineer-trivial.md',
      'final-gate.md',
      'fixer.md',
      'reviewer.md',
      'scout.md',
    ]);

    const smoke = read('scripts/fresh-install-smoke.ts');
    for (const file of [...CODEX_ROLE_PROFILE_FILES, ...CLAUDE_ROLE_AGENT_FILES]) expect(smoke).toContain(`'${file}'`);
    expect(smoke).toContain('checkRoleInventories(pluginRoot)');

    const build = read('scripts/build-binary.sh');
    expect(build.match(/scripts\/fresh-install-smoke\.ts/g)?.length).toBe(3);
    const sourceSmoke = build.indexOf('bun "${REPO_ROOT}/scripts/fresh-install-smoke.ts"');
    const stageSmoke = build.indexOf('--skills-dir "${STAGE}/skills"');
    const extract = build.indexOf('tar -xzf "${TARBALL}"');
    const archiveSmoke = build.indexOf('--skills-dir "${VERIFY_ROOT}/skills"');
    expect(sourceSmoke).toBeGreaterThan(-1);
    expect(stageSmoke).toBeGreaterThan(sourceSmoke);
    expect(archiveSmoke).toBeGreaterThan(extract);
  });

  test('resurrected metrics bot and incompatible generated state stay retired', () => {
    expect(read('README.md')).not.toContain('<!-- METRICS:START -->');
    for (const file of ['AGENT.md', 'runs.jsonl', 'state.json']) {
      expect(existsSync(join(ROOT, '.genie/agents/metrics-updater', file))).toBe(false);
    }
  });

  test('reviewer permission profile remains read-only even for temporary-hosted worktrees', () => {
    const profile = Bun.TOML.parse(read('plugins/genie/codex-agents/genie-reviewer.toml')) as ReviewerProfile;
    expect(reviewerPermissionViolations(profile)).toEqual([]);

    expect(reviewerPermissionViolations({ ...profile, permissions: { unsafe: {} } })).toContain(
      'custom writable permission profiles are forbidden',
    );
    expect(reviewerPermissionViolations({ ...profile, default_permissions: 'genie-reviewer-temp' })).toContain(
      'built-in read-only permissions must be selected',
    );
    expect(reviewerPermissionViolations({ ...profile, sandbox_mode: 'workspace-write' })).toContain(
      'legacy sandbox mode must not override the named profile',
    );
    expect(
      reviewerPermissionViolations({ ...profile, sandbox_workspace_write: { writable_roots: ['/repo'] } }),
    ).toContain('legacy workspace-write grants are forbidden');
  });

  test('README and contributor command inventories match the 14-command source surface', () => {
    const expected = [
      'board',
      'doctor',
      'help',
      'hook',
      'init',
      'install',
      'launch',
      'mcp',
      'omni',
      'setup',
      'shortcuts',
      'task',
      'uninstall',
      'update',
    ];
    const readme = read('README.md');
    const contributor = read('CLAUDE.md');
    expect(readme).toContain('14 CLI commands');
    expect(contributor).toContain('Fourteen top-level commands');
    const readmeCommands = [...readme.matchAll(/^\| `genie ([a-z-]+)/gm)].map((match) => match[1]).sort();
    const contributorCommands = [...contributor.matchAll(/^\| `([a-z-]+)/gm)].map((match) => match[1]).sort();
    expect(readmeCommands).toEqual(expected);
    expect(contributorCommands).toEqual(expected);
  });

  test('operator docs distinguish product, role-agent, personal, MCP, and hook inventories', () => {
    const docs = `${read('README.md')}\n${read('plugins/genie/README.md')}`;
    expect(read('README.md')).toContain('These five inventories are intentionally separate');
    for (const statement of [
      '23 physical',
      'Seven optional',
      '36 adapted skills',
      'mcp-launcher.cjs',
      'H3',
      'H4',
      'H6',
      '/hooks',
      'start a new task',
    ]) {
      expect(docs).toContain(statement);
    }
    // Plugin-only contract: the installed plugin is the sole Genie-managed skill provider.
    expect(read('README.md')).toContain('the installed plugin is the **only** Genie-managed skill provider');
    expect(read('README.md')).toContain('Fallback retirement');
    expect(read('plugins/genie/README.md')).toContain('the only Genie-managed skill provider');
    // The retired CLI-managed-fallback promise must be gone from operator docs.
    expect(docs).not.toContain('synchronizes up to 23 digest-managed product-skill fallbacks');
    expect(docs).not.toContain('CLI-managed product skills');
    expect(docs).not.toContain('CLI-managed product fallbacks');
    expect(docs).toContain('at most 64 candidate');
    expect(docs).toContain('network-free');
    expect(docs).toContain('no Codex network lookup');
  });

  test('manual docs use explicit tiers while all physical skill cards remain selector-free', () => {
    const docs = `${read('README.md')}\n${read('plugins/genie/README.md')}\n${read('skills/README.md')}`;
    for (const skill of ['brainstorm', 'wish', 'review', 'work']) {
      expect(docs).toContain(`$genie:${skill}`);
    }
    expect(docs).toContain('separately installed personal');
    const manifest = read('plugins/genie/.codex-plugin/plugin.json');
    for (const skill of ['wish', 'work', 'review']) expect(manifest).toContain(`$genie:${skill}`);

    const skillNames = readdirSync(join(ROOT, 'skills'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && existsSync(join(ROOT, 'skills', entry.name, 'agents', 'openai.yaml')))
      .map((entry) => entry.name)
      .sort();
    expect(skillNames).toHaveLength(23);
    for (const name of skillNames) {
      const parsed = Bun.YAML.parse(read(`skills/${name}/agents/openai.yaml`)) as {
        interface?: { default_prompt?: unknown };
      };
      expect(parsed.interface?.default_prompt).toBeString();
      expect(parsed.interface?.default_prompt).not.toMatch(/\$(?:[a-z0-9][a-z0-9-]*:)?[a-z0-9][a-z0-9-]*/i);
    }

    const skillsOverview = read('skills/README.md');
    expect(skillsOverview).toContain(
      'Codex user tier (only a separately installed personal copy; Genie no longer seeds this tier)',
    );
    expect(skillsOverview).not.toContain('CLI-managed product fallback');
    expect(skillsOverview).toContain('persists Codex maintenance consent');
    expect(skillsOverview).toContain('later explicit `genie update`');
  });

  test('lifecycle and operator docs name design, plan, and implementation review as distinct mandatory gates', () => {
    const lifecycle = read('skills/genie/reference/lifecycle.md');
    const plugin = read('plugins/genie/README.md');
    const root = read('README.md');
    for (const term of ['design review', 'plan review', 'implementation review']) {
      expect(lifecycle).toContain(term);
      expect(plugin).toContain(term);
      expect(root).toContain(term);
    }
    expect(lifecycle).toContain('automatically routes the completed DESIGN.md');
    expect(plugin).toContain('successful `genie setup --codex` persists Codex maintenance consent');
    expect(root).toContain('successful Codex setup also persists Codex maintenance consent');
    // Consent no longer authorizes CLI-managed user-tier fallbacks; it refreshes only plugin surfaces.
    expect(plugin).toContain('No supported path writes new product');
    expect(root).toContain('never writes new product skills into the user tier');
    expect(plugin).not.toContain('digest-managed product-skill');
    expect(root).not.toContain('digest-managed product-skill fallbacks');
  });

  test('lifecycle skills share persisted WISH state and keep reviewers read-only', () => {
    const lifecycle = read('skills/genie/reference/lifecycle.md');
    for (const status of ['`DRAFT`', '`FIX-FIRST`', '`APPROVED`', '`IN_PROGRESS`', '`BLOCKED`', '`SHIPPED`']) {
      expect(lifecycle).toContain(status);
    }
    const brainstorm = read('skills/brainstorm/SKILL.md');
    const review = read('skills/review/SKILL.md');
    const dream = read('skills/dream/SKILL.md');
    const wish = read('skills/wish/templates/wish-template.md');
    const pm = read('skills/pm/SKILL.md');
    expect(dream).toContain('Status field is exactly `APPROVED`');
    expect(brainstorm).toContain('Do not move it to Poured before a WISH.md exists');
    expect(brainstorm).toContain('single brainstorm/planning index is `.genie/INDEX.md`');
    expect(brainstorm).toContain('Legacy migration is idempotent');
    expect(review).toContain('### Design Review (after `brainstorm`)');
    expect(review).toContain('The reviewer is read-only');
    expect(wish).toContain('## Dependencies');
    expect(wish).toContain('**depends-on:** none');
    expect(dream).toContain('wish-level `**depends-on:**`');
    expect(dream).not.toContain('depends_on');
    expect(pm).toContain('Explicit task-scoped grant');
    expect(pm).toMatch(/Selecting Autopilot\s+does not itself authorize external repository writes/);
  });

  test('parallel execution uses isolated group lanes and garbage-collects only verified merged work', () => {
    const agents = read('AGENTS.md');
    const work = read('skills/work/SKILL.md');
    const pm = read('skills/pm/SKILL.md');
    const review = read('skills/review/SKILL.md');
    const dispatch = read('plugins/genie/references/dispatch-contract.md');
    const launch = read('src/term-commands/launch.ts');

    expect(agents).toContain('each concurrently active execution group as an isolated delivery lane');
    expect(work).toContain('even when expected file scopes are disjoint');
    expect(work).toContain('Any failed proof or cleanup leaves the task `in_progress` and the lane intact');
    expect(pm).toContain('A blocked, dirty, unmerged, or unreviewed lane remains active');
    expect(review).toContain('ephemeral, detached, read-only worktree at the exact candidate commit');
    expect(dispatch).toContain('The PM merges reviewed group commits into the wish integration worktree');
    expect(launch).toContain('only the PM integrates, cleans up the lane, and marks tasks done');
  });

  test('mainline ownership follows GitHub-backed and zero-remote repository modes', () => {
    const agents = read('AGENTS.md');
    const lifecycle = read('skills/genie/reference/lifecycle.md');
    const pm = read('skills/pm/SKILL.md');
    const dream = read('skills/dream/SKILL.md');
    const review = read('skills/review/SKILL.md');
    const report = read('skills/report/SKILL.md');
    const dispatch = read('plugins/genie/references/dispatch-contract.md');

    expect(agents).toMatch(/local `main` is a\s+clean fast-forward mirror/);
    expect(lifecycle).toMatch(/Before work, local `main` must be\s+clean, fast-forwarded, and proven equal/);
    expect(pm).toMatch(/Never locally merge the\s+wish branch into `main`/);
    expect(pm).toContain('Any other configured upstream requires an explicit user decision');
    expect(pm).toContain('fast-forward it to `<remote>/main`, and prove both refs resolve to the same commit');
    expect(pm).toContain('With zero remotes, the PM may integrate a finished wish autonomously');
    expect(pm).toContain('annotated tag `archive/wish/<slug>`');
    expect(pm).toContain('compare-and-swap');
    expect(pm.indexOf('Archive that exact closure commit')).toBeLessThan(
      pm.indexOf('Only after archival and cleanup succeed'),
    );
    expect(pm).toMatch(/branch-local status is\s+staged evidence only/);
    expect(lifecycle).toMatch(/not authoritative until third-party merge/);
    expect(lifecycle).toContain('hosted mirror, archive, or cleanup failure after remote merge is recorded lifecycle');
    expect(lifecycle).toContain('failed local mirroring is recorded lifecycle debt');
    expect(dream).toMatch(/PR targeting authoritative `main`/);
    expect(dream).toContain('final closure commit');
    expect(dream).toContain('Report a wish shipped only with authoritative mainline and QA evidence');
    expect(review).toContain('zero remotes → prepare the validated local integration candidate');
    expect(report).toContain('during pre-promotion QA against the exact PR or local integration candidate');
    expect(dispatch).toContain('fresh reviewer, at most three loops');
    for (const doc of [pm, dream, review]) {
      expect(doc).not.toContain('targeting `dev`');
      expect(doc).not.toContain('merge to `dev`');
    }
  });

  test('lifecycle treats simplicity as a hard gate and replans overdesigned work', () => {
    const architecture = read('skills/architecture/SKILL.md');
    const brainstorm = read('skills/brainstorm/SKILL.md');
    const designTemplate = read('skills/brainstorm/references/design-template.md');
    const wish = read('skills/wish/SKILL.md');
    const wishTemplate = read('skills/wish/templates/wish-template.md');
    const review = read('skills/review/SKILL.md');
    const fix = read('skills/fix/SKILL.md');
    const work = read('skills/work/SKILL.md');

    expect(architecture).toContain('KISS comes first');
    expect(brainstorm).toContain('## Simplicity Gate');
    expect(designTemplate).toContain('## Simplicity Case');
    expect(wish).toContain('Pass the simplicity gate');
    expect(wishTemplate).toContain('## Simplicity Case');
    expect(review).toContain('unjustified stateful machinery');
    expect(review).toContain('a HIGH gap');
    for (const lifecycleSkill of [review, fix, work]) expect(lifecycleSkill).toContain('`overdesigned-plan`');
    expect(fix).toContain('up to 3 loops');
    expect(work).toContain('A user-approved simplification invalidates the superseded plan/review evidence');
  });

  test('wizard discloses init MCP writes and owner-qualified lifecycle order', () => {
    const wizard = read('skills/wizard/SKILL.md');
    for (const path of ['.mcp.json', '.warp/.mcp.json', '.codex/config.toml']) expect(wizard).toContain(path);
    for (const skill of ['brainstorm', 'wish', 'review', 'work']) expect(wizard).toContain(`$genie:${skill}`);
    expect(wizard.indexOf('$genie:review')).toBeLessThan(wizard.indexOf('$genie:work'));
    expect(wizard).toContain('Phase 3 is a mandatory gate');
    expect(wizard).toContain('Never enter Phase 4 until WISH status `APPROVED`');
    expect(wizard).toContain('pending until the user trusts the workspace');
  });

  test('brainstorm routes every non-trivial design through design and plan review', () => {
    const brainstorm = read('skills/brainstorm/SKILL.md');
    expect(brainstorm).toContain('auto-invoke `review` (design review)');
    expect(brainstorm).toContain('route through `wish` and plan review before any implementation');
    expect(brainstorm).not.toContain('auto-invoke `review` (plan review)');
    expect(brainstorm).not.toContain('ask whether to implement directly');
  });

  test('design review evidence is digest-bound, persisted, and required before wish', () => {
    const brainstorm = read('skills/brainstorm/SKILL.md');
    const review = read('skills/review/SKILL.md');
    const template = read('skills/brainstorm/references/design-template.md');
    const wish = read('skills/wish/SKILL.md');
    const lint = read('scripts/wishes-lint.ts');
    expect(brainstorm).toContain('design-review-evidence.mjs');
    expect(brainstorm).toContain('--reviewed-sha256 "<reviewer-returned-sha256>"');
    expect(brainstorm).toContain('rejects an edit made after review');
    expect(brainstorm).toContain('changing any reviewed design content invalidates the evidence');
    expect(review).toContain('as `reviewed-sha256`');
    expect(review).toContain('passes that value unchanged');
    expect(template).toContain('<!-- genie-design-review:start -->');
    expect(template).toContain('Reviewed content SHA-256');
    expect(wish).toContain('Missing evidence, a non-SHIP verdict, or a content-digest mismatch cannot be waived');
    expect(wish).toContain('Never repair the failure with a locally recomputed digest');
    expect(lint).toContain('DESIGN_REVIEW_EVIDENCE_THRESHOLD');
    expect(lint).toContain('designReviewViolations');
  });

  test('both reviewer profiles cover every universal review context', () => {
    const profiles = [read('plugins/genie/codex-agents/genie-reviewer.toml'), read('plugins/genie/agents/reviewer.md')];
    for (const profile of profiles) {
      for (const marker of [
        'DESIGN.md',
        'Plan review',
        'completed execution',
        'PR review',
        'SHIP',
        'FIX-FIRST',
        'BLOCKED',
      ]) {
        expect(profile).toContain(marker);
      }
    }
  });

  test('Omni and MCP operator instructions expose provider and fallback policy', () => {
    const omni = read('skills/omni/SKILL.md');
    expect(omni).toContain('{instance, chat, repo, agent, persona?}');
    expect(omni).toContain('"agent": "codex"');
    const readme = read('README.md');
    expect(readme).toContain('no installed, enabled, usable Genie plugin route');
    for (const path of ['.mcp.json', '.warp/.mcp.json', '.codex/config.toml']) expect(readme).toContain(path);
  });
});
