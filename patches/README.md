# Patches

This directory contains patches for dependencies that improve performance or fix critical issues.

## automagik-forge-no-extraction.patch

**Purpose:** Eliminate 5-10s extraction delay on every startup

**Change:** Modified `bin/cli.js` to use pre-extracted binaries instead of extracting from .zip on every run

**Impact:**
- Before: 15-20s total startup (5-10s extraction + 10s forge init)
- After: 10-12s total startup (0s extraction + 10s forge init)
- **Result:** 🚀 40-50% faster startup!

**Status:** Temporary patch until automagik-forge@0.4.2+ is published

**How to apply:**
```bash
# Automatically applied during postinstall
pnpm install
```

**Implementation details:**
- Removed `extractAndRun()` function that deleted + re-extracted binaries
- Changed to `runBinary()` that uses existing pre-extracted binaries
- Binaries are shipped pre-extracted in npm package (dist/*/automagik-forge)
- Trade-off: +69MB package size for instant startup
