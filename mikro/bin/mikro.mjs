#!/usr/bin/env node
// Keep this entry point dependency-free, including the update path: importing
// the CLI before recovery can load modules from a partially installed tree.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { launch, runManaged } from "./install-state.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
try {
  const status = args[0] === "update" ? await runManaged(root, "update", args) : await launch(root, args);
  if (status !== 0) process.exitCode = status;
} catch (error) {
  console.error(`mikro error: ${error.message}`);
  process.exitCode = error.exitCode ?? 1;
}
