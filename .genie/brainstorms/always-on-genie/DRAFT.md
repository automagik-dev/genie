# DRAFT: always-on-genie (Domain D — umbrella G5+G10)

**Parent:** [genie-token-efficiency-program](../genie-token-efficiency-program/DESIGN.md) · **Status:** Raw

## KNOWN (evidence)
- Felipe requirement: "the end user gets a genie load at all times, without doing anything" — like hermes-agent always loads its identity.
- Hermes-agent mechanism (Nous research): identity = system-prompt injection at session construction (SOUL.md + project files, threat-scanned, 20k cap), NOT force-loaded skills; skills stay progressive-disclosure (description-only in context).
- CC translation: SessionStart hook additionalContext. Genie already owns the seam: in-process fail-closed `genie hook dispatch` + identity-inject handler (currently wired for PreToolUse SendMessage only).
- 3 of 5 plugin hook scripts are silently DEAD on v5 shapes (session-context, validate-wish, validate-completion; one says "Run /forge"). rules/genie-orchestration.md (20 lines) is the one v5-correct plugin doc.
- Native worktrees: `isolation:"worktree"` per-agent, `--worktree`, EnterWorktree, `.worktreeinclude`, worktree.baseRef; project plugins auto-load in worktrees (v2.1.200).

## DECIDED (umbrella D9, D10, D14)
- Two-layer always-on: (1) thin rules identity ≤40 lines (who genie is, lifecycle routing, control-plane invariants); (2) SessionStart additionalContext via in-process dispatch — live wishes+status, ready groups from genie.db, first-run wizard branch. Deep playbooks stay on-demand.
- Hook contract: schema-version manifest, v4/v5 fixtures, per-hook CI smoke, unknown schema ⇒ fail closed with message; silent noop prohibited; dead scripts rewritten in-process or deleted; /forge purged.
- Worktree isolation policy (G10): isolation:"worktree" for parallel engineers; per-agent branch + env overlay; stateful-resource locks (migrations, ports, caches); orphan reaper; integration gate; `.worktreeinclude` scaffolded by genie init. genie launch keeps Warp cockpit as view, never truth.

## GAPS
- [ ] First-message payload: identity only, or identity + board summary + in-flight wishes? Token budget for the inject (suggest ≤600 tokens)?
- [ ] Worker sessions (GENIE_WORKER=1): skip the state inject (workers get curated briefs) — confirm.
- [ ] Warp interplay: should `genie launch` panes ALSO get per-role identity injects (engineer pane knows its group on open)?
- [ ] Collision: warp-integration umbrella wish exists — G10 worktree work must not fork it; reconcile scope.
- [ ] Non-genie repos: plugin installed globally — should always-on fire in repos without .genie/ (suggest: first-run branch only, no state scan)?
