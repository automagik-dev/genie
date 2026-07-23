/**
 * Test-only command driver for the real setup/doctor implementations.
 *
 * The lifecycle PTY fixture persists a deterministic, unsigned Sigstore bundle.
 * Production intentionally has no environment or CLI verification bypass, so
 * this unshipped runner supplies the same-process cryptographic seam while all
 * descriptor, manifest, candidate, store, setup, and doctor bindings remain
 * live.
 */

import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { doctorCommand } from '../../src/genie-commands/doctor.js';
import {
  assertLocalDeliveryRepairEnabled,
  materializeLocalDeliveryRepair,
} from '../../src/genie-commands/local-delivery-repair.js';
import { setupCommand } from '../../src/genie-commands/setup.js';
import {
  attemptAlreadyCurrentDeliveryRepair,
  createPrivateUpdateTempRoot,
  projectLocalDeliveryRepairDirective,
  resolvePlatformId,
} from '../../src/genie-commands/update.js';
import { observeCodexActivation, openCodexActivationStore } from '../../src/lib/codex-activation-executor.js';
import {
  type DeliveryEvidenceVerificationDependencies,
  verifyDownloadedDeliveryEvidence,
} from '../../src/lib/codex-delivery-evidence.js';
import { buildTestDeliveryEvidencePack } from '../../src/lib/codex-delivery-evidence.test-support.js';
import { acquireLifecycleLease } from '../../src/lib/codex-lifecycle-lease.js';
import { resolveCodexDir, resolveGenieHome } from '../../src/lib/genie-home.js';
import { VERSION } from '../../src/lib/version.js';

const TEST_EVIDENCE_VERIFICATION: DeliveryEvidenceVerificationDependencies = {
  verifyBundle: () => ({ integratedTime: '1753228800' }),
};

async function publishLocalDeliveryFixture(rawRequest: string): Promise<void> {
  assertLocalDeliveryRepairEnabled(process.env.GENIE_RELEASE_DOGFOOD);
  const genieHome = resolveGenieHome();
  const platformId = resolvePlatformId();
  const snapshotRoot = createPrivateUpdateTempRoot();
  const lease = acquireLifecycleLease('update-delivery', { genieHome });
  try {
    if (!lease.ok) {
      const projection = projectLocalDeliveryRepairDirective({ action: 'busy', detail: lease.detail });
      for (const line of projection.stdout) process.stdout.write(`${line}\n`);
      for (const line of projection.stderr) process.stderr.write(`${line}\n`);
      process.exitCode = projection.exitCode;
      return;
    }
    const local = materializeLocalDeliveryRepair(rawRequest, snapshotRoot, platformId, VERSION);
    const directive = await attemptAlreadyCurrentDeliveryRepair(
      local.manifest.channel,
      local.platformId,
      lease,
      genieHome,
      {
        evidenceVerification: TEST_EVIDENCE_VERIFICATION,
        fetchManifest: async (channel) => {
          if (channel !== local.manifest.channel) throw new Error('fixture channel drifted');
          return local.manifest;
        },
        downloadAndVerifyDeliveryAssets: async (manifest, requestedPlatform) => {
          if (
            requestedPlatform !== local.platformId ||
            manifest.manifestSha256 !== local.manifest.manifestSha256 ||
            manifest.manifestBytes !== local.manifest.manifestBytes
          ) {
            throw new Error('fixture repair target drifted');
          }
          return {
            tarballPath: local.artifactPath,
            descriptorBytes: local.descriptorBytes,
            bundleBytes: local.bundleBytes,
          };
        },
      },
    );
    const projection = projectLocalDeliveryRepairDirective(directive);
    for (const line of projection.stdout) process.stdout.write(`${line}\n`);
    for (const line of projection.stderr) process.stderr.write(`${line}\n`);
    process.exitCode = projection.exitCode;
  } finally {
    if (lease.ok) lease.release();
    rmSync(snapshotRoot, { recursive: true, force: true });
  }
}

const [command, ...args] = process.argv.slice(2);

if (command === 'publish-delivery') {
  const genieHome = resolveGenieHome();
  const codexHome = resolveCodexDir();
  const codexCommand = Bun.which('codex');
  const snapshot = observeCodexActivation({
    genieHome,
    codexHome,
    command: codexCommand,
  });
  if (snapshot.canonical.status !== 'ok') {
    throw new Error(`fixture canonical delivery is unavailable: ${snapshot.canonical.detail}`);
  }
  const installedBinarySha256 = createHash('sha256')
    .update(readFileSync(join(genieHome, 'bin', 'genie')))
    .digest('hex');
  const pack = buildTestDeliveryEvidencePack({
    descriptor: {
      version: snapshot.canonical.version.canonical,
      releaseTag: `v${snapshot.canonical.version.canonical}`,
      artifactSha256: installedBinarySha256,
      installedBinarySha256,
      canonicalPayloadSha256: snapshot.canonical.digest,
    },
  });
  const evidence = verifyDownloadedDeliveryEvidence(pack.input, pack.dependencies);
  const lease = acquireLifecycleLease('update-delivery', { genieHome });
  if (!lease.ok) throw new Error(`fixture delivery publication could not acquire the lifecycle lease: ${lease.detail}`);
  try {
    openCodexActivationStore({
      genieHome,
      codexHome,
      command: codexCommand,
      deliveryEvidenceVerification: pack.dependencies,
    }).publishDelivery(lease, {
      evidence,
      deliveryRoot: realpathSync(genieHome),
    });
  } finally {
    lease.release();
  }
} else if (command === 'setup' && args.includes('--codex')) {
  await setupCommand(
    {
      codex: true,
      quick: args.includes('--quick'),
    },
    { deliveryEvidenceVerification: TEST_EVIDENCE_VERIFICATION },
  );
} else if (command === 'publish-local-delivery' && args.length === 1) {
  await publishLocalDeliveryFixture(args[0] as string);
} else if (command === 'doctor') {
  await doctorCommand(
    {
      json: args.includes('--json'),
      fix: args.includes('--fix'),
    },
    {
      deliveryEvidenceVerification: TEST_EVIDENCE_VERIFICATION,
      bunVersion: '1.3.10',
      bunPath: process.execPath,
    },
  );
} else {
  process.stderr.write(`unsupported lifecycle test command: ${[command, ...args].join(' ')}\n`);
  process.exitCode = 64;
}
