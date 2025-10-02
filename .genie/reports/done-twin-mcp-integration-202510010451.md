# Twin Design Review - Group A CLI Core Module
- **Session:** wish-mcp-integration-twin-20251001
- **Purpose:** Evaluate the new `.genie/cli/src/cli-core/SessionService` locking implementation before unlocking Group B MCP work.
- **Inputs:** @.genie/wishes/mcp-integration-wish.md, @.genie/cli/src/cli-core/session-service.ts, @.genie/cli/src/cli-core/index.ts

## Key Findings
1. `SessionService.save` writes directly to the target file while writers hold only a sidecar `.lock` (lines session-service.ts:43-58). Readers (`loadSessions`) are unsynchronized, so a concurrent read can observe a truncated/partial JSON file and treat the store as `{}` - risk of warning spam and data loss.
2. Lock files never expire. If a process crashes after acquiring the lock, future saves see `EEXIST` until manual cleanup, because retry logic (10 attempts over ~1s) gives up with no stale-lock recovery (session-service.ts:79-93).
3. Merge strategy copies disk state then overwrites with the caller’s in-memory entry (session-service.ts:104-112). If two writers mutate the same agent with stale snapshots, the later write silently reverts fields from the first (e.g., status transitions), so last-writer-wins regressions remain.

## Risks & Impact
- **CRITICAL:** Unsynchronized reads can ingest partially-written JSON and reset the session store. This would break CLI/MCP parity and may strand background runs until humans restore the file.
- **HIGH:** Stale `.lock` files after crashes require manual deletion, blocking all session persistence.
- **MEDIUM:** Merge semantics can clobber fresher agent metadata when concurrent writers reuse stale structures. Background runners and future MCP server amplify this.

## Recommendations
1. Write to `sessions.json.tmp` then `rename` under the lock (or use `fsPromises.writeFile` + `fsync` + `rename`) to guarantee readers only see complete files; optionally gate `loadSessions` behind a shared read lock.
2. Track owner PID + timestamp inside the lock file; if age exceeds ~5s (configurable), emit a warning and reclaim the lock so the system self-heals after crashes.
3. Reload the disk store right before merging or require callers to provide per-agent patch objects; alternatively, deep-merge the latest disk entry into the caller’s data to preserve newer fields.

## Verdict
- **Decision:** HOLD - do not proceed to Group B until CRITICAL/HIGH risks are addressed.
- **Confidence:** Medium (analysis from static review; no stress-test harness yet).

## Follow-Ups
- Implement the write+rename flow and stale-lock detection; add targeted tests (CLI + simulated concurrent writer).
- Re-run build/test/import smoke checks after adjustments and reroute Twin for confirmation.
