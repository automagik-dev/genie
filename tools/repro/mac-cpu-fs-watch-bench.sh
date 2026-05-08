#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

cd "$REPO_ROOT"

BENCH_PROJECTS="${BENCH_PROJECTS:-125}"
BENCH_JSONLS_PER_PROJECT="${BENCH_JSONLS_PER_PROJECT:-8}"
BENCH_APPENDS="${BENCH_APPENDS:-50}"
BENCH_MAX_WAKEUPS_PER_SEC="${BENCH_MAX_WAKEUPS_PER_SEC:-4}"
BENCH_MAX_WAKEUPS="${BENCH_MAX_WAKEUPS:-3}"

BENCH_PROJECTS="$BENCH_PROJECTS" \
BENCH_JSONLS_PER_PROJECT="$BENCH_JSONLS_PER_PROJECT" \
BENCH_APPENDS="$BENCH_APPENDS" \
BENCH_MAX_WAKEUPS_PER_SEC="$BENCH_MAX_WAKEUPS_PER_SEC" \
BENCH_MAX_WAKEUPS="$BENCH_MAX_WAKEUPS" \
bun --eval '
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const projects = Number(process.env.BENCH_PROJECTS ?? 125);
const jsonlsPerProject = Number(process.env.BENCH_JSONLS_PER_PROJECT ?? 8);
const appends = Number(process.env.BENCH_APPENDS ?? 50);
const maxWakeupsPerSec = Number(process.env.BENCH_MAX_WAKEUPS_PER_SEC ?? 4);
const maxWakeups = Number(process.env.BENCH_MAX_WAKEUPS ?? 3);
const repoRoot = process.cwd();
const { createJsonlWatcher } = await import(pathToFileURL(join(repoRoot, "src/lib/session-filewatch.ts")).href);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForWatcherReady(watcher) {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("watcher did not become ready within 10s")), 10_000);
    watcher.once("ready", () => {
      clearTimeout(timer);
      resolve();
    });
    watcher.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

const tmpRoot = await mkdtemp(join(tmpdir(), "genie-filewatch-bench-"));
const projectsDir = join(tmpRoot, "projects");

try {
  await mkdir(projectsDir, { recursive: true });

  let hotPath = "";
  for (let projectIndex = 0; projectIndex < projects; projectIndex++) {
    const projectDir = join(projectsDir, `project-${String(projectIndex).padStart(4, "0")}`);
    await mkdir(projectDir, { recursive: true });

    for (let sessionIndex = 0; sessionIndex < jsonlsPerProject; sessionIndex++) {
      if (sessionIndex % 2 === 0) {
        const filePath = join(projectDir, `session-${sessionIndex}.jsonl`);
        await writeFile(filePath, "{\"type\":\"summary\"}\n");
        hotPath ||= filePath;
      } else {
        const subagentDir = join(projectDir, `parent-${sessionIndex}`, "subagents");
        await mkdir(subagentDir, { recursive: true });
        await writeFile(join(subagentDir, `child-${sessionIndex}.jsonl`), "{\"type\":\"summary\"}\n");
      }
    }
  }

  let wakeups = 0;
  const watcher = createJsonlWatcher(projectsDir, () => {
    wakeups++;
  });

  await waitForWatcherReady(watcher);

  const start = process.hrtime.bigint();
  for (let index = 0; index < appends; index++) {
    await appendFile(hotPath, `{"type":"assistant","index":${index}}\n`);
  }
  await sleep(1500);
  const elapsedSeconds = Number(process.hrtime.bigint() - start) / 1_000_000_000;

  await watcher.close();

  const wakeupsPerSec = wakeups / elapsedSeconds;
  const result = {
    projects,
    jsonls: projects * jsonlsPerProject,
    appends,
    wakeups,
    elapsed_seconds: Number(elapsedSeconds.toFixed(3)),
    wakeups_per_sec: Number(wakeupsPerSec.toFixed(3)),
    max_wakeups: maxWakeups,
    max_wakeups_per_sec: maxWakeupsPerSec,
  };
  console.log(JSON.stringify(result, null, 2));

  if (wakeups > maxWakeups || wakeupsPerSec > maxWakeupsPerSec) {
    console.error("[filewatch-bench] wakeup threshold exceeded");
    process.exit(1);
  }
} finally {
  await rm(tmpRoot, { recursive: true, force: true });
}
'
