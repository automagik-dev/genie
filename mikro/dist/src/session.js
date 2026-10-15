/**
 * Session persistence — auto-save every mikro run to ~/.mikro/sessions/<runId>/.
 *
 * Each session directory contains:
 *   meta.json        — run metadata (runId, query, context, timestamp, version)
 *   usage.json       — token usage and cost statistics
 *   answer.txt       — final answer text
 *   config.yaml      — snapshot of the MikroConfig used
 *   trajectory.jsonl  — copy of the JSONL log (if --log was specified)
 */
import { mkdir, writeFile, copyFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { createRequire } from "node:module";
import yaml from "js-yaml";
/**
 * Save session artifacts to ~/.mikro/sessions/<runId>/.
 * Returns the session directory path.
 */
export async function saveSession(data) {
    const sessionsDir = join(homedir(), ".mikro", "sessions", data.runId);
    await mkdir(sessionsDir, { recursive: true });
    // Read package version
    let version = "unknown";
    try {
        const require = createRequire(import.meta.url);
        const pkg = require("../../package.json");
        version = pkg.version ?? "unknown";
    }
    catch {
        // If we can't read the package, continue with "unknown"
    }
    // 1. meta.json
    const meta = {
        runId: data.runId,
        query: data.query,
        contextPath: data.contextPath,
        timestamp: new Date().toISOString(),
        version,
    };
    await writeFile(join(sessionsDir, "meta.json"), JSON.stringify(meta, null, 2) + "\n");
    // 2. usage.json
    await writeFile(join(sessionsDir, "usage.json"), JSON.stringify(data.usage, null, 2) + "\n");
    // 3. answer.txt
    await writeFile(join(sessionsDir, "answer.txt"), data.answer);
    // 4. config.yaml
    const configYaml = yaml.dump(data.config, { lineWidth: 120, noRefs: true });
    await writeFile(join(sessionsDir, "config.yaml"), configYaml);
    // 5. trajectory.jsonl — copy from logPath if it exists, otherwise write empty file
    const trajectoryPath = join(sessionsDir, "trajectory.jsonl");
    if (data.logPath) {
        try {
            await stat(data.logPath);
            await copyFile(data.logPath, trajectoryPath);
        }
        catch {
            // Log file doesn't exist or can't be read — write empty
            await writeFile(trajectoryPath, "");
        }
    }
    else {
        await writeFile(trajectoryPath, "");
    }
    return sessionsDir;
}
//# sourceMappingURL=session.js.map