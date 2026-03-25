/**
 * Publish Command — `genie publish`
 *
 * Publishes the current directory as a genie item. Must be run from a
 * directory containing a genie.yaml. Requires a pushed git tag matching
 * the manifest version.
 */

import { execSync } from 'node:child_process';
import type { Command } from 'commander';
import { getItemFromStore, registerItemInStore, updateItemInStore } from '../lib/agent-cache.js';
import { getActor, recordAuditEvent } from '../lib/audit.js';
import { getConnection, isAvailable } from '../lib/db.js';
import { detectManifest, validateManifest } from '../lib/manifest.js';

// ============================================================================
// Git tag verification
// ============================================================================

function getGitRemoteTags(cwd: string): string[] {
  try {
    const output = execSync('git tag --list --merged HEAD', {
      cwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return output.trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

function isTagPushed(tag: string, cwd: string): boolean {
  try {
    execSync(`git ls-remote --tags origin refs/tags/${tag}`, {
      cwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return true;
  } catch {
    return false;
  }
}

function getGitSha(cwd: string): string | null {
  try {
    return execSync('git rev-parse HEAD', { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch {
    return null;
  }
}

// ============================================================================
// Publish handler
// ============================================================================

async function handlePublish(): Promise<void> {
  const cwd = process.cwd();

  // Detect and validate manifest
  const detection = await detectManifest(cwd);
  if ('error' in detection) {
    console.error(`Cannot publish: ${detection.error}`);
    process.exit(1);
  }

  const { manifest, source } = detection;
  const validation = validateManifest(manifest, cwd);
  for (const w of validation.warnings) {
    console.log(`  Warning: ${w}`);
  }
  if (!validation.valid) {
    console.error(`Validation failed:\n${validation.errors.map((e) => `  - ${e}`).join('\n')}`);
    process.exit(1);
  }

  // Check for git tag matching version
  const expectedTag = `v${manifest.version}`;
  const tags = getGitRemoteTags(cwd);
  const hasTag = tags.includes(expectedTag) || tags.includes(manifest.version);
  if (!hasTag) {
    console.error(`No git tag "${expectedTag}" found. Create and push a tag first:`);
    console.error(`  git tag ${expectedTag} && git push origin ${expectedTag}`);
    process.exit(1);
  }

  // Verify tag is pushed to remote
  const tagToPush = tags.includes(expectedTag) ? expectedTag : manifest.version;
  if (!isTagPushed(tagToPush, cwd)) {
    console.error(`Tag "${tagToPush}" exists locally but is not pushed to remote.`);
    console.error(`  git push origin ${tagToPush}`);
    process.exit(1);
  }

  const gitSha = getGitSha(cwd);

  // UPSERT into app_store
  const existing = await getItemFromStore(manifest.name).catch(() => null);
  if (existing) {
    await updateItemInStore(manifest.name, {
      version: manifest.version,
      description: manifest.description,
      manifest: manifest as unknown as Record<string, unknown>,
    });

    // Update approval status
    if (await isAvailable()) {
      const sql = await getConnection();
      await sql`
        UPDATE app_store
        SET approval_status = 'pending', updated_at = now()
        WHERE name = ${manifest.name}
      `;
    }
  } else {
    await registerItemInStore({
      name: manifest.name,
      itemType: manifest.type,
      version: manifest.version,
      description: manifest.description,
      authorName: manifest.author?.name,
      authorUrl: manifest.author?.url,
      installPath: cwd,
      manifest: manifest as unknown as Record<string, unknown>,
      tags: manifest.tags,
      category: manifest.category,
      license: manifest.license,
      dependencies: manifest.dependencies,
    });
  }

  // Record version in app_versions
  if (await isAvailable()) {
    const sql = await getConnection();
    const storeItem = await getItemFromStore(manifest.name);
    if (storeItem) {
      await sql`
        INSERT INTO app_versions (app_store_id, version, git_tag, git_sha, manifest)
        VALUES (
          ${storeItem.id},
          ${manifest.version},
          ${tagToPush},
          ${gitSha},
          ${sql.json(manifest as unknown as Record<string, unknown>)}
        )
        ON CONFLICT (app_store_id, version) DO UPDATE SET
          git_sha = EXCLUDED.git_sha,
          manifest = EXCLUDED.manifest,
          published_at = now()
      `;
    }
  }

  // Audit
  recordAuditEvent('item', manifest.name, 'item_published', getActor(), {
    type: manifest.type,
    version: manifest.version,
    tag: tagToPush,
    sha: gitSha,
    manifestSource: source,
  }).catch(() => {});

  console.log(`\nPublished ${manifest.type} "${manifest.name}" v${manifest.version}`);
  console.log(`  Tag: ${tagToPush}`);
  if (gitSha) console.log(`  SHA: ${gitSha.slice(0, 8)}`);
  console.log('  Status: pending approval');
}

// ============================================================================
// Command registration
// ============================================================================

export function registerPublishCommand(program: Command): void {
  program
    .command('publish')
    .description('Publish the current directory as a genie item (requires pushed git tag)')
    .action(async () => {
      try {
        await handlePublish();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Error: ${message}`);
        process.exit(1);
      }
    });
}
