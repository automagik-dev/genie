import { spawn } from 'node:child_process';
import { confirm } from '@inquirer/prompts';
import { genieConfigExists } from '../lib/genie-config.js';
import {
  type PackageManager,
  type PrerequisiteStatus,
  type SystemInfo,
  checkAllPrerequisites,
  checkCommand,
  detectSystem,
  getDistroDisplayName,
} from '../lib/system-detect.js';
import { setupCommand } from './setup.js';

interface InstallOptions {
  check?: boolean;
  yes?: boolean;
}

interface InstallStrategy {
  brew?: string;
  apt?: string;
  dnf?: string;
  yum?: string;
  pacman?: string;
  all?: string;
  none?: string | null;
}

const STRATEGIES: Record<string, InstallStrategy> = {
  tmux: {
    brew: 'brew install tmux',
    apt: 'sudo apt update && sudo apt install -y tmux',
    dnf: 'sudo dnf install -y tmux',
    yum: 'sudo yum install -y tmux',
    pacman: 'sudo pacman -S --noconfirm tmux',
    none: null,
  },
  bun: {
    all: 'curl -fsSL https://bun.sh/install | bash',
  },
  claude: {
    all: 'npm install -g @anthropic-ai/claude-code',
  },
};

function getInstallCommand(name: string, pm: PackageManager): string | null {
  const strategy = STRATEGIES[name];
  if (!strategy) return null;

  // Check for universal installer first
  if (strategy.all) return strategy.all;

  // Check for package manager specific
  if (pm !== 'none' && strategy[pm]) return strategy[pm];

  // Check if there's a none/manual fallback
  if (strategy.none !== undefined) return strategy.none;

  return null;
}

function getManualInstructions(name: string): string {
  switch (name) {
    case 'tmux':
      return 'Visit https://github.com/tmux/tmux/wiki/Installing for installation instructions';
    case 'bun':
      return 'Visit https://bun.sh for installation instructions';
    case 'claude':
      return 'Run: npm install -g @anthropic-ai/claude-code (requires Node.js/npm)';
    default:
      return `Search for "${name} install" for installation instructions`;
  }
}

async function runCommand(command: string): Promise<boolean> {
  return new Promise((resolve) => {
    console.log(`\x1b[2m$ ${command}\x1b[0m\n`);

    const child = spawn('bash', ['-c', command], {
      stdio: 'inherit',
      env: { ...process.env, FORCE_COLOR: '1' },
    });

    child.on('close', (code) => {
      resolve(code === 0);
    });

    child.on('error', (err) => {
      console.error(`\x1b[31mError: ${err.message}\x1b[0m`);
      resolve(false);
    });
  });
}

function printHeader() {
  console.log();
  console.log('\x1b[1m🔧 Genie Prerequisites Check\x1b[0m');
  console.log();
}

function printSystemInfo(system: SystemInfo) {
  let osDisplay = system.os === 'macos' ? 'macOS' : 'Linux';
  if (system.linuxDistro && system.linuxDistro !== 'unknown') {
    osDisplay = `Linux (${getDistroDisplayName(system.linuxDistro)})`;
  }

  console.log(`System: ${osDisplay} (${system.arch})`);
  console.log(`Package Manager: ${system.preferredPM === 'none' ? 'none detected' : system.preferredPM}`);
  console.log();
}

function printPrerequisiteStatus(prereqs: PrerequisiteStatus[]) {
  console.log('Checking prerequisites...');
  console.log();

  for (const p of prereqs) {
    if (p.installed) {
      const versionInfo = p.version ? ` ${p.version}` : '';
      const pathInfo = p.path ? `\x1b[2m (${p.path})\x1b[0m` : '';
      console.log(`  \x1b[32m✅\x1b[0m ${p.name}${versionInfo}${pathInfo}`);
    } else if (p.required) {
      console.log(`  \x1b[31m❌\x1b[0m ${p.name} \x1b[31mnot found\x1b[0m`);
    } else {
      console.log(`  \x1b[33m⚠️\x1b[0m  ${p.name} \x1b[33mnot found\x1b[0m \x1b[2m(optional)\x1b[0m`);
    }
  }
  console.log();
}

function printSeparator() {
  console.log(`\x1b[2m${'─'.repeat(40)}\x1b[0m`);
  console.log();
}

async function promptAndInstall(
  prereq: PrerequisiteStatus,
  command: string | null,
  options: InstallOptions,
): Promise<'installed' | 'skipped' | 'failed'> {
  const typeLabel = prereq.required ? '\x1b[31mrequired\x1b[0m' : '\x1b[2moptional, recommended\x1b[0m';

  if (!command) {
    console.log(`\x1b[33mManual installation required for\x1b[0m ${prereq.name} (${typeLabel})`);
    console.log(`  ${getManualInstructions(prereq.name)}`);
    console.log();
    return 'skipped';
  }

  console.log(`Install \x1b[1m${prereq.name}\x1b[0m? (${typeLabel})`);
  console.log(`  Command: \x1b[36m${command}\x1b[0m`);

  let proceed: boolean;
  if (options.yes) {
    proceed = true;
    console.log('\x1b[2mAuto-approved with --yes\x1b[0m');
  } else {
    // Default to yes for required, no for optional
    proceed = await confirm({
      message: 'Proceed',
      default: prereq.required,
    });
  }

  if (!proceed) {
    console.log(`\x1b[33mSkipped: ${prereq.name}\x1b[0m`);
    console.log();
    return 'skipped';
  }

  console.log();
  console.log(`Installing ${prereq.name}...`);
  console.log();

  const success = await runCommand(command);

  if (success) {
    // Verify installation
    const check = await checkCommand(prereq.name);
    if (check.exists) {
      const versionInfo = check.version ? ` ${check.version}` : '';
      console.log();
      console.log(`\x1b[32m✅ ${prereq.name}${versionInfo} installed\x1b[0m`);
      console.log();
      return 'installed';
    }
    console.log();
    console.log(`\x1b[33m⚠️  ${prereq.name} installed but not found in PATH\x1b[0m`);
    console.log('\x1b[2m  You may need to restart your shell or source your profile\x1b[0m');
    console.log();
    return 'installed';
  }
  console.log();
  console.log(`\x1b[31m❌ Failed to install ${prereq.name}\x1b[0m`);
  console.log(`\x1b[2m  ${getManualInstructions(prereq.name)}\x1b[0m`);
  console.log();
  return 'failed';
}

/**
 * Prompt to run genie setup after successful installation
 */
async function promptForSetup(options: InstallOptions): Promise<void> {
  // Skip if genie config already exists
  if (genieConfigExists()) {
    console.log('\x1b[2m✓ Genie hooks already configured (~/.genie/config.json)\x1b[0m');
    console.log('  Run \x1b[36mgenie setup\x1b[0m to reconfigure.');
    console.log();
    return;
  }

  console.log();
  printSeparator();
  console.log('\x1b[1m🧞 Configure Genie Hooks?\x1b[0m');
  console.log();
  console.log('\x1b[2mHooks let you control how AI tools execute - without wasting tokens!\x1b[0m');
  console.log('\x1b[2mFor example, the "collaborative" hook routes all bash commands through\x1b[0m');
  console.log('\x1b[2mtmux so you can watch the AI work in real-time.\x1b[0m');
  console.log();

  let runSetup: boolean;
  if (options.yes) {
    runSetup = true;
    console.log('\x1b[2mAuto-approved with --yes\x1b[0m');
  } else {
    runSetup = await confirm({
      message: 'Would you like to configure genie hooks now?',
      default: true,
    });
  }

  if (runSetup) {
    console.log();
    await setupCommand();
  } else {
    console.log();
    console.log('\x1b[2mSkipped. Run \x1b[0m\x1b[36mgenie setup\x1b[0m\x1b[2m anytime to configure hooks.\x1b[0m');
    console.log();
  }
}

export async function installCommand(options: InstallOptions): Promise<void> {
  printHeader();

  const system = await detectSystem();
  printSystemInfo(system);

  const prereqs = await checkAllPrerequisites();
  printPrerequisiteStatus(prereqs);

  const missing = prereqs.filter((p) => !p.installed);
  const missingRequired = missing.filter((p) => p.required);
  const missingOptional = missing.filter((p) => !p.required);

  if (missing.length === 0) {
    console.log('\x1b[32m✅ All prerequisites are installed!\x1b[0m');
    console.log();

    // Offer to run setup if not already configured
    await promptForSetup(options);

    console.log('Run \x1b[36mterm --help\x1b[0m or \x1b[36mclaudio --help\x1b[0m to get started.');
    console.log();
    return;
  }

  console.log(`Missing: ${missingRequired.length} required, ${missingOptional.length} optional`);
  console.log();

  if (options.check) {
    if (missingRequired.length > 0) {
      console.log('\x1b[31m❌ Missing required prerequisites\x1b[0m');
      console.log('Run \x1b[36mgenie install\x1b[0m to install them.');
      process.exit(1);
    }
    return;
  }

  printSeparator();

  const results = {
    installed: [] as string[],
    skipped: [] as string[],
    failed: [] as string[],
  };

  // Install missing prerequisites
  for (const prereq of missing) {
    const command = getInstallCommand(prereq.name, system.preferredPM);
    const result = await promptAndInstall(prereq, command, options);

    if (result === 'installed') {
      results.installed.push(prereq.name);
    } else if (result === 'skipped') {
      results.skipped.push(prereq.name);
    } else {
      results.failed.push(prereq.name);
    }

    if (prereq !== missing[missing.length - 1]) {
      printSeparator();
    }
  }

  // Print summary
  printSeparator();
  console.log('\x1b[1mSummary:\x1b[0m');

  const requiredInstalled = results.installed.filter((name) => missingRequired.some((p) => p.name === name));
  const requiredFailed = results.failed.filter((name) => missingRequired.some((p) => p.name === name));
  const optionalSkipped = results.skipped.filter((name) => missingOptional.some((p) => p.name === name));

  if (requiredFailed.length > 0) {
    console.log(`\x1b[31m  ❌ ${requiredFailed.length} required failed: ${requiredFailed.join(', ')}\x1b[0m`);
  } else if (requiredInstalled.length > 0 || missingRequired.length === 0) {
    console.log('\x1b[32m  ✅ All required prerequisites installed\x1b[0m');
  }

  if (results.installed.length > 0) {
    console.log(`\x1b[32m  ✅ Installed: ${results.installed.join(', ')}\x1b[0m`);
  }

  if (optionalSkipped.length > 0) {
    console.log(`\x1b[33m  ⚠️  ${optionalSkipped.length} optional skipped: ${optionalSkipped.join(', ')}\x1b[0m`);
  }

  console.log();

  if (requiredFailed.length === 0) {
    // Offer to run setup after successful installation
    await promptForSetup(options);

    console.log('Run \x1b[36mterm --help\x1b[0m or \x1b[36mclaudio --help\x1b[0m to get started.');
  } else {
    console.log('\x1b[31mSome required prerequisites could not be installed.\x1b[0m');
    console.log('Please install them manually and run this command again.');
    process.exit(1);
  }

  console.log();
}
