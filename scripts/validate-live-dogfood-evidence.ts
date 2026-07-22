#!/usr/bin/env bun

/**
 * Structural validator for the post-release live-dogfood evidence file
 * (Group E deliverable 4). The post-release QA gate runs THIS validator, never a
 * "file exists and is nonempty" check: a candidate is only proven when every
 * field below is present and well-formed.
 *
 * The evidence Markdown must embed exactly two kinds of fenced ```json blocks:
 *
 *   1. one MANIFEST block — an object `{ "kind": "live-dogfood-evidence", ... }`:
 *      {
 *        "kind": "live-dogfood-evidence",
 *        "schemaVersion": 1,
 *        "candidate": { "commit": "<40-hex>", "version": "<MAJOR.YYMMDD.PATCH>", "channel": "homolog" },
 *        "inertness": {
 *          "codexPluginList": { "before": <snapshot>, "after": <snapshot> },
 *          "genieDoctor":     { "before": <snapshot>, "after": <snapshot> }
 *        },
 *        "steps": [ { "id": "...", "command": "...", "exit": <int>, "output": "..." }, ... ],
 *        "nNonGuarantee": "<explicit statement that retired N may be gone after activation>"
 *      }
 *      where <snapshot> = { "nIdentity": "...", "tIdentity": "...", "inventoryDigest": "<64-hex>" };
 *      before/after MUST be identical for each inertness pair (the query is inert).
 *      `steps` MUST carry, in this order, every ritual step id:
 *        n-task, update-delivery-exit2 (exit 2, output carries "deliveryComplete":true),
 *        n-resume-compact, external-setup-activation, doctor-json, hooks-review, new-n1-task.
 *
 *   2. exactly one DOCTOR block — the `genie doctor --json` payload; it is THE
 *      validated payload and must parse with `integrationSummary.state === 'current'`.
 *
 * The validator collects EVERY missing or invalid field, prints one per line, and
 * exits nonzero. An empty error list means the evidence is structurally sound.
 */

import { existsSync, readFileSync } from 'node:fs';

const RELEASE_VERSION = /^\d+\.\d{6}\.\d+$/;
const COMMIT_SHA = /^[0-9a-f]{40}$/;
const INVENTORY_DIGEST = /^[0-9a-f]{64}$/;

export const REQUIRED_STEP_IDS = [
  'n-task',
  'update-delivery-exit2',
  'n-resume-compact',
  'external-setup-activation',
  'doctor-json',
  'hooks-review',
  'new-n1-task',
] as const;

interface JsonBlock {
  value: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Extract every fenced ```json block as a parsed object; unparseable blocks become null. */
function extractJsonBlocks(markdown: string): Array<JsonBlock | null> {
  const blocks: Array<JsonBlock | null> = [];
  const pattern = /```json\s*\n([\s\S]*?)\n```/g;
  let match: RegExpExecArray | null = pattern.exec(markdown);
  while (match !== null) {
    try {
      const parsed: unknown = JSON.parse(match[1]);
      blocks.push(isRecord(parsed) ? { value: parsed } : null);
    } catch {
      blocks.push(null);
    }
    match = pattern.exec(markdown);
  }
  return blocks;
}

function validateSnapshot(errors: string[], label: string, snapshot: unknown): void {
  if (!isRecord(snapshot)) {
    errors.push(`inertness.${label} is not an object`);
    return;
  }
  if (typeof snapshot.nIdentity !== 'string' || snapshot.nIdentity.trim() === '') {
    errors.push(`inertness.${label}.nIdentity must be a non-empty string`);
  }
  if (typeof snapshot.tIdentity !== 'string' || snapshot.tIdentity.trim() === '') {
    errors.push(`inertness.${label}.tIdentity must be a non-empty string`);
  }
  if (typeof snapshot.inventoryDigest !== 'string' || !INVENTORY_DIGEST.test(snapshot.inventoryDigest)) {
    errors.push(`inertness.${label}.inventoryDigest must be 64 lowercase hex characters`);
  }
}

function validateInertnessPair(errors: string[], key: string, pair: unknown): void {
  if (!isRecord(pair) || !('before' in pair) || !('after' in pair)) {
    errors.push(`inertness.${key} must carry before and after snapshots`);
    return;
  }
  validateSnapshot(errors, `${key}.before`, pair.before);
  validateSnapshot(errors, `${key}.after`, pair.after);
  if (JSON.stringify(pair.before) !== JSON.stringify(pair.after)) {
    errors.push(`inertness.${key} is not inert: the query changed N/T identity or inventory digest`);
  }
}

function validateInertness(errors: string[], inertness: unknown): void {
  if (!isRecord(inertness)) {
    errors.push('manifest.inertness is missing or not an object');
    return;
  }
  for (const key of ['codexPluginList', 'genieDoctor']) {
    if (!(key in inertness)) {
      errors.push(`inertness.${key} is missing`);
      continue;
    }
    validateInertnessPair(errors, key, inertness[key]);
  }
}

function validateCandidate(errors: string[], candidate: unknown): void {
  if (!isRecord(candidate)) {
    errors.push('manifest.candidate is missing or not an object');
    return;
  }
  if (typeof candidate.commit !== 'string' || !COMMIT_SHA.test(candidate.commit)) {
    errors.push('candidate.commit must be a 40-character lowercase hex commit sha');
  }
  if (typeof candidate.version !== 'string' || !RELEASE_VERSION.test(candidate.version)) {
    errors.push('candidate.version must match the release grammar MAJOR.YYMMDD.PATCH');
  }
  if (candidate.channel !== 'homolog') {
    errors.push("candidate.channel must be 'homolog' (the canonical pre-stable candidate channel)");
  }
}

function validateStep(errors: string[], index: number, expectedId: string, step: unknown): void {
  if (!isRecord(step)) {
    errors.push(`steps[${index}] (${expectedId}) is not an object`);
    return;
  }
  if (step.id !== expectedId) {
    errors.push(`steps[${index}] must be '${expectedId}' (got ${JSON.stringify(step.id)}) — ritual order is fixed`);
  }
  if (typeof step.command !== 'string' || step.command.trim() === '') {
    errors.push(`steps[${index}] (${expectedId}).command must be a non-empty string`);
  }
  if (typeof step.exit !== 'number' || !Number.isInteger(step.exit)) {
    errors.push(`steps[${index}] (${expectedId}).exit must be an integer exit code`);
  }
  if (typeof step.output !== 'string' || step.output.trim() === '') {
    errors.push(`steps[${index}] (${expectedId}).output must be a non-empty captured output`);
  }
  if (expectedId === 'update-delivery-exit2') {
    if (step.exit !== 2) errors.push('steps update-delivery-exit2.exit must be 2 (delivered, action-required)');
    if (typeof step.output !== 'string' || !step.output.includes('"deliveryComplete":true')) {
      errors.push('steps update-delivery-exit2.output must carry the trailer field "deliveryComplete":true');
    }
  }
}

function validateSteps(errors: string[], steps: unknown): void {
  if (!Array.isArray(steps)) {
    errors.push('manifest.steps must be an array of ordered ritual steps');
    return;
  }
  if (steps.length !== REQUIRED_STEP_IDS.length) {
    errors.push(`manifest.steps must have exactly ${REQUIRED_STEP_IDS.length} ordered steps (got ${steps.length})`);
  }
  REQUIRED_STEP_IDS.forEach((expectedId, index) => {
    validateStep(errors, index, expectedId, steps[index]);
  });
}

function validateDoctorPayload(errors: string[], blocks: Array<JsonBlock | null>): void {
  const doctorBlocks = blocks.filter((block) => block !== null && isRecord(block.value.integrationSummary));
  if (doctorBlocks.length === 0) {
    // A json block that fails to parse OR lacks integrationSummary both surface here.
    errors.push('no embedded doctor JSON block with an integrationSummary object was found (must be exactly one)');
    return;
  }
  if (doctorBlocks.length > 1) {
    errors.push('more than one embedded doctor JSON block was found (must be exactly one validated payload)');
    return;
  }
  const summary = (doctorBlocks[0] as JsonBlock).value.integrationSummary as Record<string, unknown>;
  if (summary.state !== 'current') {
    errors.push(
      `embedded doctor JSON integrationSummary.state must be 'current' (got ${JSON.stringify(summary.state)})`,
    );
  }
}

/** Validate the evidence Markdown; returns a list of every structural failure (empty = valid). */
export function validateLiveDogfoodEvidence(markdown: string): string[] {
  const errors: string[] = [];
  const blocks = extractJsonBlocks(markdown);
  const manifests = blocks.filter((block) => block !== null && block.value.kind === 'live-dogfood-evidence');
  if (manifests.length === 0) {
    errors.push('no live-dogfood-evidence manifest json block found (must contain "kind":"live-dogfood-evidence")');
    // Still validate the doctor payload so the operator sees every gap at once.
    validateDoctorPayload(errors, blocks);
    return errors;
  }
  if (manifests.length > 1) {
    errors.push('more than one live-dogfood-evidence manifest json block found (must be exactly one)');
  }
  const manifest = (manifests[0] as JsonBlock).value;
  if (manifest.schemaVersion !== 1) errors.push('manifest.schemaVersion must be 1');
  validateCandidate(errors, manifest.candidate);
  validateInertness(errors, manifest.inertness);
  validateSteps(errors, manifest.steps);
  if (typeof manifest.nNonGuarantee !== 'string' || manifest.nNonGuarantee.trim().length < 20) {
    errors.push('manifest.nNonGuarantee must be an explicit statement that retired N may be gone after activation');
  }
  validateDoctorPayload(errors, blocks);
  return errors;
}

export function validateLiveDogfoodEvidenceFile(path: string): string[] {
  if (!existsSync(path)) return [`evidence file not found: ${path}`];
  return validateLiveDogfoodEvidence(readFileSync(path, 'utf8'));
}

function parseFileArg(argv: string[]): string {
  if (argv.length !== 2 || argv[0] !== '--file' || !argv[1]) {
    throw new Error('usage: bun scripts/validate-live-dogfood-evidence.ts --file <evidence.md>');
  }
  return argv[1];
}

function main(): void {
  let path: string;
  try {
    path = parseFileArg(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }
  const errors = validateLiveDogfoodEvidenceFile(path);
  if (errors.length > 0) {
    console.error(`validate-live-dogfood-evidence: FAIL (${errors.length}) — ${path}`);
    for (const error of errors) console.error(`  - ${error}`);
    process.exit(1);
  }
  console.log(`validate-live-dogfood-evidence: OK — ${path}`);
}

if (import.meta.main) main();
