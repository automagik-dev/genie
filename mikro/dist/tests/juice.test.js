import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, it } from "node:test";
import { fetchJuiceCatalog, fetchKeeperSnapshot, JuiceError, provisionJuiceProject, readPrivateKeyFile } from "../src/juice.js";
import { parseCustomProviders } from "../src/custom-providers.js";
import { createPiModelRuntime, llmComplete, LLMCompletionError, resolveModel } from "../src/llm.js";
const exec = promisify(execFile);
const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
async function fixture(handler) {
    const dir = await mkdtemp(join(tmpdir(), "mikro-juice-"));
    const server = createServer(async (req, res) => {
        const chunks = [];
        for await (const chunk of req)
            chunks.push(Buffer.from(chunk));
        handler(req, res, Buffer.concat(chunks).toString("utf8"));
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string")
        throw new Error("TCP fixture required");
    const origin = `http://127.0.0.1:${address.port}`;
    return { dir, origin,
        project(name) {
            return { origin, project: name, keyAlias: `${name}-key`, keyEpoch: "epoch-1", keyFile: join(dir, name, "key") };
        },
        async close() {
            server.closeAllConnections();
            await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
            await rm(dir, { recursive: true, force: true });
        },
    };
}
async function installKey(project, key) {
    await mkdir(join(project.keyFile, ".."), { mode: 0o700, recursive: true });
    await writeFile(project.keyFile, `${key}\n`, { mode: 0o600 });
}
function completion(res) {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", model: "advertised-control",
        choices: [{ index: 0, delta: { role: "assistant", content: "READY" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 } })}\n\ndata: [DONE]\n\n`);
}
describe("Juice project management and public invocation auth", () => {
    it("uses atomic additive PATCH and reuses the private key after HTTP failure and across CLI reruns", async () => {
        const keys = ["unrelated-existing-key"];
        let failNext = true;
        const local = await fixture((req, res, body) => {
            assert.equal(req.url, "/v0/management/api-keys");
            assert.equal(req.method, "PATCH");
            assert.equal(req.headers.authorization, "Bearer management-fixture");
            const parsed = JSON.parse(body);
            assert.ok(parsed && typeof parsed === "object" && "old" in parsed && "new" in parsed);
            assert.equal(parsed.old, parsed.new);
            assert.equal(typeof parsed.new, "string");
            if (failNext) {
                failNext = false;
                res.writeHead(503);
                res.end(body);
                return;
            }
            const key = String(parsed.new);
            if (!keys.includes(key))
                keys.push(key);
            res.writeHead(204);
            res.end();
        });
        try {
            const management = local.project("management");
            await installKey(management, "management-fixture");
            const project = local.project("genie");
            await assert.rejects(provisionJuiceProject(project, { keyFile: management.keyFile }), (error) => {
                assert.ok(error instanceof JuiceError);
                assert.equal(error.status, 503);
                assert.doesNotMatch(error.message, /management-fixture|sk-juice/);
                return true;
            });
            const firstKey = await readPrivateKeyFile(project.keyFile);
            const argv = [cli, "juice", "provision", "--origin", local.origin, "--project", project.project,
                "--key-alias", project.keyAlias, "--key-epoch", project.keyEpoch, "--key-file", project.keyFile,
                "--management-key-file", management.keyFile];
            for (let i = 0; i < 2; i++) {
                const { stdout, stderr } = await exec(process.execPath, argv, { env: { ...process.env, HOME: local.dir } });
                assert.equal(stderr, "");
                assert.equal(JSON.parse(stdout).project, "genie");
                assert.ok(!stdout.includes(firstKey) && !stdout.includes("management-fixture"));
            }
            assert.equal(await readPrivateKeyFile(project.keyFile), firstKey);
            assert.deepEqual(keys, ["unrelated-existing-key", firstKey]);
            assert.equal((await stat(join(local.dir, "genie"))).mode & 0o777, 0o700);
            assert.equal((await stat(project.keyFile)).mode & 0o777, 0o600);
        }
        finally {
            await local.close();
        }
    });
    it("rejects permissive and symlink key references before transmitting a credential", async () => {
        let calls = 0;
        const local = await fixture((_req, res) => { calls++; res.writeHead(204); res.end(); });
        try {
            const project = local.project("brain");
            await installKey(project, "private-fixture-key");
            await chmod(project.keyFile, 0o644);
            await assert.rejects(fetchJuiceCatalog(project), JuiceError);
            await chmod(project.keyFile, 0o600);
            const alias = join(local.dir, "brain", "alias");
            await symlink(project.keyFile, alias);
            await assert.rejects(fetchJuiceCatalog({ ...project, keyFile: alias }), JuiceError);
            await chmod(join(local.dir, "brain"), 0o755);
            await assert.rejects(fetchJuiceCatalog(project), JuiceError);
            assert.equal(calls, 0);
        }
        finally {
            await local.close();
        }
    });
    it("resolves keys per real SDK invocation for two independent projects and file rotation without global env mutation", async () => {
        const seen = [];
        const before = { ...process.env };
        const local = await fixture((req, res) => { seen.push(req.headers.authorization ?? ""); completion(res); });
        try {
            const a = local.project("genie");
            const b = local.project("brain");
            await installKey(a, "project-A-private");
            await installKey(b, "project-B-private");
            const model = (project) => ({ provider: "juice", model: "advertised-control",
                providers: parseCustomProviders({ juice: { "base-url": `${local.origin}/v1`, "api-key-file": project.keyFile,
                        models: { "advertised-control": { cost: { input: 1, output: 2 } } } } }, "fixture") });
            const configA = model(a);
            const configB = model(b);
            const results = await Promise.all([configA, configB].map((config) => llmComplete([{ role: "user", content: "fixture" }], config, { maxRetries: 0 })));
            assert.deepEqual(results.map((result) => result.text), ["READY", "READY"]);
            await writeFile(a.keyFile, "project-A-rotated\n", { mode: 0o600 });
            await llmComplete([{ role: "user", content: "fixture" }], configA, { maxRetries: 0 });
            const runtime = await createPiModelRuntime(configB);
            const result = await runtime.completeSimple(resolveModel("juice", "advertised-control", configB.providers), {
                messages: [{ role: "user", content: "Pi auth fixture", timestamp: 0 }],
            }, { maxRetries: 0 });
            assert.equal(result.stopReason, "stop");
            assert.deepEqual(seen.slice(0, 2).sort(), ["Bearer project-A-private", "Bearer project-B-private"]);
            assert.deepEqual(seen.slice(2), ["Bearer project-A-rotated", "Bearer project-B-private"]);
            const envUnchanged = Object.keys(process.env).length === Object.keys(before).length
                && Object.entries(before).every(([name, value]) => process.env[name] === value);
            assert.equal(envUnchanged, true, "project auth must not mutate environment values or keys");
            assert.doesNotMatch(JSON.stringify(configA), /project-A-private|project-A-rotated/);
        }
        finally {
            await local.close();
        }
    });
    it("does not disclose a reflected file credential in the real completion failure", async () => {
        const local = await fixture((req, res) => {
            res.writeHead(401, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: { message: `reflected ${req.headers.authorization?.slice(7)}` } }));
        });
        try {
            const project = local.project("genie");
            await installKey(project, "opaque-file-canary-98231");
            const config = { provider: "juice", model: "advertised-control", providers: parseCustomProviders({
                    juice: { "base-url": `${local.origin}/v1`, "api-key-file": project.keyFile, models: ["advertised-control"] },
                }, "fixture") };
            await assert.rejects(llmComplete([{ role: "user", content: "fixture" }], config, { maxRetries: 0 }), (error) => {
                assert.ok(error instanceof LLMCompletionError);
                assert.equal(error.stopReason, "error");
                assert.match(error.errorMessage, /diagnostic omitted/i);
                assert.doesNotMatch(error.message, /opaque-file-canary/);
                return true;
            });
        }
        finally {
            await local.close();
        }
    });
});
describe("manual viewer aggregates and catalog CLI", () => {
    it("authenticates only the project viewer, retains advertised IDs and provenance, redacts unknown costs, and logs out", async () => {
        const requests = [];
        const local = await fixture((req, res, body) => {
            requests.push(`${req.method} ${req.url}`);
            res.setHeader("Content-Type", "application/json");
            if (req.url === "/v1/models") {
                assert.equal(req.headers.authorization, "Bearer viewer-fixture");
                res.end(JSON.stringify({ data: [{ id: "literal-advertised/id", owned_by: "unknown-provider" }] }));
                return;
            }
            assert.equal(req.headers["x-cpa-usage-keeper-request"], "fetch");
            if (req.url === "/keeper/api/v1/auth/api-key-login") {
                assert.deepEqual(JSON.parse(body), { apiKey: "viewer-fixture" });
                res.setHeader("Set-Cookie", "cpa_usage_keeper_session=cookie-fixture; HttpOnly; Path=/keeper");
                res.end("{}");
                return;
            }
            assert.equal(req.headers.cookie, "cpa_usage_keeper_session=cookie-fixture");
            assert.equal(req.headers.authorization, undefined);
            if (req.url === "/keeper/api/v1/auth/session")
                res.end(JSON.stringify({ authenticated: true, role: "api_key_viewer" }));
            else if (req.url === "/keeper/api/v1/version")
                res.end(JSON.stringify({ version: "fixture-keeper-version" }));
            else if (req.url?.includes("key-overview"))
                res.end(JSON.stringify({ timezone: "UTC", usage: { total_tokens: 42 },
                    summary: { cost_available: false, total_cost: 0, daily_average_cost: 0, cookie: "cookie-fixture" }, series: { cost: [0] } }));
            else if (req.url?.includes("/latency"))
                res.end(JSON.stringify({ supported: false, unsupported_reason: "not available",
                    p95_latency_ms: 0, p95_ttft_ms: 0, points: [] }));
            else if (req.url?.includes("key-analysis"))
                res.end(JSON.stringify({ timezone: "UTC", range_start: "2026-10-04T00:00:00Z",
                    range_end: "2026-10-05T00:00:00Z", cost_breakdown: { cost_available: false, total_cost_usd: 0 },
                    model_composition: [{ key: "literal-advertised/id", cost_available: true, cost_usd: 0.25 }],
                    request_body: "private-body", auth_files_composition: ["private-auth"], api_key_composition: [{ key: "viewer-fixture" }] }));
            else if (req.url === "/keeper/api/v1/auth/logout") {
                res.writeHead(204);
                res.end();
            }
            else {
                res.writeHead(404);
                res.end();
            }
        });
        try {
            const project = local.project("genie");
            await installKey(project, "viewer-fixture");
            const common = ["--origin", local.origin, "--project", "genie", "--key-alias", project.keyAlias,
                "--key-epoch", project.keyEpoch, "--key-file", project.keyFile];
            const catalog = await exec(process.execPath, [cli, "juice", "catalog", ...common], { env: { ...process.env, HOME: local.dir } });
            assert.equal(catalog.stderr, "");
            assert.deepEqual(JSON.parse(catalog.stdout).models, [{ id: "literal-advertised/id", ownedBy: "unknown-provider" }]);
            const { stdout, stderr } = await exec(process.execPath, [cli, "juice", "analyze", ...common, "--range", "24h"], {
                env: { ...process.env, HOME: local.dir },
            });
            assert.equal(stderr, "");
            const snapshot = JSON.parse(stdout);
            assert.equal(snapshot.keeperVersion, "fixture-keeper-version");
            assert.equal(snapshot.project, "genie");
            assert.equal(snapshot.sources.length, 3);
            assert.equal(snapshot.sources[0].data.summary.total_cost, null);
            assert.equal(snapshot.sources[1].data.cost_breakdown.total_cost_usd, null);
            assert.equal(snapshot.sources[1].data.model_composition[0].cost_usd, 0.25);
            assert.equal(snapshot.sources[2].data.p95_latency_ms, null);
            assert.equal(snapshot.sources[2].timezone, null);
            assert.match(snapshot.contentSha256, /^[a-f0-9]{64}$/);
            assert.deepEqual(snapshot.capabilities, { aggregateUsage: true, requestEvents: false, payloadExport: false, canonicalBilling: false });
            assert.doesNotMatch(stdout, /viewer-fixture|cookie-fixture|private-body|private-auth/);
            assert.equal(requests.at(-1), "POST /keeper/api/v1/auth/logout");
            assert.ok(requests.every((request) => !request.includes("admin") && !request.includes("api_key_id") && !request.includes("events")));
        }
        finally {
            await local.close();
        }
    });
    it("never publishes reflected viewer credentials in aggregate keys, values, or provenance, including version", async () => {
        const key = "viewerReflectionFixture";
        const token = "opaqueReflectionFixture";
        const cookie = `cpa_usage_keeper_session=${token}`;
        let reflection = token;
        let reflectVersion = false;
        const requests = [];
        const local = await fixture((req, res) => {
            requests.push(req.url ?? "");
            res.setHeader("Content-Type", "application/json");
            if (req.url?.endsWith("api-key-login")) {
                res.setHeader("Set-Cookie", `${cookie}; HttpOnly; Path=/keeper`);
                res.end("{}");
            }
            else {
                assert.equal(req.headers.cookie, cookie);
                assert.equal(req.headers.authorization, undefined);
                if (req.url?.endsWith("auth/session"))
                    res.end(JSON.stringify({ authenticated: true, role: "api_key_viewer" }));
                else if (req.url?.endsWith("/version"))
                    res.end(JSON.stringify({ version: reflectVersion ? reflection : "fixture-version" }));
                else if (req.url?.endsWith("auth/logout")) {
                    res.writeHead(204);
                    res.end();
                }
                else {
                    const provenance = { timezone: reflection, range_start: reflection, range_end: reflection };
                    if (req.url?.includes("key-overview"))
                        res.end(JSON.stringify({ ...provenance, usage: { total_tokens: 1 },
                            summary: { label: reflection }, series: { [token]: [1], label: reflection } }));
                    else if (req.url?.includes("/latency"))
                        res.end(JSON.stringify({ ...provenance, supported: false,
                            unsupported_reason: reflection, points: [] }));
                    else
                        res.end(JSON.stringify({ ...provenance, granularity: reflection,
                            cost_breakdown: {}, model_composition: [{ label: reflection }] }));
                }
            }
        });
        try {
            const project = local.project("reflection");
            await installKey(project, key);
            const argv = [cli, "juice", "analyze", "--origin", local.origin, "--project", project.project,
                "--key-alias", project.keyAlias, "--key-epoch", project.keyEpoch, "--key-file", project.keyFile, "--range", "today"];
            for (const credential of [key, cookie, token]) {
                reflection = credential;
                const { stdout, stderr } = await exec(process.execPath, argv, { env: { ...process.env, HOME: local.dir } });
                assert.equal(stderr, "");
                for (const secret of [key, cookie, token])
                    assert.equal(stdout.includes(secret), false);
                const snapshot = JSON.parse(stdout);
                assert.equal(snapshot.keeperVersion, "fixture-version");
                assert.equal(snapshot.sources.length, 3);
                for (const source of snapshot.sources) {
                    assert.equal(source.timezone, null);
                    assert.equal(source.rangeStart, null);
                    assert.equal(source.rangeEnd, null);
                }
                assert.equal(snapshot.sources[0].data.summary.label, null);
                assert.deepEqual(snapshot.sources[0].data.series, { label: null });
                assert.equal(snapshot.sources[1].data.granularity, null);
                assert.equal(snapshot.sources[2].data.unsupported_reason, null);
                assert.equal(requests.at(-1), "/keeper/api/v1/auth/logout");
            }
            reflectVersion = true;
            for (const credential of [key, cookie, token]) {
                reflection = credential;
                const start = requests.length;
                await assert.rejects(exec(process.execPath, argv, { env: { ...process.env, HOME: local.dir } }), (error) => {
                    assert.ok(error instanceof Error && "code" in error && "stdout" in error && "stderr" in error);
                    assert.equal(error.code, 1);
                    assert.equal(error.stdout, "");
                    assert.match(String(error.stderr), /Juice operation failed \(response\)/);
                    for (const secret of [key, cookie, token])
                        assert.equal(String(error.stderr).includes(secret), false);
                    return true;
                });
                assert.deepEqual(requests.slice(start), ["/keeper/api/v1/auth/api-key-login", "/keeper/api/v1/auth/session",
                    "/keeper/api/v1/version", "/keeper/api/v1/auth/logout"]);
            }
        }
        finally {
            await local.close();
        }
    });
    it("honors both manual help aliases without reading config or credentials, requesting, or mutating files", async () => {
        let calls = 0;
        const local = await fixture((_req, res) => { calls++; res.writeHead(503); res.end(); });
        try {
            await mkdir(join(local.dir, ".mikro"));
            const config = join(local.dir, ".mikro", "mikro.yaml");
            const settings = join(local.dir, ".mikro", "settings.json");
            await writeFile(config, "invalid: [");
            await writeFile(settings, "{invalid");
            const before = await readdir(local.dir, { recursive: true });
            const configBefore = await stat(config);
            const settingsBefore = await stat(settings);
            for (const alias of ["--help", "-h"]) {
                for (const args of [
                    ["juice", "catalog", "--dir", local.dir],
                    ["juice", "provision", "--origin", local.origin, "--management-key-file", join(local.dir, "missing-management-key")],
                    ["jev", "--endpoint", `${local.origin}/v1/systemone`, "--key-file", join(local.dir, "missing-key"),
                        "--input", join(local.dir, "missing-input")],
                ]) {
                    const { stdout, stderr } = await exec(process.execPath, [cli, ...args, alias], {
                        cwd: local.dir, env: { ...process.env, HOME: local.dir },
                    });
                    assert.match(stdout, args[0] === "juice" ? /mikro juice/ : /mikro jev/);
                    assert.equal(stderr, "");
                }
            }
            assert.equal(calls, 0);
            assert.deepEqual(await readdir(local.dir, { recursive: true }), before);
            assert.equal(await readFile(config, "utf8"), "invalid: [");
            assert.equal(await readFile(settings, "utf8"), "{invalid");
            assert.equal((await stat(config)).mtimeMs, configBefore.mtimeMs);
            assert.equal((await stat(settings)).mtimeMs, settingsBefore.mtimeMs);
        }
        finally {
            await local.close();
        }
    });
    it("logs out after viewer error and reports only status; CLI invalid flags have nonzero exit and stderr", async () => {
        const requests = [];
        const local = await fixture((req, res) => {
            requests.push(req.url ?? "");
            if (req.url?.endsWith("api-key-login")) {
                res.setHeader("Set-Cookie", "cpa_usage_keeper_session=error-cookie; Path=/keeper");
                res.end("{}");
            }
            else if (req.url?.endsWith("auth/session")) {
                res.setHeader("Content-Type", "application/json");
                res.end(JSON.stringify({ authenticated: true, role: "api_key_viewer" }));
            }
            else if (req.url?.endsWith("auth/logout")) {
                res.writeHead(204);
                res.end();
            }
            else {
                res.writeHead(403);
                res.end("viewer-key error-cookie private-response");
            }
        });
        try {
            const project = local.project("brain");
            await installKey(project, "viewer-key");
            await assert.rejects(fetchKeeperSnapshot(project, { range: "today" }, false), (error) => {
                assert.ok(error instanceof JuiceError);
                assert.equal(error.status, 403);
                assert.doesNotMatch(error.message, /viewer-key|error-cookie|private-response/);
                return true;
            });
            assert.equal(requests.at(-1), "/keeper/api/v1/auth/logout");
            await assert.rejects(exec(process.execPath, [cli, "juice", "usage", "--api-key", "argv-canary"], {
                env: { ...process.env, HOME: local.dir },
            }), (error) => {
                assert.ok(error instanceof Error && "code" in error && "stderr" in error && "stdout" in error);
                assert.equal(error.code, 1);
                assert.equal(error.stdout, "");
                assert.match(String(error.stderr), /Juice operation failed/);
                assert.doesNotMatch(String(error.stderr), /argv-canary/);
                return true;
            });
        }
        finally {
            await local.close();
        }
    });
});
describe("project config and viewer error boundaries", () => {
    it("loads a reference-only project via CLI config and rejects mismatched providers and repository key storage", async () => {
        let calls = 0;
        const local = await fixture((req, res) => {
            calls++;
            assert.equal(req.headers.authorization, "Bearer configured-fixture");
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ data: [{ id: "advertised-control", owned_by: "fixture-owner" }] }));
        });
        try {
            const project = local.project("config-key");
            await installKey(project, "configured-fixture");
            const repo = join(local.dir, "repo");
            await mkdir(join(repo, ".mikro"), { recursive: true });
            const config = { juice: { origin: local.origin, project: "genie", "key-alias": "genie-key",
                    "key-epoch": "epoch-1", "key-file": project.keyFile }, model: { provider: "juice", model: "advertised-control" },
                providers: { juice: { "base-url": `${local.origin}/v1`, models: ["advertised-control"] } } };
            const path = join(repo, ".mikro", "mikro.yaml");
            await writeFile(path, JSON.stringify(config));
            const argv = [cli, "juice", "catalog", "--dir", repo];
            const success = await exec(process.execPath, argv, { env: { ...process.env, HOME: local.dir } });
            assert.equal(success.stderr, "");
            assert.equal(JSON.parse(success.stdout).project, "genie");
            await writeFile(path, JSON.stringify({ ...config, providers: { juice: { ...config.providers.juice, "base-url": "https://other.example/v1" } } }));
            await assert.rejects(exec(process.execPath, argv, { env: { ...process.env, HOME: local.dir } }), (error) => {
                assert.ok(error instanceof Error && "code" in error && "stderr" in error);
                assert.equal(error.code, 1);
                assert.doesNotMatch(String(error.stderr), /configured-fixture/);
                return true;
            });
            assert.equal(calls, 1);
            await mkdir(join(repo, ".git"));
            const forbidden = { ...project, keyFile: join(repo, ".ignored-private", "project.key") };
            await assert.rejects(provisionJuiceProject(forbidden, { keyFile: project.keyFile }), JuiceError);
            await assert.rejects(stat(join(repo, ".ignored-private")), { code: "ENOENT" });
            assert.equal(calls, 1);
        }
        finally {
            await local.close();
        }
    });
    it("fails closed on admin sessions, malformed aggregates and logout failure without yielding success", async () => {
        let mode = "admin";
        const requests = [];
        const local = await fixture((req, res) => {
            requests.push(req.url ?? "");
            res.setHeader("Content-Type", "application/json");
            if (req.url?.endsWith("api-key-login")) {
                res.setHeader("Set-Cookie", "cpa_usage_keeper_session=boundary-cookie; Path=/keeper");
                res.end("{}");
            }
            else if (req.url?.endsWith("auth/session"))
                res.end(JSON.stringify({ authenticated: true,
                    role: mode === "admin" ? "admin" : "api_key_viewer" }));
            else if (req.url?.endsWith("version"))
                res.end(JSON.stringify({ version: "fixture-version" }));
            else if (req.url?.includes("key-overview"))
                res.end(mode === "malformed" ? "{}" : JSON.stringify({
                    usage: { total_tokens: 1 }, summary: { cost_available: true, total_cost: 0.5 }, series: { cost: [0.5] }, timezone: "UTC",
                }));
            else if (req.url?.endsWith("auth/logout")) {
                res.writeHead(mode === "logout" ? 503 : 204);
                res.end();
            }
            else {
                res.writeHead(404);
                res.end();
            }
        });
        try {
            const project = local.project("viewer");
            await installKey(project, "boundary-viewer");
            for (const scenario of ["admin", "malformed", "logout"]) {
                mode = scenario;
                requests.length = 0;
                await assert.rejects(fetchKeeperSnapshot(project, { range: "today" }, false), JuiceError);
                assert.equal(requests.at(-1), "/keeper/api/v1/auth/logout");
                if (scenario === "admin")
                    assert.equal(requests.length, 3, "no version or aggregate request after wrong-role admission");
            }
        }
        finally {
            await local.close();
        }
    });
});
describe("manual configured JEV CLI", () => {
    it("makes one explicit call with same-call questions and reattaches the source-linked snapshot", async () => {
        let calls = 0;
        let received;
        const local = await fixture((req, res, body) => {
            calls++;
            assert.equal(req.url, "/v1/systemone");
            assert.equal(req.headers.authorization, "Bearer jev-private-fixture");
            received = JSON.parse(body);
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ model: "jev-1.13.0", answers: {
                    selection: { type: "choice", choice: "alpha", probabilities: { alpha: 0.9, abstain: 0.1 }, confidence: 0.9 },
                    noul: { type: "noul", noul: 0.8 },
                    score: { type: "score", score: 0.8, legend: { "0": "bad", "1": "good" },
                        probabilities: { "0": 0.2, "1": 0.8 }, confidence: 0.8 },
                }, usage: { input_tokens: 12, output_tokens: 5 } }));
        });
        try {
            const auth = local.project("jev");
            await installKey(auth, "jev-private-fixture");
            const input = join(local.dir, "sanitized.json");
            const snapshot = { sanitized: true, state: "public source facts", candidates: [
                    { id: "alpha", text: "exact multiline\ncandidate", source: "public-source#lines-2-3" },
                ], noul: { instructions: "Is evidence sufficient?" }, score: { instructions: "Rate support", criteria: ["bad", "good"] } };
            await writeFile(input, JSON.stringify(snapshot));
            const { stdout, stderr } = await exec(process.execPath, [cli, "jev", "--endpoint", `${local.origin}/v1/systemone`,
                "--model", "jev-1.13.0", "--key-file", auth.keyFile, "--input", input], { env: { ...process.env, HOME: local.dir } });
            assert.equal(stderr, "");
            const result = JSON.parse(stdout);
            assert.equal(calls, 1);
            assert.ok(received && typeof received === "object" && "state" in received && "questions" in received);
            assert.equal(received.state, snapshot.state);
            assert.ok(received.questions && typeof received.questions === "object");
            assert.deepEqual(Object.keys(received.questions), ["selection", "noul", "score"]);
            assert.equal(result.selection.candidate.text, "exact multiline\ncandidate");
            assert.equal(result.selection.candidate.source, "public-source#lines-2-3");
            assert.equal(result.sourceSnapshot.sourceFile, input);
            assert.equal(result.sourceSnapshot.state, snapshot.state);
            assert.match(result.sourceSnapshot.contentSha256, /^[a-f0-9]{64}$/);
            assert.deepEqual(result.usage, { input_tokens: 12, output_tokens: 5 });
            assert.doesNotMatch(stdout, /jev-private-fixture/);
            assert.equal(await readFile(input, "utf8"), JSON.stringify(snapshot));
        }
        finally {
            await local.close();
        }
    });
    it("rejects unsafe input and reports only HTTP status without retries or source mutation", async () => {
        let calls = 0;
        const local = await fixture((_req, res) => { calls++; res.writeHead(503); res.end("jev-private-fixture response-canary"); });
        try {
            const auth = local.project("jev");
            await installKey(auth, "jev-private-fixture");
            const input = join(local.dir, "input.json");
            const argv = [cli, "jev", "--endpoint", `${local.origin}/v1/systemone`, "--model", "jev-1.13.0",
                "--key-file", auth.keyFile, "--input", input];
            const reject = async () => {
                await assert.rejects(exec(process.execPath, argv, { env: { ...process.env, HOME: local.dir } }), (error) => {
                    assert.ok(error instanceof Error && "code" in error && "stdout" in error && "stderr" in error);
                    assert.equal(error.code, 1);
                    assert.equal(error.stdout, "");
                    assert.match(String(error.stderr), /JEV extraction failed/);
                    assert.doesNotMatch(String(error.stderr), /jev-private-fixture|response-canary/);
                    return true;
                });
            };
            const valid = { sanitized: true, state: "public state", candidates: [{ id: "alpha", text: "candidate", source: "public-source#1" }] };
            const unsafe = [
                JSON.stringify({ ...valid, sanitized: false }),
                JSON.stringify({ ...valid, state: "jev-private-fixture" }),
                JSON.stringify({ ...valid, state: { apiKey: "other-secret" } }),
                JSON.stringify({ ...valid, state: [{ nested: ["jev-private-fixture"] }] })
                    .replace("jev-private-fixture", "\\u006aev-private-fixture"),
                JSON.stringify({ ...valid, state: { apiKey: "other-secret" } }).replace("apiKey", "api\\u004bey"),
                JSON.stringify({ ...valid, state: { "jev-private-fixture": "public" } })
                    .replace("jev-private-fixture", "\\u006aev-private-fixture"),
                JSON.stringify({ ...valid, candidates: [{ ...valid.candidates[0], source: "jev-private-fixture" }] })
                    .replace("jev-private-fixture", "\\u006aev-private-fixture"),
                JSON.stringify({ ...valid, candidates: [{ ...valid.candidates[0], text: "bearer other-local-token" }] })
                    .replace("bearer", "be\\u0061rer"),
                JSON.stringify({ ...valid, candidates: [{ ...valid.candidates[0], cookie: "other-secret" }] })
                    .replace("cookie", "coo\\u006bie"),
                JSON.stringify({ ...valid, noul: { instructions: "sk-localfixture1234" } })
                    .replace("sk-localfixture1234", "\\u0073k-localfixture1234"),
                JSON.stringify({ ...valid, noul: { instructions: "public", criteria: { true: "jev-private-fixture" } } })
                    .replace("jev-private-fixture", "\\u006aev-private-fixture"),
                JSON.stringify({ ...valid, score: { instructions: "jev-private-fixture", criteria: ["bad", "good"] } })
                    .replace("jev-private-fixture", "\\u006aev-private-fixture"),
                JSON.stringify({ ...valid, score: { instructions: "public", criteria: ["jev-private-fixture", "good"] } })
                    .replace("jev-private-fixture", "\\u006aev-private-fixture"),
            ];
            for (const text of unsafe) {
                await writeFile(input, text);
                const filesBefore = await readdir(local.dir, { recursive: true });
                const inputBefore = await stat(input);
                const keyBefore = await stat(auth.keyFile);
                await reject();
                assert.equal(calls, 0);
                assert.equal(await readFile(input, "utf8"), text);
                assert.equal(await readFile(auth.keyFile, "utf8"), "jev-private-fixture\n");
                assert.equal((await stat(input)).mtimeMs, inputBefore.mtimeMs);
                assert.equal((await stat(auth.keyFile)).mtimeMs, keyBefore.mtimeMs);
                assert.deepEqual(await readdir(local.dir, { recursive: true }), filesBefore);
            }
            assert.equal(calls, 0);
            await writeFile(input, JSON.stringify(valid));
            await reject();
            assert.equal(calls, 1);
            assert.equal(await readFile(input, "utf8"), JSON.stringify(valid));
        }
        finally {
            await local.close();
        }
    });
});
//# sourceMappingURL=juice.test.js.map