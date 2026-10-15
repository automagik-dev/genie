#!/usr/bin/env node
// Repository-root authority only; consumers and nested projects own their locks.
import { existsSync, readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";

const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
function fail(field) {
  throw new Error(`${field}: npm-only check failed. Restore coherent package.json and npm v3 package-lock.json, remove competing root locks, then run npm run deps:ci.`);
}
function read(path) {
  let value;
  try { value = JSON.parse(readFileSync(path, "utf8")); }
  catch { fail(`${path} (missing or invalid JSON)`); }
  if (!object(value)) fail(`${path} (expected JSON object)`);
  return value;
}
try {
  const manifest = read("package.json");
  const lock = read("package-lock.json");
  if (lock.lockfileVersion !== 3) fail("package-lock.json.lockfileVersion (expected 3)");
  const root = lock.packages?.[""];
  if (!object(root)) fail('package-lock.json.packages[""] (expected object)');
  for (const field of ["name", "version"]) {
    if (manifest[field] !== lock[field]) fail(`package-lock.json.${field} != package.json.${field}`);
    if (manifest[field] !== root[field]) fail(`package-lock.json.packages[""].${field} != package.json.${field}`);
  }
  for (const field of ["dependencies", "devDependencies", "engines"]) {
    if (!isDeepStrictEqual(manifest[field] === undefined ? {} : manifest[field], root[field] === undefined ? {} : root[field])) {
      fail(`package-lock.json.packages[""].${field} != package.json.${field}`);
    }
  }
  for (const path of ["bun.lock", "bun.lockb", "yarn.lock", "pnpm-lock.yaml", "pnpm-lock.yml", "npm-shrinkwrap.json"]) {
    if (existsSync(path)) fail(path);
  }
} catch (error) {
  console.error(`mikro: ${error.message}`);
  process.exitCode = 1;
}
