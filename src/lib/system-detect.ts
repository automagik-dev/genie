import { $ } from 'bun';

interface CommandCheck {
  exists: boolean;
  version?: string;
  path?: string;
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
