#!/usr/bin/env node

/**
 * Token Counter Helper
 *
 * Count tokens in files or text using tiktoken (cl100k_base encoding).
 * This is the ONLY way to count tokens in the Genie framework.
 *
 * Usage:
 *   node count-tokens.js <file-path>               # Output: just token count number
 *   node count-tokens.js <file-path> --json        # Output: JSON with metadata
 *   echo "some text" | node count-tokens.js        # Output: just token count
 *   node count-tokens.js --before=file --after=file  # Compare (always JSON)
 *
 * Output (default):
 *   Plain number: 1234
 *
 * Output (--json):
 *   JSON: { tokens: N, lines: N, bytes: N, encoding: "cl100k_base" }
 */

const fs = require('fs');
const path = require('path');

/**
 * Count tokens using tiktoken
 */
function countTokens(text) {
  try {
    const { getEncoding } = require('js-tiktoken');
    const encName = process.env.TOKEN_ENCODING || 'cl100k_base';
    const encoder = getEncoding(encName);
    const tokens = encoder.encode(text).length;
    try { encoder.free && encoder.free(); } catch {}
    return { tokens, encoding: encName, method: 'tiktoken' };
  } catch (err) {
    // Fallback to word count approximation (should not happen if tiktoken installed)
    console.error(`Warning: tiktoken failed, using word count fallback: ${err.message}`);
    const approx = (text || '').trim().split(/\s+/).filter(Boolean).length;
    return { tokens: approx, encoding: 'approx-words', method: 'fallback' };
  }
}

/**
 * Get file stats (lines, bytes)
 */
function getStats(text) {
  const lines = (text.match(/\n/g) || []).length + 1;
  const bytes = Buffer.byteLength(text, 'utf8');
  return { lines, bytes };
}

/**
 * Count tokens in file
 */
function countFile(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const { tokens, encoding, method } = countTokens(content);
    const { lines, bytes } = getStats(content);

    return {
      file: path.basename(filePath),
      path: filePath,
      tokens,
      lines,
      bytes,
      encoding,
      method,
    };
  } catch (err) {
    return {
      error: err.message,
      file: filePath,
    };
  }
}

/**
 * Compare before/after token counts
 */
function compareFiles(beforePath, afterPath) {
  const before = countFile(beforePath);
  const after = countFile(afterPath);

  if (before.error || after.error) {
    return { error: 'Failed to read files' };
  }

  const diff = after.tokens - before.tokens;
  const percentChange = ((diff / before.tokens) * 100).toFixed(1);
  const saved = diff < 0;

  return {
    before: {
      file: before.file,
      tokens: before.tokens,
      lines: before.lines,
      bytes: before.bytes,
    },
    after: {
      file: after.file,
      tokens: after.tokens,
      lines: after.lines,
      bytes: after.bytes,
    },
    diff: {
      tokens: diff,
      percent: percentChange,
      saved: saved,
      message: saved
        ? `Saved ${Math.abs(diff)} tokens (${Math.abs(percentChange)}% reduction)`
        : `Added ${diff} tokens (${percentChange}% increase)`,
    },
    encoding: before.encoding,
  };
}

/**
 * Main
 */
function main() {
  const args = process.argv.slice(2);
  const jsonMode = args.includes('--json');
  const fileArgs = args.filter(a => !a.startsWith('--'));

  // Check for comparison mode (--before=file --after=file)
  const beforeArg = args.find(a => a.startsWith('--before='));
  const afterArg = args.find(a => a.startsWith('--after='));

  if (beforeArg && afterArg) {
    const beforePath = beforeArg.split('=')[1];
    const afterPath = afterArg.split('=')[1];
    const result = compareFiles(beforePath, afterPath);
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.error ? 1 : 0);
  }

  // Single file mode
  if (fileArgs.length > 0) {
    const filePath = fileArgs[0];
    if (!fs.existsSync(filePath)) {
      console.error(jsonMode
        ? JSON.stringify({ error: `File not found: ${filePath}` })
        : `Error: File not found: ${filePath}`);
      process.exit(1);
    }
    const result = countFile(filePath);
    if (result.error) {
      console.error(jsonMode ? JSON.stringify(result) : `Error: ${result.error}`);
      process.exit(1);
    }
    console.log(jsonMode ? JSON.stringify(result, null, 2) : result.tokens.toString());
    process.exit(0);
  }

  // Stdin mode
  if (!process.stdin.isTTY) {
    let input = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', chunk => input += chunk);
    process.stdin.on('end', () => {
      const { tokens, encoding, method } = countTokens(input);
      const { lines, bytes } = getStats(input);
      if (jsonMode) {
        console.log(JSON.stringify({
          tokens,
          lines,
          bytes,
          encoding,
          method,
        }, null, 2));
      } else {
        console.log(tokens.toString());
      }
    });
    return;
  }

  // No input, show usage
  console.error(`
Usage:
  node count-tokens.js <file-path>                    # Output: just token count (number)
  node count-tokens.js <file-path> --json             # Output: JSON with metadata
  echo "text" | node count-tokens.js                   # Output: just token count
  node count-tokens.js --before=old.md --after=new.md # Compare files (always JSON)

Output (default): Plain number (e.g., "1234")
Output (--json):  JSON with token count, lines, bytes, encoding

Examples:
  node count-tokens.js README.md                      # 1234
  node count-tokens.js README.md --json               # { "tokens": 1234, ... }
  node count-tokens.js --before=before.md --after=after.md
  cat myfile.md | node count-tokens.js
`);
  process.exit(1);
}

main();
