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

  test('delivery evidence becomes publicly immutable before exact manifest CAS', () => {
    const release = read('.github/workflows/release.yml');
    const publish = read('.github/workflows/release-publish.yml');
    for (const input of ['source_sha', 'source_branch', 'source_ci_run_id']) {
      expect(release).toContain(`${input}: \${{ inputs.${input} }}`);
      expect(publish).toContain(`${input}:`);
      expect(publish).toContain(`\${{ inputs.${input} }}`);
    }
    expect(publish).toContain('bun scripts/build-delivery-evidence.ts');
    expect(publish).toContain('bash scripts/materialize-release-subjects.sh');
    expect(publish).toContain('bun-version: 1.3.11');
    expect(publish).toContain('predicate-type: https://github.com/${{ github.repository }}/delivery-evidence/v1');
    expect(publish).toContain('actions/attest@67422f5511b7ff725f4dbd6fb9bd2cd925c65a8d');
    expect(publish).toContain('${DESCRIPTOR}.sigstore.json');
    expect(publish).toContain('EVIDENCE_CHANNELS=(stable homolog dev)');
    expect(publish).toContain('EVIDENCE_CHANNELS=(homolog dev)');
    expect(publish).toContain('EVIDENCE_CHANNELS=(dev)');
    expect(publish).toContain('name: delivery-candidate-manifests');
    expect(publish).toContain('CANDIDATE_MANIFEST_DIR="$CANDIDATE_MANIFEST_DIR"');

    const attest = publish.indexOf('id: endorse');
    const materialize = publish.indexOf('bash scripts/materialize-release-subjects.sh');
    const descriptorBuild = publish.indexOf('bun scripts/build-delivery-evidence.ts');
    const compatibilityJob =
      publish.split('\n  delivery-evidence-compatibility:')[1]?.split('\n  codex-native-dogfood:')[0] ?? '';
    const publishJob = publish.split('\n  publish:')[1]?.split('\n  manifests:')[0] ?? '';
    const releaseUpload = publish.indexOf('bash scripts/reconcile-release-assets.sh');
    const manifestsJob = publish.split('\n  manifests:')[1]?.split('\n  finalize:')[0] ?? '';
    const finalizeJob = publish.split('\n  finalize:')[1] ?? '';
    expect(attest).toBeGreaterThan(-1);
    expect(materialize).toBeGreaterThan(-1);
    expect(descriptorBuild).toBeGreaterThan(materialize);
    expect(attest).toBeGreaterThan(descriptorBuild);
    expect(releaseUpload).toBeGreaterThan(attest);
    expect(compatibilityJob).toContain('needs: [admit, attest-delivery-evidence]');
    expect(compatibilityJob).toContain('permissions:\n      contents: read');
    expect(compatibilityJob).not.toContain('id-token:');
    expect(compatibilityJob).not.toContain('attestations:');
    expect(compatibilityJob).toContain('ref: ${{ inputs.source_sha }}');
    expect(compatibilityJob).toContain('bun install --frozen-lockfile --ignore-scripts');
    expect(compatibilityJob).toContain('bun scripts/verify-delivery-evidence-pack.ts');
    expect(compatibilityJob).toContain('name: delivery-candidate-manifests');
    expect(publishJob).toContain('- codex-dogfood-completeness');
    expect(publishJob).toContain('- stable-release-security-gate');
    expect(publishJob).toContain("needs.codex-dogfood-completeness.result == 'success'");
    expect(publishJob).toContain("needs.stable-release-security-gate.result == 'success'");
    expect(publishJob).toContain('name: delivery-candidate-manifests');
    expect(manifestsJob).toContain('needs: finalize');
    expect(manifestsJob).toContain('git push origin "HEAD:refs/heads/main"');
    expect(finalizeJob).toContain('needs: publish');
    expect(finalizeJob).toContain('name: delivery-candidate-manifests');
    expect(finalizeJob.indexOf('bash scripts/reconcile-release-note.sh finalize')).toBeGreaterThan(-1);
    expect(finalizeJob.indexOf('bash scripts/release-immutability.sh release')).toBeGreaterThan(
      finalizeJob.indexOf('bash scripts/reconcile-release-note.sh finalize'),
    );
    expect(finalizeJob.lastIndexOf('bash scripts/reconcile-release-assets.sh')).toBeGreaterThan(
      finalizeJob.indexOf('bash scripts/release-immutability.sh release'),
    );
    const assetReconciliation = read('scripts/reconcile-release-assets.sh');
    expect(assetReconciliation).toContain('manifest_path="${CANDIDATE_MANIFEST_DIR}/${manifest_name}"');
    expect(assetReconciliation).toContain('.releaseManifestSha256 == $manifest_sha');
  });

  test('manifest-derived native dogfood and the independent security gate jointly block publication', () => {
    const workflow = read('.github/workflows/release-publish.yml');
    const prepare =
      workflow.split('\n  prepare-delivery-evidence:')[1]?.split('\n  attest-delivery-evidence:')[0] ?? '';
    const native = workflow.split('\n  codex-native-dogfood:')[1]?.split('\n  codex-dogfood-completeness:')[0] ?? '';
    const completeness =
      workflow.split('\n  codex-dogfood-completeness:')[1]?.split('\n  stable-release-security-gate:')[0] ?? '';
    const security = workflow.split('\n  stable-release-security-gate:')[1]?.split('\n  publish:')[0] ?? '';
    const publish = workflow.split('\n  publish:')[1]?.split('\n  manifests:')[0] ?? '';

    // The selected candidate manifest is the sole platform inventory. A
    // hand-written representative matrix cannot become promotion evidence.
    expect(prepare).toContain('bun scripts/candidate-dogfood-matrix.ts');
    expect(prepare).toContain('--manifest "$SELECTED_MANIFEST"');
    expect(prepare).toContain('mapfile -t MANIFEST_PLATFORMS');
    expect(prepare).toContain('for platform in "${MANIFEST_PLATFORMS[@]}"');
    expect(prepare).not.toContain('PLATFORMS=(linux-x64-glibc');
    expect(prepare).toContain('dogfood_matrix=${DOGFOOD_MATRIX}');
    expect(prepare).toContain('candidate_manifest_sha256=${CANDIDATE_MANIFEST_SHA256}');
    expect(prepare).toContain('name: codex-dogfood-candidate-matrix');
    expect(prepare).toContain('name: codex-dogfood-previous-release');
    expect(prepare).toContain('bash scripts/verify-release.sh --local');
    expect(prepare).not.toContain('--previous-descriptor');

    expect(native).toContain('matrix: ${{ fromJSON(needs.prepare-delivery-evidence.outputs.dogfood_matrix) }}');
    expect(native).toContain('runs-on: ${{ matrix.runner }}');
    expect(native).toContain('ref: ${{ github.sha }}');
    expect(native).toContain('name: genie-${{ matrix.version }}-${{ matrix.platform }}-signed');
    expect(native).toContain('--previous-provenance "${PREVIOUS_ARTIFACT}.intoto.jsonl"');
    expect(native).toContain('--candidate-descriptor "$CANDIDATE_DESCRIPTOR"');
    expect(native).toContain('--candidate-bundle "${CANDIDATE_DESCRIPTOR}.sigstore.json"');
    expect(native).toContain('EXECUTION_KIND: ${{ matrix.execution }}');
    expect(native).toContain('scripts/run-musl-dogfood.sh');
    expect(native).toContain('--inputs-root dogfood-entry');
    expect(native).toContain('name: codex-dogfood-evidence-${{ matrix.platform }}');

    // Missing, skipped, duplicated, stale, or identity-mismatched native
    // entries fail the aggregate instead of degrading to representative proof.
    expect(completeness).toContain('if: ${{ always() }}');
    expect(completeness).toContain('[[ "$PREPARE_RESULT" == success && "$NATIVE_RESULT" == success ]]');
    expect(completeness).toContain('downloaded candidate matrix differs from the matrix used to schedule native jobs');
    expect(completeness).toContain('bun scripts/validate-dogfood-matrix-evidence.ts');
    expect(completeness).toContain('--evidence-dir aggregate/entries');
    expect(completeness).toContain('--candidate-manifest-sha256 "$EXPECTED_MANIFEST_SHA256"');
    const aggregate = read('scripts/validate-dogfood-matrix-evidence.ts');
    expect(aggregate).toContain("entry.evidenceKind !== 'host-native'");
    expect(aggregate).toContain('candidate.manifestSha256 !== options.candidateManifestSha256');
    expect(aggregate).toContain('candidate.artifactSha256 !== matrixEntry.artifactSha256');
    expect(aggregate).toContain("kind: 'codex-dogfood-completeness'");

    // The machine security proof is read-only, protected-control-derived, and
    // independent of dogfood while binding the same exact candidate digest.
    expect(security).toContain('if: ${{ always() }}');
    expect(security).toContain('permissions:\n      contents: read\n      attestations: read');
    expect(security).toContain('ref: ${{ github.sha }}');
    expect(security).toContain('bash scripts/verify-release.sh --local');
    expect(security).toContain('bash scripts/release-generic-provenance.sh verify-exact-subject');
    expect(security).toContain('gh attestation verify "$artifact_path"');
    expect(security).toContain('--predicate-type "https://github.com/${RELEASE_REPOSITORY}/release-tarballs/v1"');
    expect(security).toContain('--source-digest "$CONTROL_SHA"');
    expect(security).toContain('--signer-digest "$CONTROL_SHA"');
    expect(security).toContain('bash scripts/release-native-predicate.sh verify-exact-subject');
    expect(security).toContain('RUN_ID: ${{ github.run_id }}');
    expect(security).toContain('RUN_ATTEMPT: ${{ github.run_attempt }}');
    expect(security).toContain('generic/native artifact digest disagreement');
    expect(security).toContain('version: ([$entries[].native.version] | unique |');
    expect(security).toContain('sourceSha: ([$entries[].native.sourceSha] | unique |');
    const securitySummary = security.split('          jq -cs \\\n')[1] ?? '';
    expect(securitySummary).not.toContain('--arg sourceSha "$SOURCE_SHA"');
    expect(security).toContain('--print-provenance > "$verified_provenance"');
    expect(security).toContain('scripts/release-guard.test.ts');
    expect(security).toContain(
      'EXPECTED_MANIFEST_SHA256: ${{ needs.prepare-delivery-evidence.outputs.candidate_manifest_sha256 }}',
    );
    expect(security).not.toContain('needs.codex-native-dogfood');
    expect(security).not.toContain('contents: write');
    expect(security).not.toContain('id-token: write');

    // All channels use both gates. An unavailable/skipped gate is never
    // equivalent to success, and the write-capable publication job stays shut.
    expect(publish).toContain('always() &&');
    expect(publish).toContain('- codex-dogfood-completeness');
    expect(publish).toContain('- stable-release-security-gate');
    expect(publish).toContain("needs.codex-dogfood-completeness.result == 'success'");
    expect(publish).toContain("needs.stable-release-security-gate.result == 'success'");
    expect(publish).not.toContain("inputs.channel == 'stable'");
    expect(publish).not.toContain("inputs.channel == 'homolog'");
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

  test('each promotion uses a fresh build-accepted immutable release identity', () => {
    const version = read('.github/workflows/version.yml');
    const release = read('.github/workflows/release.yml');
    const build = read('.github/workflows/build-tarballs.yml');
    const assets = read('scripts/reconcile-release-assets.sh');
    expect(version).toContain('group: version-release-identity-${{ github.event.workflow_run.event }}');
    expect(version).toContain('queue: max');
    expect(version).toContain('cancel-in-progress: false');
    expect(version).toContain('MAX_COUNTER=');
    expect(version).toContain('git tag "v${VERSION}" HEAD');
    expect(version).toContain('name: Push fresh immutable promotion tag');
    expect(version).toContain('git push origin "refs/tags/v${VERSION}"');
    expect(build).toContain('homolog|stable)');
    expect(build).toContain('Authenticated ${INPUT_CHANNEL} promotion stamps immutable version');
    const buildCall = release.split('\n  build:')[1]?.split('\n  sign-attest:')[0] ?? '';
    expect(buildCall).toContain('channel: ${{ inputs.channel }}');
    expect(assets).toContain('refusing to mutate an incomplete published immutable release');
    expect(assets).not.toContain('append-only promotion');
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
    // Manifest push authenticates with a fine-grained PAT, not a deploy key
    // (deploy keys are disabled org-wide; the ssh-key model silently fell back
    // to the bot token and 403'd on protected main). The stale deploy-key
    // secret must be gone.
    expect(workflow).toContain('token: ${{ secrets.RELEASE_MANIFESTS_TOKEN }}');
    expect(workflow).not.toContain('RELEASE_MANIFESTS_DEPLOY_KEY: ${{');
    expect(workflow).not.toContain('ssh-key: ${{ secrets.RELEASE_MANIFESTS_DEPLOY_KEY }}');
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
    const security = read('SECURITY.md');
    expect(security).toContain(
      'Every dev, homolog, or stable promotion creates a fresh monotonic version and immutable tag',
    );
    expect(security).toContain('stable releases are non-prerelease and marked Latest');
    expect(security).toContain('dev and homolog releases are prereleases and never Latest');
    expect(security).not.toContain('one verified version across dev, homolog, and stable channels');
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

  test('shipped Codex integration doc carries the exit matrix, trailer, lease, and homolog contract', () => {
    const doc = read('plugins/genie/references/codex-integration-map.md');
    // Exit matrix (per-command 0/1/2) with the busy code.
    expect(doc).toContain('### Per-command 0/1/2 exit matrix');
    expect(doc).toContain('`codex-lifecycle-busy`');
    expect(doc).toContain('| `genie setup --codex`');
    expect(doc).toContain('| `genie update --rollback`');
    expect(doc).toContain('| `genie uninstall`');
    expect(doc).toContain('| `genie doctor`');
    // Result trailer, serialized once by Group A.
    expect(doc).toContain('### Result trailer');
    expect(doc).toContain('serializeActivationResultTrailer');
    expect(doc).toContain('"schemaVersion":1');
    expect(doc).toContain('"deliveryComplete":false');
    expect(doc).toContain('"nextAction"');
    // Lease busy/retry semantics.
    expect(doc).toContain('exclusive lease');
    expect(doc).toContain('no force override');
    // Rollback floor, sync-only, route-only init, uninstall isolation.
    expect(doc).toContain('### Rollback floor');
    expect(doc).toContain('cannot waive the protocol floor');
    expect(doc).toContain('**Sync-only**');
    expect(doc).toContain('route-only init');
    expect(doc).toContain('independent of plugin availability');
    expect(doc).toContain('unreachable from update, install, setup, doctor, sync');
    // Homolog candidate channel + the N-task non-guarantee.
    expect(doc).toContain('Homolog is the canonical pre-stable candidate channel');
    expect(doc).toContain('an activated N task is not');
    expect(doc).toContain('cannot resume activated N tasks without');
    expect(doc).toContain('scripts/validate-live-dogfood-evidence.ts');
    expect(doc).toContain('scripts/verify-codex-activation-payload.ts');
  });

  test('release build independently verifies each extracted activation payload', () => {
    const build = read('scripts/build-binary.sh');
    const extract = build.indexOf('tar -xzf "${TARBALL}"');
    const verifyPayload = build.indexOf('scripts/verify-codex-activation-payload.ts');
    expect(verifyPayload).toBeGreaterThan(extract);
    expect(build).toContain('--root "${VERIFY_ROOT}" --platform "${PLATFORM}" --version "${VERSION}"');
    // The extracted-payload verifier must be a covered Build-Tarballs PR input.
    expect(read('.github/workflows/build-tarballs.yml')).toContain("- 'scripts/verify-codex-activation-payload.ts'");
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
      '.codex/config.toml',
      'H3',
      'H4',
      'H6',
      '/hooks',
      'start a new task',
    ]) {
      expect(docs).toContain(statement);
    }
    // Plugin-only contract: the installed plugin is the sole Genie-managed skill provider.
    expect(read('README.md')).toContain('the **sole** Genie-managed skill provider');
    expect(read('README.md')).toContain('Fallback retirement');
    expect(read('plugins/genie/README.md')).toContain('the only Genie-managed skill provider');
    expect(read('README.md')).toContain('the plugin declares no Codex MCP route');
    expect(read('plugins/genie/README.md')).toContain('the plugin declares no Codex MCP route');
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
    expect(plugin).toContain('successful `genie setup --codex` persists Codex delivery scope');
    expect(root).toContain('Successful setup persists Codex delivery scope');
    // Delivery scope authorizes later publication only; setup remains the sole activation/convergence owner.
    expect(plugin).toContain('never advance the plugin cache');
    expect(root).toContain('those updates still deliver only');
    expect(plugin).toContain('nothing is written to `~/.agents/skills`');
    expect(root).toContain('Genie never seeds the user tier');
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

  test('Omni and MCP operator instructions expose provider and project-route ownership policy', () => {
    const omni = read('skills/omni/SKILL.md');
    expect(omni).toContain('{instance, chat, repo, agent, persona?}');
    expect(omni).toContain('"agent": "codex"');
    const readme = read('README.md');
    expect(readme).toContain('The Codex route is plugin-independent');
    for (const path of ['.mcp.json', '.warp/.mcp.json', '.codex/config.toml']) expect(readme).toContain(path);
  });
});
