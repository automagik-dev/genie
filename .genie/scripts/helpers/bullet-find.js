#!/usr/bin/env node

/**
 * Bullet Retrieval Tool
 *
 * Find and query structured learning bullets.
 *
 * Usage:
 *   genie helper bullet-find ID
 *   genie helper bullet-find --top-helpful --limit=10
 *   genie helper bullet-find --top-harmful --limit=10
 *   genie helper bullet-find --file=learn.md --section="Section"
 *   genie helper bullet-find --search="keyword"
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

/**
 * Parse bullet line into structured data
 */
function parseBullet(line, file, lineNum) {
  const match = line.match(/^- \[([a-z]+-\d{3})\] helpful=(\d+) harmful=(\d+): (.+)$/);

  if (!match) {
    return null;
  }

  return {
    id: match[1],
    helpful: parseInt(match[2], 10),
    harmful: parseInt(match[3], 10),
    content: match[4],
    file: path.relative(process.cwd(), file),
    line: lineNum
  };
}

/**
 * Find bullet by ID
 */
function findById(id) {
  try {
    const result = execSync(
      `rg -n "^- \\[${id}\\]" .genie/`,
      { encoding: 'utf-8', cwd: process.cwd() }
    ).trim();

    if (!result) {
      return null;
    }

    // Parse: file:line:content
    const match = result.match(/^([^:]+):(\d+):(.+)$/);
    if (!match) {
      return null;
    }

    const [, file, lineNum, content] = match;
    return parseBullet(content, file, parseInt(lineNum, 10));
  } catch (err) {
    if (err.status === 1) {
      return null; // Not found
    }
    throw err;
  }
}

/**
 * Find all bullets in framework
 */
function findAllBullets() {
  try {
    const result = execSync(
      'rg -n "^- \\[[a-z]+-\\d{3}\\] helpful=\\d+ harmful=\\d+:" .genie/',
      { encoding: 'utf-8', cwd: process.cwd() }
    ).trim();

    if (!result) {
      return [];
    }

    const lines = result.split('\n');
    const bullets = [];

    for (const line of lines) {
      const match = line.match(/^([^:]+):(\d+):(.+)$/);
      if (match) {
        const [, file, lineNum, content] = match;
        const bullet = parseBullet(content, file, parseInt(lineNum, 10));
        if (bullet) {
          bullets.push(bullet);
        }
      }
    }

    return bullets;
  } catch (err) {
    if (err.status === 1) {
      return []; // None found
    }
    throw err;
  }
}

/**
 * Find bullets in specific file
 */
function findInFile(filePath) {
  const fullPath = path.resolve(process.cwd(), filePath);

  if (!fs.existsSync(fullPath)) {
    return [];
  }

  try {
    const result = execSync(
      `rg -n "^- \\[[a-z]+-\\d{3}\\] helpful=\\d+ harmful=\\d+:" "${fullPath}"`,
      { encoding: 'utf-8' }
    ).trim();

    if (!result) {
      return [];
    }

    const lines = result.split('\n');
    const bullets = [];

    for (const line of lines) {
      // When rg searches a single file, output is "line:content" not "file:line:content"
      const match = line.match(/^(\d+):(.+)$/);
      if (match) {
        const [, lineNum, content] = match;
        const bullet = parseBullet(content, fullPath, parseInt(lineNum, 10));
        if (bullet) {
          bullets.push(bullet);
        }
      }
    }

    return bullets;
  } catch (err) {
    if (err.status === 1) {
      return []; // None found
    }
    throw err;
  }
}

/**
 * Search bullets by content keyword
 */
function searchByKeyword(keyword) {
  const allBullets = findAllBullets();
  return allBullets.filter(b =>
    b.content.toLowerCase().includes(keyword.toLowerCase()) ||
    b.id.includes(keyword)
  );
}

/**
 * Get top N bullets by helpful count
 */
function getTopHelpful(limit = 10) {
  const bullets = findAllBullets();
  bullets.sort((a, b) => b.helpful - a.helpful);
  return bullets.slice(0, limit);
}

/**
 * Get top N bullets by harmful count
 */
function getTopHarmful(limit = 10) {
  const bullets = findAllBullets();
  bullets.sort((a, b) => b.harmful - a.harmful);
  return bullets.slice(0, limit);
}

/**
 * Display bullets
 */
function displayBullets(bullets, title = null) {
  if (title) {
    console.log(`\n${title}\n${'='.repeat(title.length)}\n`);
  }

  if (bullets.length === 0) {
    console.log('No bullets found');
    return;
  }

  for (const bullet of bullets) {
    console.log(`[${bullet.id}] helpful=${bullet.helpful} harmful=${bullet.harmful}`);
    console.log(`  ${bullet.file}:${bullet.line}`);
    console.log(`  ${bullet.content.substring(0, 100)}${bullet.content.length > 100 ? '...' : ''}`);
    console.log('');
  }

  console.log(`Total: ${bullets.length} bullet(s)`);
}

/**
 * Main CLI
 */
async function main() {
  const args = process.argv.slice(2);

  // Help
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    console.log('Usage:');
    console.log('  genie helper bullet-find ID');
    console.log('    Find specific bullet by ID');
    console.log('');
    console.log('  genie helper bullet-find --top-helpful --limit=10');
    console.log('    Find top 10 most helpful bullets');
    console.log('');
    console.log('  genie helper bullet-find --top-harmful --limit=10');
    console.log('    Find top 10 most harmful bullets');
    console.log('');
    console.log('  genie helper bullet-find --file=file.md');
    console.log('    Find all bullets in specific file');
    console.log('');
    console.log('  genie helper bullet-find --search="keyword"');
    console.log('    Search bullets by content');
    console.log('');
    console.log('Examples:');
    console.log('  $ genie helper bullet-find learn-042');
    console.log('  $ genie helper bullet-find --top-helpful --limit=5');
    console.log('  $ genie helper bullet-find --search="delegate"');
    return;
  }

  // Find by ID
  if (args[0] && !args[0].startsWith('--')) {
    const bullet = findById(args[0]);
    if (!bullet) {
      console.error(`Error: Bullet [${args[0]}] not found`);
      process.exit(1);
    }
    displayBullets([bullet]);
    return;
  }

  // Top helpful
  if (args.includes('--top-helpful')) {
    const limitArg = args.find(a => a.startsWith('--limit='));
    const limit = limitArg ? parseInt(limitArg.split('=')[1], 10) : 10;
    const bullets = getTopHelpful(limit);
    displayBullets(bullets, `Top ${limit} Most Helpful Bullets`);
    return;
  }

  // Top harmful
  if (args.includes('--top-harmful')) {
    const limitArg = args.find(a => a.startsWith('--limit='));
    const limit = limitArg ? parseInt(limitArg.split('=')[1], 10) : 10;
    const bullets = getTopHarmful(limit);
    displayBullets(bullets, `Top ${limit} Most Harmful Bullets`);
    return;
  }

  // Find in file
  const fileArg = args.find(a => a.startsWith('--file='));
  if (fileArg) {
    const filePath = fileArg.split('=')[1];
    const bullets = findInFile(filePath);
    displayBullets(bullets, `Bullets in ${filePath}`);
    return;
  }

  // Search by keyword
  const searchArg = args.find(a => a.startsWith('--search='));
  if (searchArg) {
    const keyword = searchArg.split('=')[1];
    const bullets = searchByKeyword(keyword);
    displayBullets(bullets, `Search results for "${keyword}"`);
    return;
  }

  console.error('Error: No valid operation specified');
  console.error('Use --help to see available options');
  process.exit(1);
}

main().catch(err => {
  console.error('ERROR:', err.message);
  process.exit(1);
});
