#!/usr/bin/env node

/**
 * Auto-update Last Updated timestamps and frontmatter versions in .genie markdown files
 *
 * Amendment #9: Automation Through Timestamps
 * - Replace !date commands with commit timestamp
 * - Auto-bump version in frontmatter
 * - Track agent growth through version history
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// Get git root directory
const gitRoot = execSync('git rev-parse --show-toplevel', { encoding: 'utf8' }).trim();

// Get staged .md files in .genie directory
function getStagedGenieMarkdownFiles() {
  try {
    const stagedFiles = execSync('git diff --cached --name-only', { encoding: 'utf8' })
      .trim()
      .split('\n')
      .filter(Boolean)
      .filter(file => file.startsWith('.genie/') && file.endsWith('.md'));

    return stagedFiles;
  } catch (e) {
    return [];
  }
}

// Get commit timestamp (ISO 8601 UTC format)
function getCommitTimestamp() {
  const now = new Date();
  return now.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC');
}

// Extract frontmatter block and parse version
// Frontmatter can appear after initial markdown content (like **Last Updated:** line)
function parseFrontmatter(content) {
  const frontmatterRegex = /(---\n)([\s\S]*?)(---\n)/;
  const match = content.match(frontmatterRegex);

  if (match) {
    const [fullMatch, openDelim, body, closeDelim] = match;
    const versionMatch = body.match(/version:\s*(\d+)\.(\d+)\.(\d+)/);

    return {
      hasFrontmatter: true,
      frontmatterStart: match.index,
      frontmatterEnd: match.index + fullMatch.length,
      openDelim,
      body,
      closeDelim,
      version: versionMatch ? {
        exists: true,
        major: parseInt(versionMatch[1]),
        minor: parseInt(versionMatch[2]),
        patch: parseInt(versionMatch[3])
      } : { exists: false, major: 0, minor: 0, patch: 0 }
    };
  }

  return { hasFrontmatter: false, version: { exists: false, major: 0, minor: 0, patch: 0 } };
}

// Update file metadata
function updateFileMetadata(filePath, timestamp) {
  const fullPath = path.join(gitRoot, filePath);

  if (!fs.existsSync(fullPath)) {
    console.log(`⚠️  File not found: ${filePath} (skipping)`);
    return false;
  }

  let content = fs.readFileSync(fullPath, 'utf8');
  let modified = false;

  // 1. Replace **Last Updated:** line with commit timestamp
  const lastUpdatedPattern = /\*\*Last Updated:\*\* !`date -u \+"%Y-%m-%d %H:%M:%S UTC"`/g;
  const lastUpdatedPattern2 = /\*\*Last Updated:\*\* \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} UTC/g;
  const newLastUpdatedLine = `**Last Updated:** ${timestamp}`;

  if (lastUpdatedPattern.test(content)) {
    content = content.replace(lastUpdatedPattern, newLastUpdatedLine);
    modified = true;
  } else if (lastUpdatedPattern2.test(content)) {
    content = content.replace(lastUpdatedPattern2, newLastUpdatedLine);
    modified = true;
  }

  // 2. Handle frontmatter version
  const fm = parseFrontmatter(content);
  const newVersion = fm.version.exists
    ? { major: fm.version.major, minor: fm.version.minor, patch: fm.version.patch + 1 }
    : { major: 1, minor: 0, patch: 0 };

  if (fm.hasFrontmatter) {
    // Frontmatter exists - update or add version
    let newBody = fm.body;

    if (fm.version.exists) {
      // Update existing version
      newBody = newBody.replace(
        /version:\s*\d+\.\d+\.\d+/,
        `version: ${newVersion.major}.${newVersion.minor}.${newVersion.patch}`
      );
    } else {
      // Add version as first line in frontmatter
      newBody = `version: ${newVersion.major}.${newVersion.minor}.${newVersion.patch}\n` + newBody;
    }

    const newFrontmatter = fm.openDelim + newBody + fm.closeDelim;
    content = content.substring(0, fm.frontmatterStart) + newFrontmatter + content.substring(fm.frontmatterEnd);
    modified = true;
  }

  if (modified) {
    fs.writeFileSync(fullPath, content, 'utf8');

    // Re-stage the file
    execSync(`git add "${filePath}"`, { cwd: gitRoot });

    const versionStr = `v${newVersion.major}.${newVersion.minor}.${newVersion.patch}`;

    console.log(`✅ Updated ${filePath} (${versionStr}) with timestamp: ${timestamp}`);
    return true;
  }

  return false;
}

function main() {
  const stagedFiles = getStagedGenieMarkdownFiles();

  if (stagedFiles.length === 0) {
    // No .genie markdown files staged, skip silently
    return 0;
  }

  console.log('🔄 Updating .genie markdown metadata...');
  const timestamp = getCommitTimestamp();

  let updatedCount = 0;
  for (const file of stagedFiles) {
    if (updateFileMetadata(file, timestamp)) {
      updatedCount++;
    }
  }

  if (updatedCount > 0) {
    console.log(`✨ Auto-updated ${updatedCount} file(s) with commit metadata`);
  }

  return 0;
}

process.exit(main());
