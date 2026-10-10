/**
 * Package auto-detection for the Python REPL.
 *
 * Probes for common data-science / utility packages at startup
 * and formats availability info for the system prompt.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execFileAsync = promisify(execFile);
/** Packages to probe for auto-detection in `full` tools mode. */
export const PROBE_PACKAGES = [
    "numpy",
    "pandas",
    "httpx",
    "bs4", // beautifulsoup4
    "sklearn", // scikit-learn
    "matplotlib",
];
/** Human-friendly display names for import names that differ. */
const DISPLAY_NAMES = {
    bs4: "beautifulsoup4",
    sklearn: "scikit-learn",
};
/**
 * Check the installed Python version.
 * Returns version string and whether it meets the 3.10+ requirement.
 * Throws with platform-specific install guidance if python3 is not found.
 */
export async function checkPythonVersion(pythonPath = "python3") {
    try {
        const { stdout } = await execFileAsync(pythonPath, ["--version"], {
            timeout: 5_000,
        });
        const match = stdout.trim().match(/Python\s+(\d+\.\d+\.\d+)/);
        if (!match) {
            throw new Error(`Unexpected python version output: ${stdout.trim()}`);
        }
        const version = match[1];
        const [major, minor] = version.split(".").map(Number);
        const valid = major > 3 || (major === 3 && minor >= 10);
        return { version, valid };
    }
    catch (err) {
        const error = err;
        if (error.code === "ENOENT") {
            const platform = process.platform;
            let guidance;
            if (platform === "darwin") {
                guidance = "brew install python@3.12";
            }
            else if (platform === "win32") {
                guidance = "Download from https://www.python.org/downloads/";
            }
            else {
                guidance =
                    "sudo apt install python3 (Debian/Ubuntu) or sudo dnf install python3 (Fedora)";
            }
            throw new Error(`Python not found at "${pythonPath}". mikro requires Python 3.10+.\nInstall: ${guidance}`);
        }
        throw err;
    }
}
/**
 * Detect which Python packages are installed.
 * Runs a single Python subprocess to check all packages at once.
 */
export async function detectPackages(pythonPath = "python3") {
    const pkgList = JSON.stringify([...PROBE_PACKAGES]);
    const script = [
        "import importlib, sys",
        `for p in ${pkgList}:`,
        "    try:",
        "        importlib.import_module(p)",
        '        sys.stdout.write(f"{p}:1\\n")',
        "    except ImportError:",
        '        sys.stdout.write(f"{p}:0\\n")',
    ].join("\n");
    const results = {};
    try {
        const { stdout } = await execFileAsync(pythonPath, ["-c", script], {
            timeout: 10_000,
        });
        for (const line of stdout.trim().split("\n")) {
            const sep = line.indexOf(":");
            if (sep === -1)
                continue;
            const name = line.slice(0, sep);
            const available = line.slice(sep + 1) === "1";
            results[name] = available;
        }
    }
    catch {
        // Python not available or error — mark all as unavailable
        for (const pkg of PROBE_PACKAGES) {
            results[pkg] = false;
        }
    }
    return results;
}
/**
 * Format detected packages as a system prompt addition.
 * Returns empty string if no packages are available.
 */
export function formatPackagePrompt(packages) {
    const available = Object.entries(packages)
        .filter(([, v]) => v)
        .map(([k]) => DISPLAY_NAMES[k] ?? k);
    if (available.length === 0)
        return "";
    return `\nAvailable Python packages: ${available.join(", ")}. You may import and use these in your code.`;
}
//# sourceMappingURL=detect.js.map