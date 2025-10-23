#!/usr/bin/env node

/**
 * Archive Old Reports
 *
 * Automatically archives reports older than 3 days during minor version bumps.
 * Creates daily archives organized by date in ~/.genie-archives/
 *
 * Usage:
 *   node scripts/archive-old-reports.cjs [--dry-run] [--days=3] [--archive-dir=/path]
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const zlib = require('zlib');
const { createReadStream, createWriteStream } = require('fs');
const { pipeline } = require('stream');
const { promisify } = require('util');

const pipe = promisify(pipeline);

// Configuration
const REPO_ROOT = path.join(__dirname, '..');
const REPORTS_DIR = path.join(REPO_ROOT, '.genie', 'reports');
const DEFAULT_ARCHIVE_DIR = path.join(require('os').homedir(), '.genie-archives');
const DEFAULT_DAYS_THRESHOLD = 3;

// Parse CLI args
const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const DAYS_THRESHOLD = parseInt(args.find(a => a.startsWith('--days='))?.split('=')[1] || DEFAULT_DAYS_THRESHOLD);
const ARCHIVE_DIR = args.find(a => a.startsWith('--archive-dir='))?.split('=')[1] || DEFAULT_ARCHIVE_DIR;

// Colors
const colors = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
};

function log(color, emoji, message) {
  console.log(`${colors[color]}${emoji} ${message}${colors.reset}`);
}

// Get file modification time from git (more reliable than fs.stat)
function getFileDate(filePath) {
  try {
    // Get last commit date for file
    const gitDate = execSync(`git log -1 --format=%cd --date=short -- "${filePath}"`, {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore']
    }).trim();

    if (gitDate) {
      return new Date(gitDate);
    }
  } catch (error) {
    // Fall back to filesystem date if git fails
  }

  // Fallback to filesystem date
  const stat = fs.statSync(filePath);
  return stat.mtime;
}

// Extract date from filename (YYYYMMDD or YYYY-MM-DD format)
function extractDateFromFilename(filename) {
  // Match patterns like: report-20251023.md or report-2025-10-23.md
  const match = filename.match(/(\d{4})-?(\d{2})-?(\d{2})/);
  if (match) {
    return new Date(`${match[1]}-${match[2]}-${match[3]}`);
  }
  return null;
}

// Format date as YYYY-MM-DD
function formatDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// Get all report files
function getReportFiles() {
  const reports = [];

  function scanDir(dir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        // Skip archive directories
        if (entry.name === 'archive' || entry.name.startsWith('.')) {
          continue;
        }
        scanDir(fullPath);
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        reports.push(fullPath);
      }
    }
  }

  if (fs.existsSync(REPORTS_DIR)) {
    scanDir(REPORTS_DIR);
  }

  return reports;
}

// Calculate age in days
function getAgeInDays(date) {
  const now = new Date();
  const diffTime = Math.abs(now - date);
  const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
  return diffDays;
}

// Compress file to .gz
async function compressFile(inputPath, outputPath) {
  const gzip = zlib.createGzip();
  const source = createReadStream(inputPath);
  const destination = createWriteStream(outputPath);

  await pipe(source, gzip, destination);
}

// Create tar archive for a day's reports
async function createDailyArchive(date, files) {
  const dateStr = formatDate(date);
  const archiveSubDir = path.join(ARCHIVE_DIR, date.getFullYear().toString(), formatDate(date).substring(0, 7)); // YYYY/YYYY-MM
  const archiveName = `reports-${dateStr}.tar.gz`;
  const archivePath = path.join(archiveSubDir, archiveName);

  // Ensure archive directory exists
  if (!DRY_RUN) {
    fs.mkdirSync(archiveSubDir, { recursive: true });
  }

  // Create tar archive
  const fileList = files.map(f => {
    const relativePath = path.relative(REPORTS_DIR, f);
    return relativePath;
  });

  if (!DRY_RUN) {
    // Create tar.gz using tar command (more reliable than node modules)
    try {
      const fileListStr = fileList.join(' ');
      execSync(
        `tar -czf "${archivePath}" -C "${REPORTS_DIR}" ${fileListStr}`,
        { stdio: 'pipe' }
      );
    } catch (error) {
      // Fallback: create individual .gz files
      log('yellow', '⚠️', `tar failed, falling back to individual compression`);

      for (const file of files) {
        const relativePath = path.relative(REPORTS_DIR, file);
        const outputPath = path.join(archiveSubDir, `${relativePath}.gz`);
        const outputDir = path.dirname(outputPath);

        fs.mkdirSync(outputDir, { recursive: true });
        await compressFile(file, outputPath);
      }

      return { path: archiveSubDir, count: files.length, method: 'individual' };
    }
  }

  return { path: archivePath, count: files.length, method: 'tar' };
}

// Main logic
async function main() {
  log('blue', '📦', `Archiving reports older than ${DAYS_THRESHOLD} days...`);

  if (DRY_RUN) {
    log('yellow', '🔍', 'DRY RUN - No files will be modified');
  }

  console.log('');
  log('cyan', '📂', `Reports directory: ${REPORTS_DIR}`);
  log('cyan', '📦', `Archive directory: ${ARCHIVE_DIR}`);
  console.log('');

  // Get all report files
  const reports = getReportFiles();
  log('blue', '🔍', `Found ${reports.length} report files`);

  // Group files by date and age
  const filesByDate = new Map();
  const oldFiles = [];
  const recentFiles = [];

  for (const report of reports) {
    // Try to extract date from filename first (more reliable)
    let fileDate = extractDateFromFilename(path.basename(report));

    // Fall back to git/filesystem date
    if (!fileDate) {
      fileDate = getFileDate(report);
    }

    const age = getAgeInDays(fileDate);

    if (age > DAYS_THRESHOLD) {
      oldFiles.push({ path: report, date: fileDate, age });

      const dateKey = formatDate(fileDate);
      if (!filesByDate.has(dateKey)) {
        filesByDate.set(dateKey, []);
      }
      filesByDate.get(dateKey).push(report);
    } else {
      recentFiles.push({ path: report, date: fileDate, age });
    }
  }

  console.log('');
  log('green', '✅', `Recent files (≤${DAYS_THRESHOLD} days): ${recentFiles.length}`);
  log('yellow', '📦', `Old files (>${DAYS_THRESHOLD} days): ${oldFiles.length}`);
  console.log('');

  if (oldFiles.length === 0) {
    log('green', '✨', 'No files to archive!');
    return 0;
  }

  // Show what will be archived
  log('blue', '📋', 'Files to archive by date:');
  const sortedDates = Array.from(filesByDate.keys()).sort();

  for (const dateKey of sortedDates) {
    const files = filesByDate.get(dateKey);
    console.log(`  ${dateKey}: ${files.length} files`);
  }

  console.log('');

  // Create archives
  const archives = [];

  for (const [dateKey, files] of filesByDate.entries()) {
    const date = new Date(dateKey);
    log('blue', '📦', `Archiving ${files.length} files from ${dateKey}...`);

    const archive = await createDailyArchive(date, files);
    archives.push(archive);

    if (!DRY_RUN) {
      if (archive.method === 'tar') {
        log('green', '✅', `Created: ${path.basename(archive.path)}`);
      } else {
        log('green', '✅', `Created ${archive.count} compressed files in ${path.basename(archive.path)}`);
      }
    } else {
      log('cyan', '🔍', `Would create: ${path.basename(archive.path)}`);
    }
  }

  console.log('');

  // Delete original files
  if (!DRY_RUN) {
    log('blue', '🗑️', `Removing ${oldFiles.length} archived files...`);

    for (const file of oldFiles) {
      fs.unlinkSync(file.path);
    }

    log('green', '✅', `Removed ${oldFiles.length} files from ${REPORTS_DIR}`);
  } else {
    log('cyan', '🔍', `Would remove ${oldFiles.length} files`);
  }

  console.log('');

  // Summary
  log('magenta', '📊', 'Archive Summary:');
  console.log(`  Total files archived: ${oldFiles.length}`);
  console.log(`  Archives created: ${archives.length}`);
  console.log(`  Archive location: ${ARCHIVE_DIR}`);

  if (DRY_RUN) {
    console.log('');
    log('yellow', '💡', 'Run without --dry-run to execute archiving');
  }

  return 0;
}

// Run
main()
  .then(code => process.exit(code))
  .catch(error => {
    log('red', '❌', `Archive failed: ${error.message}`);
    console.error(error);
    process.exit(1);
  });
