# REPRO: fix-ghost-approval-p0

End-to-end validation steps for the P0 fix. Run these after the fix ships via `@next` (`genie update --next`) to prove the ghost-approval deadlock is gone.

## Preconditions

- A recent `@next` build of genie that contains the P0 fix (`resolveOrMintLeadSessionId` landed, `'pending'` literal removed from `team-auto-spawn.ts` and `session.ts`).
- Claude Code CLI installed (the `claude` binary on `$PATH`).
- tmux installed.
- `jq` installed.
- `~/.claude/settings.json` has `teammateMode: "bypassPermissions"` (set by `ensureTeammateBypassPermissions()` — verify with `jq '.teammateMode' ~/.claude/settings.json`).

## Repro setup

```bash
# Fresh workspace
mkdir -p /tmp/ghost-repro && cd /tmp/ghost-repro
rm -rf ~/.claude/teams/ghost-repro
rm -f .test-marker .gitmodules

# Scaffold a minimal agent so `genie` doesn't ask
cat > AGENTS.md <<'EOF'
# Repro agent

Testing fix-ghost-approval-p0.
EOF
```

## Baseline: the bug before the fix

On a pre-fix build these steps produced:
1. `~/.claude/teams/ghost-repro/config.json` with `"leadSessionId": "pending"`.
2. A teammate spawned via `genie spawn` that tried to `Write .test-marker` at cwd root.
3. The permission request landing in `~/.claude/teams/ghost-repro/inboxes/team-lead.json` with no matching response.
4. The teammate responding with `"The user doesn't want to proceed with this tool use. The tool use was rejected."`.

## Reproduction (post-fix)

Step 1 — launch the team-lead session:
```bash
cd /tmp/ghost-repro
genie          # launches Claude Code in a tmux pane, creates native team "ghost-repro"
```

Step 2 — from inside the team-lead CC session, verify the team config:
```bash
cat ~/.claude/teams/ghost-repro/config.json | jq '.leadSessionId'
# EXPECTED: a UUID matching /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
# FAILURE MODE: the string "pending" or "genie-ghost-repro"
```

Step 3 — verify the UUID matches a real JSONL file:
```bash
LEAD_ID=$(jq -r '.leadSessionId' ~/.claude/teams/ghost-repro/config.json)
ENC_CWD=$(echo -n "/tmp/ghost-repro" | tr -c 'a-zA-Z0-9' '-')
ls -la ~/.claude/projects/"$ENC_CWD"/"$LEAD_ID".jsonl
# EXPECTED: file exists
# FAILURE MODE: "No such file or directory"
```

Step 4 — spawn a teammate and have it write a new cwd-root file:
```bash
genie spawn engineer --team ghost-repro
# (inside the engineer session)
# Ask the engineer: please Write a file at /tmp/ghost-repro/.test-marker with content "hello"
```

Step 5 — verify the write succeeded:
```bash
cat /tmp/ghost-repro/.test-marker
# EXPECTED: "hello"
# FAILURE MODE: file doesn't exist AND the engineer output "The user doesn't want to proceed with this tool use. The tool use was rejected."
```

Step 6 — inbox sanity check (no permission_request accumulated):
```bash
jq '[.[] | select(.type == "permission_request")] | length' \
  ~/.claude/teams/ghost-repro/inboxes/team-lead.json
# EXPECTED: 0 (or the same count as before step 4)
# FAILURE MODE: count increased by 1+ (ghost request still landing in the inbox)
```

## Healing check (stale config upgraded in place)

Prove the fix also heals machines that already have a broken config:

```bash
cd /tmp/ghost-repro-heal && rm -rf ~/.claude/teams/ghost-repro-heal
mkdir -p ~/.claude/teams/ghost-repro-heal/inboxes
cat > ~/.claude/teams/ghost-repro-heal/config.json <<'EOF'
{
  "name": "ghost-repro-heal",
  "description": "Pre-seeded stale config",
  "createdAt": 1700000000000,
  "leadAgentId": "ghost-repro-heal@ghost-repro-heal",
  "leadSessionId": "pending",
  "members": []
}
EOF

# Trigger a respawn via `genie team ensure` or `genie` in that folder
mkdir -p /tmp/ghost-repro-heal && cd /tmp/ghost-repro-heal
cat > AGENTS.md <<'EOF'
# Heal test
EOF
genie team ensure ghost-repro-heal   # or just `genie`

# Verify the upsert
jq '.leadSessionId' ~/.claude/teams/ghost-repro-heal/config.json
# EXPECTED: a real UUID (stale "pending" was replaced in place)
# FAILURE MODE: still "pending"
```

## Cleanup

```bash
rm -rf /tmp/ghost-repro /tmp/ghost-repro-heal
rm -rf ~/.claude/teams/ghost-repro ~/.claude/teams/ghost-repro-heal
```

## Pass criteria

The P0 fix is proven when **every** check above returns its EXPECTED value on a `@next` build.
