#!/usr/bin/env node
/**
 * Cross-context `prepare` hook (revised 2026-04-22).
 *
 * npm / bun runs `prepare` in two very different situations:
 *
 *   1. **Local development checkout** — `npm install` inside mikro's own
 *      repo. husky is present as a devDependency; we want it to set up
 *      git hooks. The build step should also run so dist/ stays in
 *      sync with src/ for committers.
 *
 *   2. **Git-URL consumer install** — e.g.
 *      `bun add git+https://github.com/automagik-dev/mikro#<sha>`.
 *      The consumer's package manager may or may not run prepare
 *      (bun blocks trusted scripts by default), and devDependencies
 *      that `tsc` needs (like `@types/js-yaml`) may not be installed
 *      before prepare fires.
 *
 * New strategy: `dist/` is now committed to the git repo (see
 * `.gitignore` note). So consumer installs get a working dist
 * regardless of whether prepare fires. prepare's job becomes:
 *
 *   • husky setup when present (dev-only)
 *   • best-effort build — attempt, but DO NOT fail the install if
 *     build can't run (missing devDeps in consumer flows, husky
 *     untrusted-script block, etc.). The committed dist/ is the
 *     authoritative artifact consumers import; a failed local build
 *     doesn't stop them from using mikro.
 *
 * When the committer forgets to run `npm run build` before
 * committing src/ changes, CI catches it via the `check` script plus
 * the test suite (which executes `dist/tests/*.test.js`). So the
 * prepare hook being tolerant of build failures in consumer contexts
 * does not create a silent staleness hazard for the canonical repo
 * tree.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

function run(cmd, args, opts = {}) {
	const r = spawnSync(cmd, args, {
		stdio: "inherit",
		shell: process.platform === "win32",
		...opts,
	});
	return r.status ?? 1;
}

function runOptional(cmd, args) {
	const r = spawnSync(cmd, args, {
		stdio: ["ignore", "ignore", "ignore"],
		shell: process.platform === "win32",
	});
	return r.status === 0;
}

// 1. husky — dev git hooks. Silent fallthrough when missing
//    (consumer installs don't have husky as devDep).
runOptional("husky", []);

// `mikro update` and bin/mikro.mjs run `npm ci` and then build explicitly;
// building here as well would just double the work.
if (process.env.MIKRO_SKIP_PREPARE === "1") {
	process.exit(0);
}

// 2. Best-effort build. Failure is a warning, not a hard error — the
//    committed dist/ is the fallback. Consumers are NEVER blocked
//    from installing because our build couldn't resolve @types/js-yaml
//    or whatever transient devDep issue arises in their env.
const buildStatus = run("npm", ["run", "build"]);
if (buildStatus !== 0) {
	// Check whether dist/ actually exists — if it does, we're fine.
	const distPresent = existsSync("dist/src/index.js");
	if (distPresent) {
		console.warn(
			`[mikro prepare] build step failed (exit ${buildStatus}) but dist/src/index.js is present from the committed tree — continuing install. If you're a committer, run \`npm run build\` manually and commit dist/ before pushing.`,
		);
		process.exit(0);
	}
	console.error(
		`[mikro prepare] build failed (exit ${buildStatus}) and dist/ is missing. This is a genuine broken install. See build output above.`,
	);
	process.exit(buildStatus);
}
