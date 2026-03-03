# Wish: Configurable Worker Profiles with Claudio Integration

**Status:** complete
**Slug:** claudio-profiles
**Created:** 2026-02-04
**Completed:** 2026-02-05

---

## Summary

Extended genie-cli with profile-based worker configuration that bundles launcher choice (claude or claudio), model routing via claudio profiles, and Claude CLI parameters.

---

## What Was Implemented

### Group 1: Schema & Types ✅
- Added `WorkerProfileSchema` to `src/types/genie-config.ts`
- Added `workerProfiles` and `defaultWorkerProfile` to config
- Bumped config version to 3 with migration
- Added helper functions: `getWorkerProfile()`, `getDefaultWorkerProfile()`

### Group 2: Profile Management Commands ✅
- Created `src/genie-commands/profiles.ts`
- Commands: `genie profiles list/add/rm/show/default`
- Registered in `src/genie.ts`

### Group 3: Command Builder ✅
- Created `src/lib/spawn-command.ts` with `buildSpawnCommand()`
- Shell injection prevention with proper escaping
- 28 unit tests

### Group 4: Integrate into term spawn ✅
- Added `--profile <name>` option to spawn command
- Uses `buildSpawnCommand()` for all spawns
- Legacy fallback when no profile configured

### Group 5: Integrate into term work ✅
- Added `--profile <name>` option to work command
- Updated both resume and new session paths
- Uses profile's launcher with appropriate flags

### Group 6: Doctor & Documentation ✅
- Added Worker Profiles section to `genie doctor`
- Validates claudio binary and profile references
- Updated README.md with profiles documentation
- Created `docs/worker-profiles.md`

---

## Files Created/Modified

**New Files:**
- `src/genie-commands/profiles.ts`
- `src/lib/spawn-command.ts`
- `src/lib/spawn-command.test.ts`
- `src/types/genie-config.test.ts`
- `src/lib/genie-config.test.ts`
- `docs/worker-profiles.md`
- `templates/genie-config.template.json`

**Modified Files:**
- `src/types/genie-config.ts`
- `src/lib/genie-config.ts`
- `src/term-commands/spawn.ts`
- `src/term-commands/work.ts`
- `src/term.ts`
- `src/genie.ts`
- `src/genie-commands/doctor.ts`
- `README.md`

---

## Validation

- Build: ✅ Successful
- Tests: ✅ 414 pass, 0 fail
- `genie profiles list`: ✅ Shows configured profiles
- `genie doctor`: ✅ Shows Worker Profiles section
