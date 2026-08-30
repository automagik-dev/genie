export default {
  extends: ['@commitlint/config-conventional'],
  ignores: [
    (message: string) => message.startsWith('[skip ci]'),
    // GitHub merge/squash-merge commits have auto-generated bodies that
    // violate body-max-line-length and contain nested commit messages.
    // Individual commits are already linted on dev before merge.
    (message: string) => message.startsWith('Merge'),
    // GitHub squash-merge commits without conventional prefix: "Title (#123)\n\n* feat: ..."
    // These have a PR number suffix and nested conventional commits in the body.
    // Already linted individually on dev before merge.
    (message: string) =>
      /\(#\d+\)$/.test(message.split('\n')[0]) &&
      !/^(feat|fix|chore|refactor|docs|style|test|perf|ci|build|revert)/.test(message),
    // Historical exception: one `wip:` commit landed on dev via #1065 before
    // pre-commit hooks caught it (commit 2b226b3b). Ignoring it here unblocks
    // the rolling promotion PRs without rewriting dev history. Do NOT add
    // more `wip:` commits — type-enum still rejects them for new commits.
    (message: string) => message.startsWith('wip: fix-omni-bridge-hardening#1'),
    // Historical exception: two docs(wish) commits merged via #1249 before
    // pre-commit hooks caught body-max-line-length. Their bodies quote live
    // PostgreSQL SQL idioms (#>>'{}')::jsonb and jsonb drift samples that
    // cannot be reflowed without destroying meaning. Ignoring unblocks the
    // rolling promotion PR without rewriting dev history. Do NOT reuse
    // these exact subjects for new commits — use shorter bodies instead.
    (message: string) => message.startsWith('docs(wish): scaffold fix-pg-disk-rehydration'),
    (message: string) =>
      message.startsWith('docs(wish): correct SQL idiom in migration 045 sample + success criterion'),
    // Historical exception: one fix(deps+doctor) commit (82e5d073) landed on
    // dev before pre-commit hooks caught header-max-length. Subject is 110
    // chars (a U+2192 → arrow narrowly puts it over 100). Reflowing would
    // require rebasing dev, which we avoid. Ignoring unblocks the dev→main
    // promotion PR. Do NOT reuse this exact subject — keep new headers ≤100.
    (message: string) => message.startsWith('fix(deps+doctor): pin every runtime dep + bump pgserve 1.1.10'),
    // Historical exception: docs(sec) round-2 fixes commit (#1385) landed on
    // dev with a 110-char squash-merge subject. The original PR title was
    // ~103 chars and GitHub appended `(#1385)` to push it over the limit.
    // Reflowing would require rebasing dev. Ignoring unblocks the dev→main
    // promotion PR. Do NOT reuse this exact subject — keep new headers ≤100
    // accounting for GitHub's `(#NNN)` suffix on squash-merge.
    (message: string) => message.startsWith('docs(sec): apply reviewer round-2 fixes — deprecation mechanism'),
    // Historical one-off squash subjects landed on dev before the GitHub-added
    // PR suffix was accounted for in the 100-character gate. Rewriting shared
    // dev history is off the table. These are exact full-subject matches pinned
    // to their commits; do not reuse them, and do not broaden this exception.
    (message: string) =>
      [
        'feat(doctor): spawn-context-contract#drain — drain legacy wish/* residue, retarget the launch-residue check (#2793)',
        'feat: retire genie launch atomically with its consumers (spawn-context-contract#launch-removal) (#2789)',
        'feat(hooks): security hardening - trusted gh spawn + claude/kimi launcher pin (hooks-v2#security) (#2788)',
        'spawn-context-contract#doctor-modes: mode-drift check + tighten-only --fix across all worktrees (#2779)',
        'feat(hooks): retire orchestration-guard, validate-completion, and hook trust (hooks-v2#retire) (#2780)',
      ].includes(message.split('\n')[0]),
    // Historical exception (2026-08-30, #2817 review-fix wave): four squash
    // subjects landed on dev over the 100-character gate once GitHub appended
    // `(#NNNN)` (#2828/#2829/#2837), and one (#2830) has a capitalised
    // "Orca-mode" subject that trips subject-case. Same posture as above:
    // exact full-subject pins, no rewrite of shared dev history, do not
    // reuse these subjects and do not broaden this to a pattern.
    (message: string) =>
      [
        'docs(wish): record the #2817 FIX-FIRST review and fix disposition in the dual-mode Orca ledger (#2828)',
        'fix(orca): adapter readback, wait bound, stream faults, version gate, and doctor resilience (#2829)',
        'fix: Orca-mode lifecycle guards + retire the dead `genie mcp` entry in .mcp.json (#2830)',
        'docs(wish): record re-review #1 of #2817, refresh the fix disposition, retire the UI entries (#2837)',
      ].includes(message.split('\n')[0]),
    // Historical exception: four `wish:`-prefixed wish-evolution commits on
    // the release-pipeline-collapse PR branch pre-date the engineering work.
    // They captured the wish-document drafts (council pivot, reviewer
    // FIX-FIRST loops) before any `feat/fix/docs` execution commits landed.
    // Rewording them would force-push 7 downstream commits and invalidate
    // the review-fix chain (commits 612dcf3a, b8117f70, 24fe5502 build on
    // top). Ignoring unblocks Commitlint on this PR. Do NOT use the
    // `wish:` prefix for new commits — use `docs(wish): ...` instead.
    (message: string) => message.startsWith('wish: release-pipeline-collapse'),
    (message: string) => message.startsWith('wish: pivot to Option B'),
    (message: string) => message.startsWith('wish: address reviewer loop 2 findings'),
    (message: string) => message.startsWith('wish: loop 3 cleanups'),
    // Historical exception: six wave-merge commits (group-1..6) landed on dev
    // via #2565 before the orchestration learned that a lowercase `merge:`
    // subject evades the `Merge` ignore above and trips type-enum (merge is
    // not a conventional type). Rewriting dev is off the table — the branch is
    // shared and the PRs are merged. Ignoring these six exact historical
    // subjects (commits d3584f14, f2abab6e, e6364fbd, 3ab1f6e9, 53f328ac,
    // 63696bf6) unblocks the rolling dev→main promotion without touching
    // history. Matching is pinned to the exact full subjects — never a
    // group-N prefix pattern — so genuinely new `merge:` commits still fail.
    // Do NOT create more `merge:`-prefixed commits — let git use its default
    // `Merge …` subjects, or use `chore:`.
    (message: string) =>
      [
        'merge: group-1 baseline + hermes integration map (review SHIP)',
        'merge: group-2 hermes MCP + skills config helpers (review FIX-FIRST->SHIP)',
        'merge: group-3 pre_llm_call bounded session context (review SHIP)',
        'merge: group-4 agent-sync hermes lane + doctor depth (review SHIP)',
        'merge: group-5 slim native surface + skills cleanup + version align (review SHIP)',
        'merge: group-6 smoke/dogfood gate + changelog (review SHIP)',
      ].includes(message.split('\n')[0]),
  ],
};
