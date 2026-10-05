# Wish: Fix context.exclude not applied in all CLI paths

| Field | Value |
|-------|-------|
| **Status** | DRAFT |
| **Slug** | `fix-context-exclude-passthrough` |
| **Date** | 2026-03-27 |
| **Issue** | #16 |

## Summary

`context.exclude` rules from rlmx.yaml are silently ignored in three scenarios: (1) when `--ext` overrides extensions, exclude is dropped, (2) `runCache` never reads config.contextConfig, (3) `runBatch` never reads config.contextConfig. This causes context to balloon with excluded files, leading to cascading failures on large contexts.

## Scope

### IN
- Fix `runQuery` to preserve exclude even when `--ext` overrides extensions
- Fix `runCache` to read and apply config.contextConfig.exclude
- Fix `runBatch` to read and apply config.contextConfig.exclude

### OUT
- CLI `--exclude` flag (separate feature request)
- Changes to context.ts exclude matching logic (already works correctly)
- Changes to loadContext/collectFiles API signature

## Decisions

| Decision | Rationale |
|----------|-----------|
| Always merge exclude from config, even with --ext | --ext overrides what to include, not what to exclude. These are orthogonal. |
| Fix all 3 call sites (query, cache, batch) | Same bug, same fix pattern. Batch is most critical since it accumulates outputs across runs. |

## Success Criteria

- [ ] `rlmx "query" --context ./path --ext .md,.txt` still applies exclude rules from rlmx.yaml
- [ ] `rlmx cache --context ./path` applies exclude rules from rlmx.yaml
- [ ] `rlmx batch questions.txt --context ./path` applies exclude rules from rlmx.yaml
- [ ] When no rlmx.yaml context config exists, defaults still work (no regression)
- [ ] TypeScript compiles clean

## Execution Strategy

### Wave 1
| Group | Agent | Description |
|-------|-------|-------------|
| 1 | engineer | Fix context options passthrough in all 3 CLI paths |

## Execution Groups

### Group 1: Fix context options passthrough

**Goal:** Ensure context.exclude from rlmx.yaml is always applied regardless of CLI flags.

**Deliverables:**
1. **cli.ts ~line 280 (runQuery)**: When `--ext` is provided, still include exclude from config:
   ```typescript
   const contextOpts = opts.ext
     ? { extensions: opts.ext, exclude: config.contextConfig?.exclude }
     : config.contextConfig
       ? { extensions: config.contextConfig.extensions, exclude: config.contextConfig.exclude }
       : undefined;
   ```
2. **cli.ts ~line 383 (runCache)**: Apply same pattern — read config.contextConfig for exclude:
   ```typescript
   const contextOpts = opts.ext
     ? { extensions: opts.ext, exclude: config.contextConfig?.exclude }
     : config.contextConfig
       ? { extensions: config.contextConfig.extensions, exclude: config.contextConfig.exclude }
       : undefined;
   ```
3. **cli.ts ~line 472 (runBatch)**: Same fix as runCache.

**Acceptance Criteria:**
- [ ] All 3 context loading paths include exclude from config
- [ ] --ext flag no longer silently drops exclude
- [ ] Default behavior unchanged when no rlmx.yaml exists

**Validation:**
```bash
npx tsc --noEmit && echo "types ok"
```

**depends-on:** none

---

## Files to Create/Modify

```
src/cli.ts   — fix 3 context loading call sites (lines ~280, ~383, ~472)
```
