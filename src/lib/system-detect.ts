import { readFile } from 'node:fs/promises';
import { arch, platform } from 'node:os';
import { $ } from 'bun';

export type OSType = 'macos' | 'linux' | 'unknown';
export type LinuxDistro = 'debian' | 'ubuntu' | 'fedora' | 'rhel' | 'arch' | 'unknown';
export type PackageManager = 'brew' | 'apt' | 'dnf' | 'yum' | 'pacman' | 'none';

export interface SystemInfo {
  os: OSType;
  arch: string;
  linuxDistro?: LinuxDistro;
  preferredPM: PackageManager;
}

interface CommandCheck {
  exists: boolean;
  version?: string;
  path?: string;
}

export interface PrerequisiteStatus {
  name: string;
  installed: boolean;
  version?: string;
  path?: string;
  required: boolean;
  description: string;
}

function getOSType(): OSType {
  const p = platform();
  if (p === 'darwin') return 'macos';
  if (p === 'linux') return 'linux';
  return 'unknown';
}

function matchDistro(id: string, idLike: string): LinuxDistro {
  const distroChecks: Array<{ distro: LinuxDistro; ids: string[] }> = [
    { distro: 'ubuntu', ids: ['ubuntu'] },
    { distro: 'debian', ids: ['debian'] },
    { distro: 'fedora', ids: ['fedora'] },
    { distro: 'rhel', ids: ['rhel', 'centos', 'rocky', 'almalinux'] },
    { distro: 'arch', ids: ['arch'] },
  ];

  for (const { distro, ids } of distroChecks) {
    if (ids.includes(id) || ids.some((d) => idLike.includes(d))) return distro;
  }
  return 'unknown';
}

async function parseOsRelease(): Promise<LinuxDistro> {
  try {
    const content = await readFile('/etc/os-release', 'utf-8');
    const info: Record<string, string> = {};

    for (const line of content.split('\n')) {
      const [key, ...valueParts] = line.split('=');
      if (key && valueParts.length > 0) {
        info[key] = valueParts.join('=').replace(/^"|"$/g, '');
      }
    }

    return matchDistro((info.ID || '').toLowerCase(), (info.ID_LIKE || '').toLowerCase());
  } catch {
    return 'unknown';
  }
}

async function commandExists(cmd: string): Promise<boolean> {
  try {
    const result = await $`which ${cmd}`.quiet();
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

async function detectPackageManager(): Promise<PackageManager> {
  // Prefer brew if available (works on both macOS and Linux)
  if (await commandExists('brew')) return 'brew';
  if (await commandExists('apt')) return 'apt';
  if (await commandExists('dnf')) return 'dnf';
  if (await commandExists('yum')) return 'yum';
  if (await commandExists('pacman')) return 'pacman';
  return 'none';
}

export async function detectSystem(): Promise<SystemInfo> {
  const os = getOSType();
  const systemArch = arch();

  const result: SystemInfo = {
    os,
    arch: systemArch,
    preferredPM: await detectPackageManager(),
  };

  if (os === 'linux') {
    result.linuxDistro = await parseOsRelease();
  }

  return result;
}

export async function checkCommand(cmd: string): Promise<CommandCheck> {
  try {
    const whichResult = await $`which ${cmd}`.quiet().text();
    const cmdPath = whichResult.trim();

    if (!cmdPath) {
      return { exists: false };
    }

    // Try to get version
    let version: string | undefined;
    try {
      // Try common version flags
      const versionResult = await $`${cmd} --version`.quiet().text();
      // Extract first line and clean it up
      const firstLine = versionResult.split('\n')[0].trim();
      // Try to extract version number
      const versionMatch = firstLine.match(/(\d+\.[\d.]+[a-z0-9-]*)/i);
      version = versionMatch ? versionMatch[1] : firstLine.slice(0, 50);
    } catch {
      // Some commands don't support --version, try -v
      try {
        const vResult = await $`${cmd} -v`.quiet().text();
        const firstLine = vResult.split('\n')[0].trim();
        const versionMatch = firstLine.match(/(\d+\.[\d.]+[a-z0-9-]*)/i);
        version = versionMatch ? versionMatch[1] : firstLine.slice(0, 50);
      } catch {
        // Version unknown but command exists
      }
    }

    return { exists: true, version, path: cmdPath };
  } catch {
    return { exists: false };
  }
}

const PREREQUISITES = [
  {
    name: 'tmux',
    required: true,
    description: 'Terminal multiplexer for shared sessions',
  },
  {
    name: 'bun',
    required: true,
    description: 'Fast JavaScript runtime and package manager',
  },
  {
    name: 'claude',
    required: false,
    description: 'Claude Code CLI (optional, recommended)',
  },
];

export async function checkAllPrerequisites(): Promise<PrerequisiteStatus[]> {
  const results: PrerequisiteStatus[] = [];

  for (const prereq of PREREQUISITES) {
    const check = await checkCommand(prereq.name);
    results.push({
      name: prereq.name,
      installed: check.exists,
      version: check.version,
      path: check.path,
      required: prereq.required,
      description: prereq.description,
    });
  }

  return results;
}

export function getDistroDisplayName(distro: LinuxDistro): string {
  const names: Record<LinuxDistro, string> = {
    ubuntu: 'Ubuntu',
    debian: 'Debian',
    fedora: 'Fedora',
    rhel: 'RHEL/CentOS',
    arch: 'Arch Linux',
    unknown: 'Linux',
  };
  return names[distro] || 'Linux';
}
