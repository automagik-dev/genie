import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { VERSION } from '../../src/lib/version.js';

type Scenario = 'already-current';

const scenario = process.env.GENIE_TEST_UPDATE_CURRENT_SCENARIO as Scenario | undefined;
const genieHome = process.env.GENIE_HOME;
if (genieHome === undefined || scenario !== 'already-current') {
  throw new Error('runner requires GENIE_HOME and GENIE_TEST_UPDATE_CURRENT_SCENARIO=already-current');
}

const bin = join(genieHome, 'bin');
for (const directory of ['plugins/genie', 'skills/review', 'templates']) {
  mkdirSync(join(bin, directory), { recursive: true });
}
writeFileSync(join(bin, 'LICENSE'), 'fixture\n');
writeFileSync(join(bin, 'VERSION'), `${VERSION}\n`);
writeFileSync(join(bin, 'plugins', 'genie', 'plugin.json'), '{"name":"genie"}\n');
writeFileSync(join(bin, 'skills', 'review', 'SKILL.md'), '# Review\n');
writeFileSync(join(bin, 'templates', 'fixture.txt'), 'fixture\n');
const executable = join(bin, 'genie');
writeFileSync(executable, `#!/bin/sh\nif [ "\${1:-}" = "--version" ]; then printf 'genie ${VERSION}\\n'; fi\nexit 0\n`);
chmodSync(executable, 0o755);
mkdirSync(process.env.HOME as string, { recursive: true });
mkdirSync(process.env.CODEX_HOME as string, { recursive: true });
const marker = join(genieHome, '.install-version');
writeFileSync(marker, 'prior-marker\n');

const { resolvePlatformId, updateCommand } = await import('../../src/genie-commands/update.js');
const platform = resolvePlatformId();

function currentManifest() {
  const raw = JSON.stringify({
    schema_version: 1,
    channel: 'dev',
    version: VERSION,
    released_at: '2026-07-23T00:00:00.000Z',
    tarball_base: `https://example.invalid/releases/v${VERSION}`,
    platforms: [platform],
  });
  return {
    ...JSON.parse(raw),
    manifestBytes: raw,
    manifestSha256: 'a'.repeat(64),
  };
}

let deliveries = 0;
let convergenceRuns = 0;
console.log = () => {};
console.error = () => {};

await updateCommand(
  { dev: true, yes: true, restart: false, verify: false },
  {
    fetchManifest: async () => currentManifest(),
    readInstalledVersion: () => VERSION,
    requireCanonicalInstall: () => {},
    alreadyCurrent: {
      runConvergence: () => {
        convergenceRuns += 1;
      },
    },
    deliverSelectedManifest: async () => {
      deliveries += 1;
      return [];
    },
    finalizeSelectedDelivery: async () => true,
  },
);

const markerExists = existsSync(marker);
process.stdout.write(
  `${JSON.stringify({
    deliveries,
    convergenceRuns,
    markerExists,
    markerText: markerExists ? readFileSync(marker, 'utf8') : null,
    commandExitCode: process.exitCode ?? 0,
  })}\n`,
);
