import { execFile } from "node:child_process";
import { open, readdir, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, matchesGlob, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
const executeFile = promisify(execFile);
const MAX_BYTES = 256 * 1024;
const MAX_RESULTS = 1000;
const MAX_ENTRIES = 20000;
export const PI_TOOL_NAMES = ["read", "grep", "glob", "git", "emit_done"];
/** Pi never imports agent plugins or executes TOOLS.md Python functions. */
export function checkPiTools(agent, request) {
    const incompatible = agent?.spec.tools.filter((name) => !PI_TOOL_NAMES.some((allowed) => allowed === name)) ?? [];
    if (incompatible.length)
        return `pi engine cannot load declared plugins: ${incompatible.join(", ")}; use scoped read/grep/glob/git/emit_done or engine: rlm`;
    if (request.config.tools.length)
        return "pi engine cannot execute TOOLS.md functions; remove them or select engine: rlm";
    const gemini = request.config.gemini;
    if (gemini.googleSearch || gemini.urlContext || gemini.codeExecution || gemini.computerUse || gemini.mapsGrounding || gemini.fileSearch) {
        return "pi engine supports only scoped read/grep/glob/git/emit_done; disable provider-hosted tools or select engine: rlm";
    }
    if (agent?.spec.scope?.writes?.length)
        return "pi engine is read-only and cannot honor scope.writes";
    return undefined;
}
function within(root, target) {
    const rel = relative(root, target);
    return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}
/** All operations share this realpath policy, including discovered search targets and git paths. */
class ReadScope {
    cwd;
    roots;
    reads;
    excludes;
    credentials;
    explicitFile;
    constructor(cwd, roots, reads, excludes, credentials, explicitFile) {
        this.cwd = cwd;
        this.roots = roots;
        this.reads = reads;
        this.excludes = excludes;
        this.credentials = credentials;
        this.explicitFile = explicitFile;
    }
    static async create(agent, request) {
        const cwd = await realpath(request.cwd);
        const roots = [cwd];
        let explicitFile;
        if (request.contextRoot) {
            const lexical = resolve(request.contextRoot);
            const actual = await realpath(lexical);
            roots.push(actual);
            if ((await stat(actual)).isFile()) {
                explicitFile = { lexical, actual };
                if (typeof request.context?.content === "string")
                    explicitFile.snapshot = request.context.content;
            }
        }
        const credentials = new Set();
        const credentialFiles = [
            request.config.juice?.keyFile,
            ...(request.config.model.providers ?? []).map((provider) => provider.apiKeyFile),
        ];
        for (const file of credentialFiles) {
            if (!file)
                continue;
            const lexical = resolve(file);
            credentials.add(lexical);
            try {
                credentials.add(await realpath(lexical));
            }
            catch {
                // A currently absent credential reference is still lexically denied.
            }
        }
        return new ReadScope(cwd, roots, agent?.spec.scope?.reads, request.config.contextConfig.exclude, credentials, explicitFile);
    }
    excluded(target) {
        // Credential references win over explicit context, regardless of basename or symlink.
        if (this.credentials.has(target))
            return true;
        const explicit = target === this.explicitFile?.lexical || target === this.explicitFile?.actual;
        // A trusted explicit file may live beneath a hidden directory (facts handoff),
        // but a hidden basename such as .env remains denied.
        if (explicit && basename(target).startsWith("."))
            return true;
        const parts = relative(this.cwd, target).split(sep).filter((part) => part !== "..");
        return parts.some((part) => (!explicit && part.startsWith(".")) || part === "node_modules" ||
            /^(?:credentials|secrets?)(?:\.|$)/i.test(part) || /\.(?:pem|key|p12|pfx)$/i.test(part) ||
            this.excludes.some((pattern) => matchesGlob(part, pattern)));
    }
    allowed(target) {
        if (!this.roots.some((root) => within(root, target)) || this.excluded(target))
            return false;
        if (!this.reads)
            return true;
        return this.reads.some((pattern) => {
            const absolute = resolve(this.cwd, pattern);
            return matchesGlob(target, absolute) || (!/[?*\[\]{}]/.test(pattern) && within(absolute, target));
        });
    }
    async target(path) {
        const lexical = resolve(this.cwd, path);
        if (!this.allowed(lexical))
            throw new Error("read scope denied: path is outside the allowed roots, excluded, or outside scope.reads");
        const actual = await realpath(lexical);
        if (!this.allowed(actual))
            throw new Error("read scope denied: symlink target escapes the allowed read scope");
        return actual;
    }
    async text(path, signal) {
        signal?.throwIfAborted();
        const target = await this.target(path);
        if (!(await stat(target)).isFile())
            throw new Error("read expects a regular text file");
        if (target === this.explicitFile?.actual && this.explicitFile.snapshot !== undefined) {
            const text = this.explicitFile.snapshot;
            if (text.includes("\0"))
                throw new Error("binary files are not readable by Pi");
            return Buffer.byteLength(text) > MAX_BYTES
                ? `${Buffer.from(text).subarray(0, MAX_BYTES).toString("utf8")}\n[truncated at ${MAX_BYTES} bytes]`
                : text;
        }
        const file = await open(target, "r");
        try {
            const buffer = Buffer.alloc(MAX_BYTES + 1);
            const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
            signal?.throwIfAborted();
            if (buffer.subarray(0, bytesRead).includes(0))
                throw new Error("binary files are not readable by Pi");
            const text = buffer.subarray(0, Math.min(bytesRead, MAX_BYTES)).toString("utf8");
            return bytesRead > MAX_BYTES ? `${text}\n[truncated at ${MAX_BYTES} bytes]` : text;
        }
        finally {
            await file.close();
        }
    }
    async files(signal) {
        const files = new Set();
        const visited = new Set();
        let entries = 0;
        const walk = async (path) => {
            signal?.throwIfAborted();
            if (++entries > MAX_ENTRIES)
                throw new Error(`search exceeds ${MAX_ENTRIES} entries; narrow the declared roots`);
            let actual;
            try {
                actual = await realpath(path);
            }
            catch {
                return;
            }
            // Directories can be ancestors of a narrow scope; no contents are returned until a file passes allowed().
            if (!this.roots.some((root) => within(root, actual)) || this.excluded(path) || this.excluded(actual))
                return;
            const info = await stat(actual);
            if (info.isDirectory()) {
                if (visited.has(actual))
                    return;
                visited.add(actual);
                for (const entry of await readdir(actual))
                    await walk(join(actual, entry));
            }
            else if (info.isFile() && this.allowed(path) && this.allowed(actual))
                files.add(actual);
        };
        for (const root of this.roots)
            await walk(root);
        return [...files].sort();
    }
    async git(operation, revision, paths, signal) {
        signal?.throwIfAborted();
        if (revision !== undefined && (revision.includes("..") || !/^(?:HEAD(?:~[0-9]+)?|[0-9a-fA-F]{7,40}|[a-zA-Z0-9_][a-zA-Z0-9_./-]*)$/.test(revision))) {
            throw new Error("git revision must be a plain ref or commit; options, revision expressions and file lookups are not allowed");
        }
        const selected = paths?.length
            ? await Promise.all(paths.map((path) => this.target(path)))
            : await this.files(signal);
        if (paths?.length) {
            for (const path of selected) {
                if (!(await stat(path)).isFile())
                    throw new Error("git paths must name individual allowed files, not directories");
            }
        }
        if (selected.length > MAX_RESULTS)
            throw new Error("git path set too large; pass explicit scoped file paths");
        // Locate the physical checkout marker, never the config-declared worktree.
        // A nested cwd still authorizes only its own files, mapped relative to this root.
        let worktree = this.cwd;
        for (;;) {
            signal?.throwIfAborted();
            try {
                await stat(join(worktree, ".git"));
                break;
            }
            catch (error) {
                if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
                    throw error;
            }
            const parent = dirname(worktree);
            if (parent === worktree)
                throw new Error("git requires a physical checkout root");
            worktree = parent;
        }
        const scoped = selected.filter((path) => within(this.cwd, path)).map((path) => relative(worktree, path));
        if ((operation === "show" || operation === "diff") && !scoped.length)
            throw new Error("git content operations require scoped file paths");
        if (!scoped.length)
            return "";
        const base = ["--no-pager", "--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-c", "core.pager=cat", "-c", "diff.external=", "-c", "protocol.allow=never", "-c", "core.attributesFile=/dev/null", "-c", "log.showSignature=false", "-c", "core.quotePath=false"];
        let args;
        switch (operation) {
            case "status":
                args = ["status", "--short", "--no-renames", "--untracked-files=no", "--ignore-submodules=all", "--", ...scoped];
                break;
            case "log":
                args = ["log", "-20", "--no-notes", "--no-show-signature", "--format=%h %s", revision ?? "HEAD", "--", ...scoped];
                break;
            case "show":
                args = ["show", "--format=", "--no-notes", "--no-renames", "--no-ext-diff", "--no-textconv", "--ignore-submodules=all", revision ?? "HEAD", "--", ...scoped];
                break;
            case "diff":
                args = ["diff", "--no-renames", "--no-ext-diff", "--no-textconv", "--ignore-submodules=all", ...(revision ? [revision] : []), "--", ...scoped];
                break;
            case "ls-files":
                args = ["ls-files", "--", ...scoped];
                break;
            default: throw new Error("git supports only status, log, show, diff, ls-files");
        }
        // A fresh env intentionally drops GIT_CONFIG_*, executable helpers, aliases and operator config.
        const options = {
            cwd: worktree, signal, timeout: 10000, maxBuffer: MAX_BYTES,
            env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8", HOME: "/dev/null", XDG_CONFIG_HOME: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_COUNT: "0", GIT_ATTR_NOSYSTEM: "1", GIT_OPTIONAL_LOCKS: "0", GIT_LITERAL_PATHSPECS: "1", GIT_TERMINAL_PROMPT: "0", GIT_PAGER: "cat" },
        };
        // Pin both repository metadata and effective worktree; core.worktree must never
        // redirect a validated pathspec to another directory.
        const gitDir = (await executeFile("/usr/bin/git", [...base, `--work-tree=${worktree}`, "rev-parse", "--absolute-git-dir"], options)).stdout.trim();
        if (!isAbsolute(gitDir) || !(await stat(gitDir)).isDirectory())
            throw new Error("git repository metadata cannot be safely resolved");
        base.push(`--git-dir=${gitDir}`, `--work-tree=${worktree}`, "-c", "core.bare=false");
        // Git may invoke clean/process filters while comparing a worktree, even with
        // --no-ext-diff/--no-textconv. Discover only names (never values), then disable
        // every configured driver. Odd driver names fail closed rather than becoming argv.
        let filterNames = "";
        try {
            filterNames = (await executeFile("/usr/bin/git", [...base, "config", "--name-only", "--get-regexp", "^filter\\."], options)).stdout;
        }
        catch (error) {
            if (!(error !== null && typeof error === "object" && "code" in error && error.code === 1))
                throw error;
        }
        const drivers = new Set();
        for (const key of filterNames.trim().split("\n").filter(Boolean)) {
            if (!/^filter\.[A-Za-z0-9_.-]+\.[A-Za-z0-9-]+$/.test(key))
                throw new Error("git filter configuration cannot be safely isolated");
            drivers.add(key.slice(0, key.lastIndexOf(".")));
        }
        for (const driver of drivers) {
            base.push("-c", `${driver}.clean=`, "-c", `${driver}.smudge=`, "-c", `${driver}.process=`, "-c", `${driver}.required=false`);
        }
        const { stdout } = await executeFile("/usr/bin/git", [...base, ...args], options);
        return stdout;
    }
}
export async function createScopedPiTools(agent, request) {
    const scope = await ReadScope.create(agent, request);
    const textResult = (text) => ({ content: [{ type: "text", text: text.slice(0, MAX_BYTES) }], details: {} });
    return [
        defineTool({ name: "read", label: "Read", description: "Read a scoped text file, with optional one-based line range (maximum 1000 lines).", parameters: Type.Object({ path: Type.String({ minLength: 1 }), start: Type.Optional(Type.Integer({ minimum: 1 })), end: Type.Optional(Type.Integer({ minimum: 1 })) }), async execute(_id, params, signal) {
                const lines = (await scope.text(params.path, signal)).split("\n");
                const start = params.start ?? 1;
                const end = Math.min(params.end ?? start + 999, start + 999);
                if (end < start)
                    throw new Error("read end must not precede start");
                return textResult(lines.slice(start - 1, end).map((line, index) => `${start + index}: ${line}`).join("\n"));
            } }),
        defineTool({ name: "glob", label: "Glob", description: "Find allowed files by cwd-relative glob pattern; outputs at most 1000 paths.", parameters: Type.Object({ pattern: Type.String({ minLength: 1 }) }), async execute(_id, params, signal) {
                const files = await scope.files(signal);
                const matches = files.map((path) => relative(scope.cwd, path)).filter((path) => matchesGlob(path, params.pattern));
                return textResult(matches.slice(0, MAX_RESULTS).join("\n") + (matches.length > MAX_RESULTS ? "\n[results truncated]" : ""));
            } }),
        defineTool({ name: "grep", label: "Grep", description: "Literal, case-sensitive text search in allowed files; optional cwd-relative file glob. No executable regex or shell.", parameters: Type.Object({ text: Type.String({ minLength: 1 }), pattern: Type.Optional(Type.String({ minLength: 1 })) }), async execute(_id, params, signal) {
                const found = [];
                for (const path of await scope.files(signal)) {
                    const rel = relative(scope.cwd, path);
                    if (params.pattern && !matchesGlob(rel, params.pattern))
                        continue;
                    let text;
                    try {
                        text = await scope.text(path, signal);
                    }
                    catch (error) {
                        signal?.throwIfAborted();
                        if (error instanceof Error && error.message.includes("binary files"))
                            continue;
                        throw error;
                    }
                    for (const [index, line] of text.split("\n").entries()) {
                        if (line.includes(params.text))
                            found.push(`${rel}:${index + 1}: ${line}`);
                        if (found.length >= MAX_RESULTS)
                            return textResult(found.join("\n") + "\n[results truncated]");
                    }
                }
                return textResult(found.join("\n"));
            } }),
        defineTool({ name: "git", label: "Git", description: "Hermetic read-only repository status/log/show/diff/ls-files. No arbitrary options, shell, helpers or writes. Content is limited to allowed current file paths.", parameters: Type.Object({ operation: Type.Union([Type.Literal("status"), Type.Literal("log"), Type.Literal("show"), Type.Literal("diff"), Type.Literal("ls-files")]), revision: Type.Optional(Type.String()), paths: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { maxItems: MAX_RESULTS })) }), async execute(_id, params, signal) {
                return textResult(await scope.git(params.operation, params.revision, params.paths, signal));
            } }),
    ];
}
//# sourceMappingURL=pi-tools.js.map