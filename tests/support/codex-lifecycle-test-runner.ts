/**
 * Test-only command driver for the real setup/doctor implementations.
 *
 * The lifecycle PTY fixture persists a deterministic, unsigned Sigstore bundle.
 * Production intentionally has no environment or CLI verification bypass, so
 * this unshipped runner supplies the same-process cryptographic seam while all
 * descriptor, manifest, candidate, store, setup, and doctor bindings remain
 * live.
 */

import { doctorCommand } from '../../src/genie-commands/doctor.js';
import { setupCommand } from '../../src/genie-commands/setup.js';
import type { DeliveryEvidenceVerificationDependencies } from '../../src/lib/codex-delivery-evidence.js';

const TEST_EVIDENCE_VERIFICATION: DeliveryEvidenceVerificationDependencies = {
  verifyBundle: () => ({ integratedTime: '1753228800' }),
};

const [command, ...args] = process.argv.slice(2);

if (command === 'setup' && args.includes('--codex')) {
  await setupCommand(
    {
      codex: true,
      quick: args.includes('--quick'),
    },
    { deliveryEvidenceVerification: TEST_EVIDENCE_VERIFICATION },
  );
} else if (command === 'doctor') {
  await doctorCommand(
    {
      json: args.includes('--json'),
      fix: args.includes('--fix'),
    },
    { deliveryEvidenceVerification: TEST_EVIDENCE_VERIFICATION },
  );
} else {
  process.stderr.write(`unsupported lifecycle test command: ${[command, ...args].join(' ')}\n`);
  process.exitCode = 64;
}
