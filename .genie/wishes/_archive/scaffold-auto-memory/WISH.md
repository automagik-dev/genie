# WISH: Auto-Configure Memory on Agent Scaffold

**Status:** READY
**Priority:** P2 — DX paper cut
**Repo:** /home/genie/workspace/repos/genie
**Branch:** fix/scaffold-auto-memory
**External:** automagik-dev/genie#1106
**Autonomous:** YES (twin-genie reviewed — scope 2/5, risk 2/5, clarity 4/5)
**Depends on:** none

## Problem

When `genie init agent <name>` scaffolds an agent, it creates the `brain/memory/` directory but the auto-memory system is NOT wired up:

1. `.claude/settings.local.json` gets written with only `{ agentName: name }` — missing `autoMemoryEnabled` and `autoMemoryDirectory` keys.
2. `brain/memory/MEMORY.md` index is never seeded — the directory sits empty.

Users have to manually configure auto-memory after every scaffold. This is a repeatable paper cut that hits every new agent workspace.

## Root Cause

**File:** `/home/genie/workspace/repos/genie/src/term-commands/init.ts`
**Function:** `scaffoldAgentInWorkspace()` (line 46-85)

```typescript
mkdirSync(join(agentDir, 'brain', 'memory'), { recursive: true });  // line 54 — dir created
mkdirSync(join(agentDir, '.claude'), { recursive: true });

// ...

writeFileSync(
  join(agentDir, '.claude', 'settings.local.json'),
  `${JSON.stringify({ agentName: name }, null, 2)}\n`     // line 67 — missing memory config
);
// no MEMORY.md seed — empty brain/memory/
```

The code creates the directory but never writes the config keys that tell the Claude Agent SDK to use it. The `autoMemoryEnabled` and `autoMemoryDirectory` keys are valid SDK settings — verified in `@anthropic-ai/claude-agent-sdk/sdk.d.ts`.

## Acceptance Criteria

1. **settings.local.json auto-configured** — `scaffoldAgentInWorkspace()` writes:
   ```json
   {
     "agentName": "<name>",
     "autoMemoryEnabled": true,
     "autoMemoryDirectory": "./brain/memory"
   }
   ```

2. **MEMORY.md seeded** — A minimal `brain/memory/MEMORY.md` index file is created with:
   ```markdown
   # Memory Index

   _This file is maintained by the auto-memory system. New memories are added automatically._
   ```

3. **Scaffold console output updated** — after scaffold, the printed summary lists the new files:
   ```
   brain/memory/MEMORY.md (seeded)
   .claude/settings.local.json (auto-memory enabled)
   ```

4. **Idempotent on existing workspaces** — if the agent already has a `settings.local.json` (edge case: partial scaffold recovery), do NOT overwrite. The current code throws if `agentDir` already exists (line 49-51), so this is already guarded; just ensure the new write path respects that.

5. **Tests pass** — `bun test` green. Existing tests in `init.test.ts` (if any) still pass; new behavior does not break them.

6. **No regressions** — `genie init` (workspace creation) and `genie init agent <name>` (scaffold) both work for a fresh workspace.

## Execution Groups

### Group 1: Extend scaffold writer
**File:** `src/term-commands/init.ts`

**Changes:**
1. Update the `writeFileSync` call at line 67 to include `autoMemoryEnabled: true` and `autoMemoryDirectory: './brain/memory'`:
   ```typescript
   const settings = {
     agentName: name,
     autoMemoryEnabled: true,
     autoMemoryDirectory: './brain/memory',
   };
   writeFileSync(
     join(agentDir, '.claude', 'settings.local.json'),
     `${JSON.stringify(settings, null, 2)}\n`
   );
   ```

2. After creating `brain/memory/`, seed the index:
   ```typescript
   const memoryIndex = join(agentDir, 'brain', 'memory', 'MEMORY.md');
   writeFileSync(
     memoryIndex,
     '# Memory Index\n\n_This file is maintained by the auto-memory system. New memories are added automatically._\n'
   );
   ```

3. Update the console output block (line 78-84) to mention auto-memory:
   ```typescript
   console.log(`Agent scaffolded: agents/${name}/`);
   console.log('  AGENTS.md, SOUL.md, HEARTBEAT.md');
   console.log('  brain/memory/MEMORY.md (seeded)');
   console.log('  .claude/settings.local.json (auto-memory enabled)');
   ```

### Group 2: Test + validate
**Files:** `src/term-commands/init.test.ts`

**Note:** `init.test.ts` currently only tests `scaffoldAgentFiles`, NOT `scaffoldAgentInWorkspace` (verified at review time). The reviewer confirmed this ambiguity.

**Changes:**
1. **Preferred:** add a new test case to `init.test.ts` that invokes `scaffoldAgentInWorkspace` on a temp workspace and asserts:
   - `.claude/settings.local.json` contains `autoMemoryEnabled: true` and `autoMemoryDirectory: './brain/memory'`
   - `brain/memory/MEMORY.md` exists and contains `# Memory Index`
2. **Fallback (if test framework blocks):** run the smoke test block in the Validation section below and report stdout as evidence. Do NOT skip validation entirely.

## Validation

```bash
cd /tmp && rm -rf genie-scaffold-test && mkdir genie-scaffold-test && cd genie-scaffold-test

# Create a workspace (non-interactive)
genie init <<< 'n'   # skip default bootstrap prompt

# Scaffold an agent
genie init agent testbot

# Verify settings.local.json has the new keys
cat agents/testbot/.claude/settings.local.json
# Expected:
# {
#   "agentName": "testbot",
#   "autoMemoryEnabled": true,
#   "autoMemoryDirectory": "./brain/memory"
# }

# Verify MEMORY.md exists and has content
cat agents/testbot/brain/memory/MEMORY.md
# Expected: "# Memory Index" + seed text

# Verify nothing broke for existing agents
genie init agent secondbot
ls agents/secondbot/brain/memory/MEMORY.md agents/secondbot/.claude/settings.local.json
```

Quality gates:
```bash
cd /home/genie/workspace/repos/genie
bun run typecheck
bun run lint
bun test
```

## Worker Contract

1. Branch: `fix/scaffold-auto-memory` from `dev`.
2. Edit `src/term-commands/init.ts` per Group 1.
3. Run the validation block above.
4. Run `bun run check` (typecheck + lint + dead-code + test).
5. Commit: `fix: auto-configure memory when scaffolding agent workspace`.
6. Push and `gh pr create --base dev --title "..." --body "Closes automagik-dev/genie#1106"`.
7. Report DONE with PR URL via `genie agent send`.

## Context

- **Blast radius:** single function in a single file. No database changes, no API changes.
- **Why safe for autonomous:** The config keys are additive and idempotent; worst case is that the SDK ignores them on non-SDK providers (they are claude-sdk-only, which is the primary target).
- **Twin-genie note:** The twin flagged that `autoMemoryEnabled` is a claude-sdk-only setting — stock Claude Code CLI ignores it. Seeding is harmless for stock CLI users; functional for SDK users. Document this in the commit message.
