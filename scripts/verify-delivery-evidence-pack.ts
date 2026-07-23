#!/usr/bin/env bun

import { readFileSync } from 'node:fs';
import {
  type DeliveryEvidenceDescriptor,
  verifiedDeliveryEvidenceFacts,
  verifyDownloadedDeliveryEvidence,
} from '../src/lib/codex-delivery-evidence.ts';

function fail(message: string): never {
  console.error(`delivery-evidence-compatibility: ${message}`);
  process.exit(2);
}

const values = new Map<string, string>();
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index];
  const value = process.argv[index + 1];
  if (!key?.startsWith('--') || value === undefined || values.has(key)) fail('invalid arguments');
  values.set(key, value);
}
const descriptorPath = values.get('--descriptor') ?? fail('missing --descriptor');
const bundlePath = values.get('--bundle') ?? fail('missing --bundle');
const manifestPath = values.get('--manifest') ?? fail('missing --manifest');
if (values.size !== 3) fail('unknown argument');

const descriptorBytes = readFileSync(descriptorPath);
const descriptor = JSON.parse(descriptorBytes.toString('utf8')) as DeliveryEvidenceDescriptor;
const evidence = verifyDownloadedDeliveryEvidence({
  descriptorBytes,
  bundleBytes: readFileSync(bundlePath),
  manifestBytes: readFileSync(manifestPath),
  targetVersion: descriptor.version,
  channel: descriptor.channel,
  platformId: descriptor.platformId,
  platformTriple: descriptor.platformTriple,
  releaseTag: descriptor.releaseTag,
  releaseName: descriptor.releaseName,
  artifactSha256: descriptor.artifactSha256,
  installedBinarySha256: descriptor.installedBinarySha256,
  canonicalPayloadSha256: descriptor.canonicalPayloadSha256,
});
const facts = verifiedDeliveryEvidenceFacts(evidence);
console.log(`verified offline delivery evidence ${facts.evidenceDigest}`);
