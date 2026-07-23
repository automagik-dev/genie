#!/usr/bin/env bun

/**
 * Fail-closed validator for one reusable Codex dogfood matrix entry.
 *
 * Schema v2 binds a real N -> T lifecycle to the exact release inputs, delivery
 * record, two seeded repositories, child CWD identities, ordered command
 * stages, and the production doctor JSON topology. The manifest and doctor
 * payload are separate fenced JSON blocks in the evidence Markdown.
 */

import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { compareReleaseVersions, parseReleaseVersion } from '../src/lib/codex-release-version.ts';

export const LIVE_DOGFOOD_SCHEMA_VERSION = 2 as const;
export const REQUIRED_STAGE_IDS = [
  'seed-repositories',
  'n-parent-active',
  't-delivery-repair',
  'activation-consent',
  'assets-converged',
  'untouched-b-before-init',
  'untouched-b-after-init',
  'new-thread-sentinel',
  'doctor-current',
] as const;

const RELEASE_VERSION = /^\d+\.\d{6}\.\d+$/;
const COMMIT_SHA = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const DELIVERY_ID = /^[0-9a-f]{32}$/;
const DIRECTORY_IDENTITY = /^\d+:\d+$/;
const SENTINEL_TOKEN = /^[0-9a-f]{32,}$/;
const PLATFORM_TRIPLES = {
  'linux-x64-glibc': 'linux-x64',
  'linux-x64-musl': 'linux-x64',
  'linux-arm64': 'linux-arm64',
  'darwin-arm64': 'darwin-arm64',
} as const;
const REPOSITORY = 'automagik-dev/genie';
const PREDICATE_TYPE = 'https://github.com/automagik-dev/genie/delivery-evidence/v1';
const WORKFLOW_IDENTITY =
  'https://github.com/automagik-dev/genie/.github/workflows/release-publish.yml@refs/heads/main';
const OIDC_ISSUER = 'https://token.actions.githubusercontent.com';
const LEGACY_PREDICATE_TYPE = 'https://slsa.dev/provenance/v0.2';
const LEGACY_WORKFLOW_IDENTITY =
  'https://github.com/slsa-framework/slsa-github-generator/.github/workflows/generator_generic_slsa3.yml@refs/tags/v2.1.0';

type JsonRecord = Record<string, unknown>;
interface JsonBlock {
  value: JsonRecord;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function extractJsonBlocks(markdown: string): Array<JsonBlock | null> {
  const blocks: Array<JsonBlock | null> = [];
  const pattern = /```json\s*\n([\s\S]*?)\n```/g;
  for (let match = pattern.exec(markdown); match !== null; match = pattern.exec(markdown)) {
    try {
      const parsed: unknown = JSON.parse(match[1]);
      blocks.push(isRecord(parsed) ? { value: parsed } : null);
    } catch {
      blocks.push(null);
    }
  }
  return blocks;
}

function record(errors: string[], label: string, value: unknown): JsonRecord | null {
  if (isRecord(value)) return value;
  errors.push(`${label} must be an object`);
  return null;
}

function nonempty(errors: string[], label: string, value: unknown): value is string {
  if (typeof value === 'string' && value.trim() !== '') return true;
  errors.push(`${label} must be a non-empty string`);
  return false;
}

function matches(
  errors: string[],
  label: string,
  value: unknown,
  pattern: RegExp,
  expectation: string,
): value is string {
  if (typeof value === 'string' && pattern.test(value)) return true;
  errors.push(`${label} must be ${expectation}`);
  return false;
}

function absolute(errors: string[], label: string, value: unknown): value is string {
  if (typeof value === 'string' && isAbsolute(value) && !value.includes('\0')) return true;
  errors.push(`${label} must be an absolute path`);
  return false;
}

function portableInput(errors: string[], label: string, value: unknown, generation: string): value is string {
  if (
    typeof value === 'string' &&
    value.startsWith(`${generation}/`) &&
    !isAbsolute(value) &&
    !value.includes('\\') &&
    !value.split('/').includes('..') &&
    value.split('/').length === 2 &&
    value.split('/')[1] !== ''
  ) {
    return true;
  }
  errors.push(`${label} must be a portable ${generation}/<filename> reference`);
  return false;
}

function portableObservation(errors: string[], label: string, value: unknown, stageId: string): value is string {
  if (value === `observations/${stageId}.json`) return true;
  errors.push(`${label} must be observations/${stageId}.json`);
  return false;
}

function same(errors: string[], label: string, actual: unknown, expected: unknown): void {
  if (actual !== expected)
    errors.push(`${label} must equal ${JSON.stringify(expected)} (got ${JSON.stringify(actual)})`);
}

function validateEntry(errors: string[], value: unknown): JsonRecord | null {
  const entry = record(errors, 'manifest.entry', value);
  if (entry === null) return null;
  nonempty(errors, 'entry.id', entry.id);
  if (!['host-native', 'verified-local-fixture'].includes(String(entry.evidenceKind))) {
    errors.push("entry.evidenceKind must be 'host-native' or 'verified-local-fixture'");
  }
  same(errors, 'entry.availability', entry.availability, 'verified');
  const platformId = entry.platformId;
  if (typeof platformId !== 'string' || !(platformId in PLATFORM_TRIPLES)) {
    errors.push('entry.platformId must name a supported release platform');
  } else {
    same(
      errors,
      'entry.platformTriple',
      entry.platformTriple,
      PLATFORM_TRIPLES[platformId as keyof typeof PLATFORM_TRIPLES],
    );
  }
  nonempty(errors, 'entry.artifactName', entry.artifactName);
  const inputs = record(errors, 'entry.inputs', entry.inputs);
  for (const generation of ['previous', 'candidate'] as const) {
    const input = record(errors, `entry.inputs.${generation}`, inputs?.[generation]);
    same(
      errors,
      `entry.inputs.${generation}.identityKind`,
      input?.identityKind,
      generation === 'previous' ? 'slsa-provenance' : 'delivery-descriptor',
    );
    for (const key of ['artifact', 'manifest', 'identity', 'bundle']) {
      portableInput(errors, `entry.inputs.${generation}.${key}`, input?.[key], generation);
    }
  }
  return entry;
}

function validateProvenance(errors: string[], label: string, value: unknown, commit: unknown, channel: unknown): void {
  const provenance = record(errors, label, value);
  if (provenance === null) return;
  same(errors, `${label}.repository`, provenance.repository, REPOSITORY);
  if (provenance.kind === 'release-tarball') {
    same(errors, `${label}.predicateType`, provenance.predicateType, LEGACY_PREDICATE_TYPE);
    same(errors, `${label}.workflowIdentity`, provenance.workflowIdentity, LEGACY_WORKFLOW_IDENTITY);
  } else if (provenance.kind === 'delivery-evidence') {
    same(errors, `${label}.predicateType`, provenance.predicateType, PREDICATE_TYPE);
    same(errors, `${label}.workflowIdentity`, provenance.workflowIdentity, WORKFLOW_IDENTITY);
  } else {
    errors.push(`${label}.kind must be 'release-tarball' or 'delivery-evidence'`);
  }
  same(errors, `${label}.oidcIssuer`, provenance.oidcIssuer, OIDC_ISSUER);
  if (commit === undefined) {
    matches(
      errors,
      `${label}.sourceCommit`,
      provenance.sourceCommit,
      COMMIT_SHA,
      'a 40-character lowercase commit sha',
    );
  } else {
    same(errors, `${label}.sourceCommit`, provenance.sourceCommit, commit);
  }
  matches(
    errors,
    `${label}.controlCommit`,
    provenance.controlCommit,
    COMMIT_SHA,
    'a 40-character lowercase commit sha',
  );
  if (channel === 'stable') same(errors, `${label}.sourceBranch`, provenance.sourceBranch, 'main');
  else same(errors, `${label}.sourceBranch`, provenance.sourceBranch, channel);
  if (typeof provenance.sourceCiRunId !== 'string' || !/^(?:0|[1-9]\d*)$/.test(provenance.sourceCiRunId)) {
    errors.push(`${label}.sourceCiRunId must be an unsigned decimal string`);
  }
  for (const key of ['identitySha256', 'bundleSha256']) {
    matches(errors, `${label}.${key}`, provenance[key], SHA256, '64 lowercase hex characters');
  }
}

function validateArtifact(
  errors: string[],
  label: string,
  value: unknown,
  expectedVersion: unknown,
  entry: JsonRecord | null,
  commit: unknown,
  channel: unknown,
): JsonRecord | null {
  const artifact = record(errors, label, value);
  if (artifact === null) return null;
  same(errors, `${label}.version`, artifact.version, expectedVersion);
  if (channel === undefined) {
    if (!['stable', 'homolog', 'dev'].includes(String(artifact.channel))) {
      errors.push(`${label}.channel must be stable, homolog, or dev`);
    }
  } else {
    same(errors, `${label}.channel`, artifact.channel, channel);
  }
  same(errors, `${label}.platformId`, artifact.platformId, entry?.platformId);
  same(errors, `${label}.platformTriple`, artifact.platformTriple, entry?.platformTriple);
  same(errors, `${label}.releaseTag`, artifact.releaseTag, `v${String(expectedVersion)}`);
  same(
    errors,
    `${label}.releaseName`,
    artifact.releaseName,
    `genie-${String(expectedVersion)}-${String(entry?.platformId)}.tar.gz`,
  );
  for (const key of ['manifestSha256', 'artifactSha256', 'binarySha256', 'payloadSha256', 'evidenceDigest']) {
    matches(errors, `${label}.${key}`, artifact[key], SHA256, '64 lowercase hex characters');
  }
  validateProvenance(errors, `${label}.provenance`, artifact.provenance, commit, artifact.channel);
  return artifact;
}

function validateDelivery(
  errors: string[],
  value: unknown,
  lifecycle: JsonRecord,
  entry: JsonRecord | null,
  candidate: JsonRecord | null,
): void {
  const delivery = record(errors, 'lifecycle.delivery', value);
  if (delivery === null) return;
  same(errors, 'delivery.schemaVersion', delivery.schemaVersion, 2);
  matches(errors, 'delivery.deliveryId', delivery.deliveryId, DELIVERY_ID, '32 lowercase hex characters');
  matches(errors, 'delivery.evidenceDigest', delivery.evidenceDigest, SHA256, '64 lowercase hex characters');
  absolute(errors, 'delivery.root', delivery.root);
  if (typeof delivery.root === 'string' && /[/\\]plugins[/\\]cache(?:[/\\]|$)/.test(delivery.root)) {
    errors.push('delivery.root must not be a plugin cache root');
  }
  same(errors, 'delivery.targetVersion', delivery.targetVersion, lifecycle.candidateVersion);
  same(errors, 'delivery.platformId', delivery.platformId, entry?.platformId);
  same(errors, 'delivery.platformTriple', delivery.platformTriple, entry?.platformTriple);
  same(errors, 'delivery.releaseTag', delivery.releaseTag, candidate?.releaseTag);
  same(errors, 'delivery.releaseName', delivery.releaseName, candidate?.releaseName);
  same(errors, 'delivery.releaseManifestSha256', delivery.releaseManifestSha256, candidate?.manifestSha256);
  same(errors, 'delivery.artifactSha256', delivery.artifactSha256, candidate?.artifactSha256);
  same(errors, 'delivery.installedBinarySha256', delivery.installedBinarySha256, candidate?.binarySha256);
  same(errors, 'delivery.canonicalPayloadSha256', delivery.canonicalPayloadSha256, candidate?.payloadSha256);
  same(errors, 'delivery.evidenceDigest binding', delivery.evidenceDigest, candidate?.evidenceDigest);
}

function validateConvergence(errors: string[], value: unknown): void {
  const convergence = record(errors, 'lifecycle.convergence', value);
  if (convergence === null) return;
  const route = record(errors, 'lifecycle.convergence.route', convergence.route);
  same(errors, 'convergence.route.state', route?.state, 'managed-project');
  absolute(errors, 'convergence.route.command', route?.command);
  same(errors, 'convergence.route.cwdOverride', route?.cwdOverride, null);
  if (typeof route?.command === 'string' && /[/\\]plugins[/\\]cache(?:[/\\]|$)/.test(route.command)) {
    errors.push('convergence.route.command must use the stable facade, not a plugin cache path');
  }
  const roles = record(errors, 'lifecycle.convergence.roles', convergence.roles);
  const expected = roles?.expectedCount;
  if (typeof expected !== 'number' || !Number.isInteger(expected) || expected <= 0) {
    errors.push('convergence.roles.expectedCount must be a positive integer');
  }
  same(errors, 'convergence.roles.observedCount', roles?.observedCount, expected);
  same(errors, 'convergence.roles.current', roles?.current, true);
  matches(errors, 'convergence.roles.reviewerSha256', roles?.reviewerSha256, SHA256, '64 lowercase hex characters');
}

function validateTaskSentinel(errors: string[], label: string, value: unknown): JsonRecord | null {
  const sentinel = record(errors, label, value);
  if (sentinel === null) return null;
  matches(errors, `${label}.token`, sentinel.token, SENTINEL_TOKEN, 'at least 128 bits of lowercase hex');
  const expected = record(errors, `${label}.expected`, sentinel.expected);
  const observed = record(errors, `${label}.observed`, sentinel.observed);
  if (expected !== null && observed !== null && JSON.stringify(expected) !== JSON.stringify(observed)) {
    errors.push(`${label}.observed must exactly equal the seeded expected task identity`);
  }
  for (const [side, task] of [
    ['expected', expected],
    ['observed', observed],
  ] as const) {
    nonempty(errors, `${label}.${side}.wish`, task?.wish);
    nonempty(errors, `${label}.${side}.taskId`, task?.taskId);
    nonempty(errors, `${label}.${side}.title`, task?.title);
    nonempty(errors, `${label}.${side}.claimedBy`, task?.claimedBy);
    same(errors, `${label}.${side}.status`, task?.status, 'in_progress');
    if (typeof sentinel.token === 'string') {
      if (typeof task?.wish !== 'string' || !task.wish.includes(sentinel.token)) {
        errors.push(`${label}.${side}.wish must contain the unpredictable sentinel token`);
      }
      if (typeof task?.title !== 'string' || !task.title.includes(sentinel.token)) {
        errors.push(`${label}.${side}.title must contain the unpredictable sentinel token`);
      }
    }
  }
  same(errors, `${label}.boardCount`, sentinel.boardCount, 1);
  return sentinel;
}

function validateRepoObservation(
  errors: string[],
  label: string,
  value: unknown,
  cacheRoot: unknown,
): JsonRecord | null {
  const repo = record(errors, label, value);
  if (repo === null) return null;
  absolute(errors, `${label}.root`, repo.root);
  same(errors, `${label}.requestedCwd`, repo.requestedCwd, repo.root);
  same(errors, `${label}.effectiveCwd`, repo.effectiveCwd, repo.root);
  matches(
    errors,
    `${label}.cwdIdentity`,
    repo.cwdIdentity,
    DIRECTORY_IDENTITY,
    'an OS directory identity in dev:ino form',
  );
  if (typeof repo.childPid !== 'number' || !Number.isInteger(repo.childPid) || repo.childPid <= 0) {
    errors.push(`${label}.childPid must be a positive integer`);
  }
  if (
    repo.effectiveCwd === cacheRoot ||
    (typeof repo.effectiveCwd === 'string' && /[/\\]plugins[/\\]cache/.test(repo.effectiveCwd))
  ) {
    errors.push(`${label}.effectiveCwd must not be the plugin cache root`);
  }
  validateTaskSentinel(errors, `${label}.sentinel`, repo.sentinel);
  return repo;
}

function validateRepositories(errors: string[], value: unknown): void {
  const repositories = record(errors, 'manifest.repositories', value);
  if (repositories === null) return;
  absolute(errors, 'repositories.cacheRoot', repositories.cacheRoot);
  const repoA = validateRepoObservation(errors, 'repositories.a', repositories.a, repositories.cacheRoot);
  const repoB = record(errors, 'repositories.b', repositories.b);
  if (repoB === null) return;
  absolute(errors, 'repositories.b.root', repoB.root);
  const before = record(errors, 'repositories.b.beforeInit', repoB.beforeInit);
  same(errors, 'repositories.b.beforeInit.routeState', before?.routeState, 'absent');
  same(errors, 'repositories.b.beforeInit.fallbackUsed', before?.fallbackUsed, false);
  same(errors, 'repositories.b.beforeInit.result', before?.result, 'project-database-unavailable');
  same(errors, 'repositories.b.beforeInit.returnedTasks', before?.returnedTasks, 0);
  const after = validateRepoObservation(errors, 'repositories.b.afterInit', repoB.afterInit, repositories.cacheRoot);
  same(errors, 'repositories.b.afterInit.routeState', after?.routeState, 'managed-project');
  if (repoA?.root === repoB.root) errors.push('repositories A and B must be different roots');
  const aToken = isRecord(repoA?.sentinel) ? repoA.sentinel.token : null;
  const bToken = isRecord(after?.sentinel) ? after.sentinel.token : null;
  if (aToken === bToken) errors.push('repositories A and B must use different unpredictable sentinels');
  if (repoA?.childPid === after?.childPid) errors.push('repositories A and B must record distinct child processes');
}

interface StageExpectation {
  exit: number;
  human: string;
  json: string;
  generation: 'previous' | 'candidate';
  binary: 'previous' | 'candidate';
  trailer: 'activation-pending' | null;
}

const STAGE_EXPECTATIONS: Record<(typeof REQUIRED_STAGE_IDS)[number], StageExpectation> = {
  'seed-repositories': {
    exit: 0,
    human: 'seeded',
    json: 'seeded',
    generation: 'previous',
    binary: 'previous',
    trailer: null,
  },
  'n-parent-active': {
    exit: 0,
    human: 'current',
    json: 'current',
    generation: 'previous',
    binary: 'previous',
    trailer: null,
  },
  't-delivery-repair': {
    exit: 2,
    human: 'activation-pending',
    json: 'activation-pending',
    generation: 'previous',
    binary: 'candidate',
    trailer: 'activation-pending',
  },
  'activation-consent': {
    exit: 0,
    human: 'activated',
    json: 'current',
    generation: 'candidate',
    binary: 'candidate',
    trailer: null,
  },
  'assets-converged': {
    exit: 0,
    human: 'current',
    json: 'current',
    generation: 'candidate',
    binary: 'candidate',
    trailer: null,
  },
  'untouched-b-before-init': {
    exit: 1,
    human: 'project-database-unavailable',
    json: 'project-database-unavailable',
    generation: 'candidate',
    binary: 'candidate',
    trailer: null,
  },
  'untouched-b-after-init': {
    exit: 0,
    human: 'current',
    json: 'current',
    generation: 'candidate',
    binary: 'candidate',
    trailer: null,
  },
  'new-thread-sentinel': {
    exit: 0,
    human: 'current',
    json: 'current',
    generation: 'candidate',
    binary: 'candidate',
    trailer: null,
  },
  'doctor-current': {
    exit: 0,
    human: 'current',
    json: 'current',
    generation: 'candidate',
    binary: 'candidate',
    trailer: null,
  },
};

function validateCapturedCommand(
  errors: string[],
  label: string,
  value: unknown,
): { record: JsonRecord; summary: string; exit: number | null; candidateSha256: unknown } | null {
  const command = record(errors, label, value);
  if (command === null) return null;
  absolute(errors, `${label}.executable`, command.executable);
  matches(errors, `${label}.executableSha256`, command.executableSha256, SHA256, '64 lowercase hex characters');
  const candidateIsNull = command.candidateBinary === null && command.candidateBinarySha256 === null;
  if (!candidateIsNull) {
    absolute(errors, `${label}.candidateBinary`, command.candidateBinary);
    matches(
      errors,
      `${label}.candidateBinarySha256`,
      command.candidateBinarySha256,
      SHA256,
      '64 lowercase hex characters',
    );
  }
  if (!Array.isArray(command.argv) || command.argv.some((arg) => typeof arg !== 'string')) {
    errors.push(`${label}.argv must be a string array`);
  }
  if (typeof command.pid !== 'number' || !Number.isInteger(command.pid) || command.pid <= 0) {
    errors.push(`${label}.pid must be a positive integer`);
  }
  absolute(errors, `${label}.requestedCwd`, command.requestedCwd);
  matches(errors, `${label}.cwdIdentity`, command.cwdIdentity, DIRECTORY_IDENTITY, 'an OS directory identity');
  if (typeof command.exit !== 'number' || !Number.isInteger(command.exit)) {
    errors.push(`${label}.exit must be an integer`);
  }
  if (typeof command.stdout !== 'string') errors.push(`${label}.stdout must be a string`);
  if (typeof command.stderr !== 'string') errors.push(`${label}.stderr must be a string`);
  return {
    record: command,
    summary: [String(command.executable), ...(Array.isArray(command.argv) ? command.argv.map(String) : [])].join(' '),
    exit: typeof command.exit === 'number' && Number.isInteger(command.exit) ? command.exit : null,
    candidateSha256: command.candidateBinarySha256,
  };
}

const NATIVE_MCP_STAGES = new Set<(typeof REQUIRED_STAGE_IDS)[number]>([
  'untouched-b-before-init',
  'untouched-b-after-init',
  'new-thread-sentinel',
]);

function validateHostNativeRaw(
  errors: string[],
  label: string,
  raw: JsonRecord,
  command: JsonRecord,
  expectError: boolean,
): void {
  same(errors, `${label}.schemaVersion`, raw.schemaVersion, 1);
  const codex = record(errors, `${label}.codex`, raw.codex);
  absolute(errors, `${label}.codex.executable`, codex?.executable);
  nonempty(errors, `${label}.codex.version`, codex?.version);
  if (typeof codex?.appServerPid !== 'number' || !Number.isInteger(codex.appServerPid) || codex.appServerPid <= 0) {
    errors.push(`${label}.codex.appServerPid must be a positive integer`);
  }
  const candidate = record(errors, `${label}.candidate`, raw.candidate);
  same(errors, `${label}.candidate.executable`, candidate?.executable, command.candidateBinary);
  same(errors, `${label}.candidate execution`, candidate?.adapter ?? candidate?.executable, command.executable);
  same(errors, `${label}.rawRequestedCwd`, raw.rawRequestedCwd, command.requestedCwd);
  nonempty(errors, `${label}.threadId`, raw.threadId);
  const launcher = record(errors, `${label}.launcher`, raw.launcher);
  same(errors, `${label}.launcher.pid`, launcher?.pid, command.pid);
  same(errors, `${label}.launcher.effectiveCwd`, launcher?.effectiveCwd, command.requestedCwd);
  same(errors, `${label}.launcher.cwdIdentity`, launcher?.cwdIdentity, command.cwdIdentity);
  same(errors, `${label}.launcher.candidate`, launcher?.candidate, command.candidateBinary);
  same(errors, `${label}.launcher.adapter`, launcher?.adapter, candidate?.adapter);
  const control = record(errors, `${label}.control`, raw.control);
  same(errors, `${label}.control.effectiveCwd`, control?.effectiveCwd, launcher?.effectiveCwd);
  same(errors, `${label}.control.cwdIdentity`, control?.cwdIdentity, launcher?.cwdIdentity);
  const server = record(errors, `${label}.mcpServer`, raw.mcpServer);
  same(errors, `${label}.mcpServer.name`, server?.name, 'genie');
  if (!Array.isArray(server?.tools) || !server.tools.includes('genie_board')) {
    errors.push(`${label}.mcpServer.tools must include genie_board`);
  }
  const response = record(errors, `${label}.toolResponse`, raw.toolResponse);
  same(errors, `${label}.toolResponse.isError`, response?.isError === true, expectError);
  const outcome = record(errors, `${label}.outcome`, raw.outcome);
  same(errors, `${label}.outcome.kind`, outcome?.kind, expectError ? 'expected-error' : 'sentinel');
}

function validateNativeObservation(
  errors: string[],
  id: (typeof REQUIRED_STAGE_IDS)[number],
  index: number,
  evidenceKind: unknown,
  commands: Array<{ record: JsonRecord }>,
): void {
  if (!NATIVE_MCP_STAGES.has(id)) return;
  const label = `stages[${index}].nativeMcp`;
  const command = commands.find(
    (value) => Array.isArray(value.record.argv) && value.record.argv.includes('mcpServer/tool/call'),
  )?.record;
  if (command === undefined || typeof command.stdout !== 'string') {
    errors.push(`${label} must contain a raw MCP command observation`);
    return;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(command.stdout);
  } catch {
    errors.push(`${label} stdout must be JSON`);
    return;
  }
  const recordValue = record(errors, label, raw);
  if (recordValue === null) return;
  if (evidenceKind === 'verified-local-fixture') {
    same(errors, `${label}.schemaVersion`, recordValue.schemaVersion, 1);
    same(errors, `${label}.kind`, recordValue.kind, 'verified-local-fixture-direct-mcp');
    return;
  }
  if (evidenceKind !== 'host-native') {
    errors.push(`${label} has an unsupported evidence kind`);
    return;
  }
  validateHostNativeRaw(errors, label, recordValue, command, id === 'untouched-b-before-init');
}

function validateStageObservation(
  errors: string[],
  stage: JsonRecord,
  index: number,
  id: (typeof REQUIRED_STAGE_IDS)[number],
  expectedExit: number,
  expectedBinarySha256: unknown,
  evidenceKind: unknown,
): void {
  portableObservation(errors, `stages[${index}].observationPath`, stage.observationPath, id);
  matches(errors, `stages[${index}].observationSha256`, stage.observationSha256, SHA256, '64 lowercase hex characters');
  const observation = record(errors, `stages[${index}].observation`, stage.observation);
  same(errors, `stages[${index}].observation.schemaVersion`, observation?.schemaVersion, 1);
  if (!Array.isArray(observation?.commands) || observation.commands.length === 0) {
    errors.push(`stages[${index}].observation.commands must be a non-empty array`);
    return;
  }
  const commands = observation.commands
    .map((value, commandIndex) =>
      validateCapturedCommand(errors, `stages[${index}].observation.commands[${commandIndex}]`, value),
    )
    .filter((value) => value !== null);
  same(
    errors,
    `stages[${index}].command projection`,
    stage.command,
    commands.map((value) => value.summary).join(' && '),
  );
  if (!commands.some((command) => command.exit === expectedExit)) {
    errors.push(`stages[${index}].observation must contain the projected exit ${expectedExit}`);
  }
  if (!commands.some((command) => command.candidateSha256 === expectedBinarySha256)) {
    errors.push(`stages[${index}].observation must bind the authenticated generation binary digest`);
  }
  validateNativeObservation(errors, id, index, evidenceKind, commands);
  const serialized = `${JSON.stringify(observation, null, 2)}\n`;
  const observedDigest = createHash('sha256').update(serialized).digest('hex');
  same(errors, `stages[${index}].observation digest`, stage.observationSha256, observedDigest);
}

function validateStages(
  errors: string[],
  value: unknown,
  previousVersion: unknown,
  candidateVersion: unknown,
  previousBinarySha256: unknown,
  candidateBinarySha256: unknown,
  evidenceKind: unknown,
): void {
  if (!Array.isArray(value)) {
    errors.push('manifest.stages must be an array');
    return;
  }
  if (value.length !== REQUIRED_STAGE_IDS.length) {
    errors.push(`manifest.stages must have exactly ${REQUIRED_STAGE_IDS.length} ordered stages (got ${value.length})`);
  }
  REQUIRED_STAGE_IDS.forEach((id, index) => {
    const stage = record(errors, `stages[${index}] (${id})`, value[index]);
    if (stage === null) return;
    same(errors, `stages[${index}].id`, stage.id, id);
    nonempty(errors, `stages[${index}].command`, stage.command);
    const expected = STAGE_EXPECTATIONS[id];
    same(errors, `stages[${index}] (${id}).exit`, stage.exit, expected.exit);
    same(errors, `stages[${index}] (${id}).humanState`, stage.humanState, expected.human);
    same(errors, `stages[${index}] (${id}).jsonState`, stage.jsonState, expected.json);
    same(
      errors,
      `stages[${index}] (${id}).activeVersion`,
      stage.activeVersion,
      expected.generation === 'previous' ? previousVersion : candidateVersion,
    );
    validateStageObservation(
      errors,
      stage,
      index,
      id,
      expected.exit,
      expected.binary === 'previous' ? previousBinarySha256 : candidateBinarySha256,
      evidenceKind,
    );
    if (expected.trailer === null) {
      same(errors, `stages[${index}] (${id}).trailer`, stage.trailer, null);
      return;
    }
    const trailer = record(errors, `stages[${index}] (${id}).trailer`, stage.trailer);
    same(errors, `stages[${index}] (${id}).trailer.schemaVersion`, trailer?.schemaVersion, 1);
    same(errors, `stages[${index}] (${id}).trailer.code`, trailer?.code, expected.trailer);
    same(errors, `stages[${index}] (${id}).trailer.deliveryComplete`, trailer?.deliveryComplete, true);
    same(errors, `stages[${index}] (${id}).trailer.retry`, trailer?.retry, false);
    nonempty(errors, `stages[${index}] (${id}).trailer.nextAction`, trailer?.nextAction);
  });
}

function validateLifecycle(errors: string[], value: unknown, entry: JsonRecord | null): JsonRecord | null {
  const lifecycle = record(errors, 'manifest.lifecycle', value);
  if (lifecycle === null) return null;
  matches(
    errors,
    'lifecycle.previousVersion',
    lifecycle.previousVersion,
    RELEASE_VERSION,
    'a release version MAJOR.YYMMDD.PATCH',
  );
  matches(
    errors,
    'lifecycle.candidateVersion',
    lifecycle.candidateVersion,
    RELEASE_VERSION,
    'a release version MAJOR.YYMMDD.PATCH',
  );
  if (lifecycle.previousVersion === lifecycle.candidateVersion) {
    errors.push('lifecycle previous and candidate versions must differ');
  }
  const previousVersion = parseReleaseVersion(lifecycle.previousVersion);
  const candidateVersion = parseReleaseVersion(lifecycle.candidateVersion);
  if (
    previousVersion !== null &&
    candidateVersion !== null &&
    compareReleaseVersions(previousVersion, candidateVersion) >= 0
  ) {
    errors.push('lifecycle previous stable N must be older than candidate T');
  }
  if (!['stable', 'homolog', 'dev'].includes(String(lifecycle.channel))) {
    errors.push('lifecycle.channel must be stable, homolog, or dev');
  }
  matches(errors, 'lifecycle.sourceCommit', lifecycle.sourceCommit, COMMIT_SHA, 'a 40-character lowercase commit sha');
  const artifacts = record(errors, 'lifecycle.artifacts', lifecycle.artifacts);
  const previous = validateArtifact(
    errors,
    'lifecycle.artifacts.previous',
    artifacts?.previous,
    lifecycle.previousVersion,
    entry,
    undefined,
    undefined,
  );
  const candidate = validateArtifact(
    errors,
    'lifecycle.artifacts.candidate',
    artifacts?.candidate,
    lifecycle.candidateVersion,
    entry,
    lifecycle.sourceCommit,
    lifecycle.channel,
  );
  same(errors, 'entry.artifactName binding', entry?.artifactName, candidate?.releaseName);
  validateDelivery(errors, lifecycle.delivery, lifecycle, entry, candidate);
  validateConvergence(errors, lifecycle.convergence);
  validateStages(
    errors,
    (lifecycle as JsonRecord).stages,
    lifecycle.previousVersion,
    lifecycle.candidateVersion,
    previous?.binarySha256,
    candidate?.binarySha256,
    entry?.evidenceKind,
  );
  // Keep the previous value live in the validation graph: both generations must
  // carry independent artifact identities, not a copied candidate object.
  if (previous?.artifactSha256 === candidate?.artifactSha256) {
    errors.push('previous and candidate artifacts must have different digests');
  }
  return lifecycle;
}

function validateDoctor(errors: string[], blocks: Array<JsonBlock | null>, candidateVersion: unknown): void {
  const doctors = blocks.filter((block) => block !== null && isRecord(block.value.integrationSummary));
  if (doctors.length !== 1) {
    errors.push(`evidence must contain exactly one doctor JSON block (got ${doctors.length})`);
    return;
  }
  const doctor = (doctors[0] as JsonBlock).value;
  same(errors, 'doctor.ok', doctor.ok, true);
  if (!Array.isArray(doctor.checks) || doctor.checks.length === 0)
    errors.push('doctor.checks must be a non-empty array');
  const summary = doctor.integrationSummary as JsonRecord;
  same(errors, 'doctor.integrationSummary.schemaVersion', summary.schemaVersion, 1);
  if ('state' in summary) errors.push('obsolete flat doctor integrationSummary.state is forbidden');
  const plugin = record(errors, 'doctor.integrationSummary.codexPlugin', summary.codexPlugin);
  same(errors, 'doctor.integrationSummary.codexPlugin.state', plugin?.state, 'current');
  same(errors, 'doctor.integrationSummary.codexPlugin.installedVersion', plugin?.installedVersion, candidateVersion);
  same(errors, 'doctor.integrationSummary.codexPlugin.targetVersion', plugin?.targetVersion, candidateVersion);
  same(errors, 'doctor.integrationSummary.codexPlugin.actionRequired', plugin?.actionRequired, false);
  same(errors, 'doctor.integrationSummary.codexPlugin.deliveryComplete', plugin?.deliveryComplete, true);
}

function manifestFromBlocks(blocks: Array<JsonBlock | null>): JsonRecord | null {
  const manifests = blocks.filter((block) => block !== null && block.value.kind === 'live-dogfood-evidence');
  return manifests.length > 0 ? (manifests[0] as JsonBlock).value : null;
}

/** Validate evidence structure and all cross-field bindings. Empty means valid. */
export function validateLiveDogfoodEvidence(markdown: string): string[] {
  const errors: string[] = [];
  const blocks = extractJsonBlocks(markdown);
  const manifests = blocks.filter((block) => block !== null && block.value.kind === 'live-dogfood-evidence');
  if (manifests.length !== 1) {
    errors.push(`evidence must contain exactly one live-dogfood-evidence manifest block (got ${manifests.length})`);
    validateDoctor(errors, blocks, undefined);
    return errors;
  }
  const manifest = (manifests[0] as JsonBlock).value;
  same(errors, 'manifest.schemaVersion', manifest.schemaVersion, LIVE_DOGFOOD_SCHEMA_VERSION);
  const entry = validateEntry(errors, manifest.entry);
  const lifecycle = validateLifecycle(errors, manifest.lifecycle, entry);
  validateRepositories(errors, manifest.repositories);
  validateDoctor(errors, blocks, lifecycle?.candidateVersion);
  return errors;
}

function validateReferencedFiles(manifest: JsonRecord, inputsRoot: string): string[] {
  const errors: string[] = [];
  const entry = isRecord(manifest.entry) ? manifest.entry : null;
  const inputs = entry && isRecord(entry.inputs) ? entry.inputs : null;
  const lifecycle = isRecord(manifest.lifecycle) ? manifest.lifecycle : null;
  const artifacts = lifecycle && isRecord(lifecycle.artifacts) ? lifecycle.artifacts : null;
  for (const generation of ['previous', 'candidate'] as const) {
    const input = inputs && isRecord(inputs[generation]) ? inputs[generation] : null;
    const artifact = artifacts && isRecord(artifacts[generation]) ? artifacts[generation] : null;
    const provenance = artifact && isRecord(artifact.provenance) ? artifact.provenance : null;
    for (const [key, digest] of [
      ['artifact', artifact?.artifactSha256],
      ['manifest', artifact?.manifestSha256],
      ['identity', provenance?.identitySha256],
      ['bundle', provenance?.bundleSha256],
    ] as const) {
      const reference = input?.[key];
      const path = typeof reference === 'string' ? resolve(inputsRoot, reference) : '';
      if (typeof reference !== 'string' || !path.startsWith(`${resolve(inputsRoot)}/`) || !existsSync(path)) {
        errors.push(`referenced ${generation} ${key} is unavailable: ${String(reference)}`);
        continue;
      }
      try {
        if (!lstatSync(path).isFile()) {
          errors.push(`referenced ${generation} ${key} is not a regular file: ${path}`);
          continue;
        }
        const observed = createHash('sha256').update(readFileSync(path)).digest('hex');
        if (observed !== digest) errors.push(`referenced ${generation} ${key} digest mismatch`);
      } catch (error) {
        errors.push(`referenced ${generation} ${key} could not be verified: ${errorText(error)}`);
      }
    }
  }
  const stages = lifecycle && Array.isArray(lifecycle.stages) ? lifecycle.stages : [];
  for (const [index, value] of stages.entries()) {
    const stage = isRecord(value) ? value : null;
    const reference = stage?.observationPath;
    const path = typeof reference === 'string' ? resolve(inputsRoot, reference) : '';
    if (
      typeof reference !== 'string' ||
      !reference.startsWith('observations/') ||
      !path.startsWith(`${resolve(inputsRoot)}/`) ||
      !existsSync(path)
    ) {
      errors.push(`referenced stage observation is unavailable: ${String(reference)}`);
      continue;
    }
    try {
      if (!lstatSync(path).isFile()) {
        errors.push(`referenced stage observation is not a regular file: ${path}`);
        continue;
      }
      const bytes = readFileSync(path);
      const observed = createHash('sha256').update(bytes).digest('hex');
      if (observed !== stage?.observationSha256) {
        errors.push(`referenced stage observation digest mismatch at stages[${index}]`);
      }
      const parsed = JSON.parse(bytes.toString('utf8')) as unknown;
      if (JSON.stringify(parsed) !== JSON.stringify(stage?.observation)) {
        errors.push(`referenced stage observation content mismatch at stages[${index}]`);
      }
    } catch (error) {
      errors.push(`referenced stage observation could not be verified: ${errorText(error)}`);
    }
  }
  return errors;
}

export function validateLiveDogfoodEvidenceFile(path: string, inputsRoot = dirname(resolve(path))): string[] {
  if (!existsSync(path)) return [`evidence file not found: ${path}`];
  const markdown = readFileSync(path, 'utf8');
  const errors = validateLiveDogfoodEvidence(markdown);
  if (errors.length > 0) return errors;
  const manifest = manifestFromBlocks(extractJsonBlocks(markdown));
  return manifest === null ? errors : [...errors, ...validateReferencedFiles(manifest, inputsRoot)];
}

function parseArgs(argv: string[]): { file: string; inputsRoot?: string } {
  if (
    (argv.length !== 2 && argv.length !== 4) ||
    argv[0] !== '--file' ||
    !argv[1] ||
    (argv.length === 4 && (argv[2] !== '--inputs-root' || !argv[3]))
  ) {
    throw new Error(
      'usage: bun scripts/validate-live-dogfood-evidence.ts --file <evidence.md> [--inputs-root <directory>]',
    );
  }
  return { file: argv[1], inputsRoot: argv[3] };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function main(): void {
  let args: { file: string; inputsRoot?: string };
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(errorText(error));
    process.exit(2);
  }
  const errors = validateLiveDogfoodEvidenceFile(args.file, args.inputsRoot);
  if (errors.length > 0) {
    console.error(`validate-live-dogfood-evidence: FAIL (${errors.length}) — ${args.file}`);
    for (const error of errors) console.error(`  - ${error}`);
    process.exit(1);
  }
  console.log(`validate-live-dogfood-evidence: OK — ${args.file}`);
}

if (import.meta.main) main();
