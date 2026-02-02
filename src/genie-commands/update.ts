import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { mkdir, copyFile, chmod } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import { loadGenieConfig, genieConfigExists } from '../lib/genie-config.js';

const GENIE_HOME = process.env.GENIE_HOME || join(homedir(), '.genie');
const GENIE_SRC = join(GENIE_HOME, 'src');
const GENIE_BIN = join(GENIE_HOME, 'bin');
const LOCAL_BIN = join(homedir(), '.local', 'bin');

function log(message: string): void {
  console.log(`\x1b[32m▸\x1b[0m ${message}`);
}

function success(message: string): void {
  console.log(`\x1b[32m✔\x1b[0m ${message}`);
}

function error(message: string): void {
  console.log(`\x1b[31m✖\x1b[0m ${message}`);
}

function warn(message: string): void {
  console.log(`\x1b[33m⚠\x1b[0m ${message}`);
}

async function runCommand(command: string, args: string[], cwd?: string): Promise<{ success: boolean; output: string }> {
  return new Promise((resolve) => {
    const output: string[] = [];

    const child = spawn(command, args, {
      cwd,
      stdio: ['inherit', 'pipe', 'pipe'],
      env: { ...process.env, FORCE_COLOR: '1' },
    });

    child.stdout?.on('data', (data) => {
      const str = data.toString();
      output.push(str);
      process.stdout.write(str);
    });

    child.stderr?.on('data', (data) => {
      const str = data.toString();
      output.push(str);
      process.stderr.write(str);
    });

    child.on('close', (code) => {
      resolve({ success: code === 0, output: output.join('') });
    });

    child.on('error', (err) => {
      error(err.message);
      resolve({ success: false, output: err.message });
    });
  });
}

async function getGitInfo(cwd: string): Promise<{ branch: string; commit: string; commitDate: string } | null> {
  try {
    const branchResult = await runCommandSilent('git', ['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
    const commitResult = await runCommandSilent('git', ['rev-parse', '--short', 'HEAD'], cwd);
    const dateResult = await runCommandSilent('git', ['log', '-1', '--format=%ci'], cwd);

    if (branchResult.success && commitResult.success && dateResult.success) {
      return {
        branch: branchResult.output.trim(),
        commit: commitResult.output.trim(),
        commitDate: dateResult.output.trim().split(' ')[0], // Just the date part
      };
    }
  } catch {
    // Ignore errors
  }
  return null;
}

async function runCommandSilent(command: string, args: string[], cwd?: string): Promise<{ success: boolean; output: string }> {
  return new Promise((resolve) => {
    const output: string[] = [];

    const child = spawn(command, args, {
      cwd,
      stdio: ['inherit', 'pipe', 'pipe'],
    });

    child.stdout?.on('data', (data) => {
      output.push(data.toString());
    });

    child.stderr?.on('data', (data) => {
      output.push(data.toString());
    });

    child.on('close', (code) => {
      resolve({ success: code === 0, output: output.join('') });
    });

    child.on('error', (err) => {
      resolve({ success: false, output: err.message });
    });
  });
}

type InstallationType = 'source' | 'npm' | 'bun' | 'unknown';

async function detectInstallationType(): Promise<InstallationType> {
  // First, check if install method is stored in config
  if (genieConfigExists()) {
    try {
      const config = await loadGenieConfig();
      if (config.installMethod) {
        return config.installMethod;
      }
    } catch {
      // Ignore config errors, fall through to detection
    }
  }

  // Fallback: Check for source installation (has .git directory)
  if (existsSync(join(GENIE_SRC, '.git'))) {
    return 'source';
  }

  // Check where genie binary is located
  const result = await runCommandSilent('which', ['genie']);
  if (result.success) {
    const path = result.output.trim();
    // npm/bun global installs are in node_modules or .bun directories
    if (path.includes('.bun')) {
      return 'bun';
    }
    if (path.includes('node_modules')) {
      return 'npm';
    }
    // Source installs use LOCAL_BIN or GENIE_BIN
    if (path === join(LOCAL_BIN, 'genie') || path.startsWith(GENIE_BIN)) {
      return 'source';
    }
    // Default to bun for other paths if bun is available
    const hasBun = (await runCommandSilent('which', ['bun'])).success;
    return hasBun ? 'bun' : 'npm';
  }

  return 'unknown';
}

async function updateViaBun(): Promise<void> {
  log('Updating via bun...');
  const result = await runCommand('bun', ['install', '-g', '@automagik/genie@latest']);
  if (!result.success) {
    error('Failed to update via bun');
    process.exit(1);
  }
  console.log();
  success('Genie CLI updated!');
}

async function updateViaNpm(): Promise<void> {
  log('Updating via npm...');
  const result = await runCommand('npm', ['install', '-g', '@automagik/genie@latest']);
  if (!result.success) {
    error('Failed to update via npm');
    process.exit(1);
  }
  console.log();
  success('Genie CLI updated!');
}

async function updateSource(): Promise<void> {
  // Get current version info before update
  const beforeInfo = await getGitInfo(GENIE_SRC);
  if (beforeInfo) {
    console.log(`Current: \x1b[2m${beforeInfo.branch}@${beforeInfo.commit} (${beforeInfo.commitDate})\x1b[0m`);
    console.log();
  }

  // Step 1: Fetch and reset to origin/main
  log('Fetching latest changes...');
  const fetchResult = await runCommand('git', ['fetch', 'origin'], GENIE_SRC);
  if (!fetchResult.success) {
    error('Failed to fetch from origin');
    process.exit(1);
  }

  log('Resetting to origin/main...');
  const resetResult = await runCommand('git', ['reset', '--hard', 'origin/main'], GENIE_SRC);
  if (!resetResult.success) {
    error('Failed to reset to origin/main');
    process.exit(1);
  }
  console.log();

  // Get new version info
  const afterInfo = await getGitInfo(GENIE_SRC);

  // Check if anything changed
  if (beforeInfo && afterInfo && beforeInfo.commit === afterInfo.commit) {
    success('Already up to date!');
    console.log();
    return;
  }

  // Step 2: Install dependencies
  log('Installing dependencies...');
  const installResult = await runCommand('bun', ['install'], GENIE_SRC);
  if (!installResult.success) {
    error('Failed to install dependencies');
    process.exit(1);
  }
  console.log();

  // Step 3: Build
  log('Building...');
  const buildResult = await runCommand('bun', ['run', 'build'], GENIE_SRC);
  if (!buildResult.success) {
    error('Failed to build');
    process.exit(1);
  }
  console.log();

  // Step 4: Copy binaries and update symlinks
  log('Installing binaries...');

  try {
    await mkdir(GENIE_BIN, { recursive: true });
    await mkdir(LOCAL_BIN, { recursive: true });

    const binaries = ['genie.js', 'term.js', 'claudio.js'];
    const names = ['genie', 'term', 'claudio'];

    for (let i = 0; i < binaries.length; i++) {
      const src = join(GENIE_SRC, 'dist', binaries[i]);
      const binDest = join(GENIE_BIN, binaries[i]);
      const linkDest = join(LOCAL_BIN, names[i]);

      // Copy to GENIE_BIN
      await copyFile(src, binDest);
      await chmod(binDest, 0o755);

      // Symlink to LOCAL_BIN
      await symlinkOrCopy(binDest, linkDest);
    }

    success('Binaries installed');
  } catch (err) {
    error(`Failed to install binaries: ${err}`);
    process.exit(1);
  }

  // Print success
  console.log();
  console.log('\x1b[2m────────────────────────────────────\x1b[0m');
  success('Genie CLI updated successfully!');
  console.log();

  if (afterInfo) {
    console.log(`Version: \x1b[36m${afterInfo.branch}@${afterInfo.commit}\x1b[0m (${afterInfo.commitDate})`);
    console.log();
  }
}

async function symlinkOrCopy(src: string, dest: string): Promise<void> {
  const { symlink, unlink } = await import('fs/promises');

  try {
    // Remove existing symlink/file if present
    if (existsSync(dest)) {
      await unlink(dest);
    }
    await symlink(src, dest);
  } catch {
    // Fallback to copy if symlink fails
    await copyFile(src, dest);
  }
}

export async function updateCommand(): Promise<void> {
  console.log();
  console.log('\x1b[1m🧞 Genie CLI Update\x1b[0m');
  console.log('\x1b[2m────────────────────────────────────\x1b[0m');
  console.log();

  const installType = await detectInstallationType();
  log(`Detected installation: ${installType}`);
  console.log();

  if (installType === 'unknown') {
    error('No Genie CLI installation found');
    console.log();
    console.log('Install method not configured. Please reinstall genie:');
    console.log('\x1b[36m  curl -fsSL https://raw.githubusercontent.com/namastexlabs/genie-cli/main/install.sh | bash\x1b[0m');
    console.log();
    process.exit(1);
  }

  switch (installType) {
    case 'source':
      await updateSource();
      break;
    case 'bun':
      await updateViaBun();
      break;
    case 'npm':
      await updateViaNpm();
      break;
  }
}
