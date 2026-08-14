# DRAFT: delegate-bridge (W2+W3 of cross-agent-delegation)

**Parent:** [cross-agent-delegate](../cross-agent-delegate/DESIGN.md) (SHIP, digest `c15d6a9e…`) · **Status:** Ready

Seeded 2026-08-11 from the parent design's W2/W3 scope after W1 shipped (PR #2766). The parent design already
carries the approach (board-as-contract, thin spawn bridge, turn-per-launch), the decision table, and the W2/W3
success criteria; this brainstorm's work is resolving the **five SHIP-review residuals** the parent recorded as
mandatory pre-pour design decisions, plus the three findings W1's execution/pre-merge reviews handed forward.

## Residual resolutions (the actual brainstorm content)

- **M1 hermes continue** → hermes adapter is **stateless turn-per-launch**: no continue form; every follow-up
  brief carries accumulated context (prior turn summaries from the card timeline). `-c <name>` rejected for the
  title-fallback trap; resume-by-id doesn't exist. Revisit trigger: hermes ships a reliable resume-by-id.
  Criterion 4 adjusted accordingly (hermes smoke exercises a stateless follow-up turn, not a continue form).
- **M2 cross-repo edge** → same-repo `depends-on: cross-agent-delegate` is a real DAG edge at pour; the remotty
  stall is `genie task block <id> --reason "blocked on remotty headless-turn-open"` on the W2/W3 card. The
  parent DESIGN.md line-37 "declares depends-on the remotty wish" sentence is stale (W1 plan-review LOW-5);
  this design states the corrected mechanism rather than editing the digest-stamped parent.
- **M3 dirty-orphan deadlock** → prepare refusal on an existing dirty `.worktrees/<name>` path gets a bounded
  attempt suffix (`<task>-<agent>-r<n>`, n recorded on the timeline); orphan paths surface in `genie doctor`
  (warning-level). No unbounded retries; fail-open (Decision 8) still owns the terminal case.
- **M4 remotty ask shape** → the headless verb takes BOTH the roster name (manifest identity — revive/fleet
  state/client rendering join on it) and the launch argv. Spec'd in the remotty `headless-turn-open` draft.
- **LOW-1 brief reach** → per-adapter delivery fact on the adapter card: stdin-streamed brief content where the
  runtime accepts prompt-on-stdin, else an explicit read grant for `$GENIE_HOME/briefs/…`; smoke validates.
- **Keep (reviewer)** → id-free continue is unambiguous **by cwd**: each candidate worktree is its own
  conversation scope — stated in the adapter rationale.

## W1 handoffs folded in

1. Pre-merge MEDIUM: imported snapshots store `assigned_agent` raw — bridge calls `requireRosterAgent` at
   consumption before any argv/prompt use; one-line untrusted-import doc lands on `TaskRow`.
2. TOCTOU INFO: bridge-path assignment reads/claims are in-transaction read-modify-write.
3. Create-time routing has no timeline entry — bridge reads the current row, never the timeline, for routing.

WRS: ██████████ 100/100 — Problem ✅ | Scope ✅ | Decisions ✅ | Risks ✅ | Criteria ✅
All dimensions inherited from the SHIP'd parent; residuals resolved above. Crystallizing to DESIGN.md.
