# mikro execution boundary — evidence

Every row below is a real probe run recorded by `bun scripts/mikro/boundary.ts --probe`; nothing is
estimated. The `boundary` arm runs inside bubblewrap, the `control` arm runs the SAME check
uncontained (against a throwaway git repo for the write probe — never the real checkout), so a row is
only evidence when its control arm shows the check would otherwise have passed.

## 2026-09-18T05:59Z — bubblewrap 0.11.1 · dir `/home/genie/workspace/repos/genie/.claude/worktrees/agent-a12889cd8beab5763`

| probe | arm | expected | observed | verdict |
|---|---|---|---|---|
| write-to-repo | boundary | write refused, EROFS | exit 2: sh: 1: cannot create /home/genie/workspace/repos/genie/.claude/worktrees/agent-a12889cd8beab5763/.boundary-probe | ✔ |
| write-to-repo | boundary | tree digest unchanged (d587453cf0485c3e) | d587453cf0485c3e | ✔ |
| write-to-repo | control | write succeeds uncontained | exit 0, file created | ✔ |
| egress-direct | boundary | unreachable with the proxy env cleared | exit 6: 000curl: (6) Could not resolve host: example.com | ✔ |
| egress-needs-proxy-env | boundary | api.deepseek.com unreachable without the proxy env | exit 6: 000curl: (6) Could not resolve host: api.deepseek.com | ✔ |
| egress-denied | boundary | 403 from the proxy, logged allowed:false | 000curl: (7) CONNECT tunnel failed, response 403 · ledger false | ✔ |
| egress-allowed | boundary | CONNECT completes to api.deepseek.com (any status), logged allowed:true | 401 · ledger true | ✔ |
| egress-direct | control | direct curl succeeds uncontained | exit 0: 200 | ✔ |
| secrets-not-visible | boundary | every path absent | absent /home/genie/.config/gh/hosts.yml absent /home/genie/.claude absent /home/genie/.mikro/gate-env.sh | ✔ |
| secrets-not-visible | control | the same paths exist on the host | present, present, present | ✔ |
| launch-fails-closed | boundary | BoundaryError(socket-unavailable), no fallback | BoundaryError(socket-unavailable) | ✔ |
| launch-fails-closed | boundary | BoundaryError(bad-spec) on a non-absolute path | BoundaryError(bad-spec) | ✔ |

0 failing expectation(s) of 12.

## 2026-09-18T06:28Z — bubblewrap 0.11.1 · dir `/home/genie/workspace/repos/genie/.claude/worktrees/agent-a12889cd8beab5763`

| probe | arm | expected | observed | verdict |
|---|---|---|---|---|
| write-to-repo | boundary | write refused, EROFS | exit 2: sh: 1: cannot create /home/genie/workspace/repos/genie/.claude/worktrees/agent-a12889cd8beab5763/.boundary-probe | ✔ |
| write-to-repo | boundary | tree digest unchanged (eff105e436ae72aa) | eff105e436ae72aa | ✔ |
| write-to-repo | control | write succeeds uncontained | exit 0, file created | ✔ |
| egress-direct | boundary | unreachable with the proxy env cleared | exit 6: 000curl: (6) Could not resolve host: example.com | ✔ |
| egress-needs-proxy-env | boundary | api.deepseek.com unreachable without the proxy env | exit 6: 000curl: (6) Could not resolve host: api.deepseek.com | ✔ |
| egress-denied | boundary | 403 from the proxy, logged allowed:false | 000curl: (7) CONNECT tunnel failed, response 403 · ledger false | ✔ |
| egress-allowed | boundary | CONNECT completes to api.deepseek.com (any status), logged allowed:true | 401 · ledger true | ✔ |
| egress-direct | control | direct curl succeeds uncontained | exit 0: 200 | ✔ |
| secrets-not-visible | boundary | every path absent | absent /home/genie/.config/gh/hosts.yml absent /home/genie/.claude absent /home/genie/.mikro/gate-env.sh | ✔ |
| secrets-not-visible | control | the same paths exist on the host | present, present, present | ✔ |
| launch-fails-closed | boundary | BoundaryError(socket-unavailable), no fallback | BoundaryError(socket-unavailable) | ✔ |
| launch-fails-closed | boundary | BoundaryError(bad-spec) on a non-absolute path | BoundaryError(bad-spec) | ✔ |

0 failing expectation(s) of 12.

## 2026-09-18T09:02Z — bubblewrap 0.11.1 · dir `/home/genie/workspace/repos/genie/.claude/worktrees/agent-a246ecbb5ae94b48e`

| probe | arm | expected | observed | verdict |
|---|---|---|---|---|
| write-to-repo | boundary | write refused, EROFS | exit 2: sh: 1: cannot create /home/genie/workspace/repos/genie/.claude/worktrees/agent-a246ecbb5ae94b48e/.boundary-probe | ✔ |
| write-to-repo | boundary | tree digest unchanged (8019b9a3c820d973) | 8019b9a3c820d973 | ✔ |
| write-to-repo | control | write succeeds uncontained | exit 0, file created | ✔ |
| egress-direct | boundary | unreachable with the proxy env cleared | exit 6: 000curl: (6) Could not resolve host: example.com | ✔ |
| egress-needs-proxy-env | boundary | api.deepseek.com unreachable without the proxy env | exit 6: 000curl: (6) Could not resolve host: api.deepseek.com | ✔ |
| egress-denied | boundary | 403 from the proxy, logged allowed:false | 000curl: (7) CONNECT tunnel failed, response 403 · ledger false | ✔ |
| egress-allowed | boundary | CONNECT completes to api.deepseek.com (any status), logged allowed:true | 401 · ledger true | ✔ |
| egress-direct | control | direct curl succeeds uncontained | exit 0: 200 | ✔ |
| secrets-not-visible | boundary | every path absent | absent /home/genie/.config/gh/hosts.yml absent /home/genie/.claude absent /home/genie/.mikro/gate-env.sh | ✔ |
| secrets-not-visible | control | the same paths exist on the host | present, present, present | ✔ |
| launch-fails-closed | boundary | BoundaryError(socket-unavailable), no fallback | BoundaryError(socket-unavailable) | ✔ |
| launch-fails-closed | boundary | BoundaryError(bad-spec) on a non-absolute path | BoundaryError(bad-spec) | ✔ |

0 failing expectation(s) of 12.

## 2026-09-18T09:05Z — facts computed INSIDE the boundary (`wish/mikro-facts-in-boundary`)

Before this round, `--facts auto` was precomputed on the HOST before `openBoundary`: `facts.ts` ran
`git` over the tree under `--dir` and `gh` **with the host's credential**, outside the sandbox and
outside the egress ledger — the exact traffic the rows above exist to contain. The probe table
immediately above (12/12, same host, same binary, run from this branch) is the unchanged-policy
control: the writable set did not grow and `secrets-not-visible` still holds.

**One real combined call**, nothing uncontained:

```sh
bun scripts/mikro/call.ts issue-triage --dir "$PWD" --facts auto --boundary bwrap \
  --no-phoenix --prompt "triage issue #2942"
```

| what | observed |
|---|---|
| result | `ok: true`, 1 attempt, 53.9 s, $0.01, `boundary: "bwrap"` |
| ledger row `facts` | `{candidates: 0, ms: 782, gh: "skipped-boundary"}` |
| facts `basis` | `{sha: 507d78056…, mode: "issue", gh: "skipped-boundary"}`, `related.wishes: [".genie/wishes/wish-v6/WISH.md"]` |
| egress ledger | 4 allowed, 0 denied — 1 × `api.deepseek.com:443`, **3 × `api.github.com:443`** |

The three GitHub CONNECTs are the whole point. `facts.ts` spawned no `gh` at all
(`skipped-boundary`), and the issue body still reached the agent — through the agent's own `gh`
**inside** the sandbox, over the allowlisted proxy, one logged line each. What used to be an
unlogged host call carrying the host's credential is now three ledger rows. The facts file is
correspondingly smaller (`candidates: 0`: with no issue body, `#2942` is the only keyword and it
appears nowhere in this tree) — the designed degrade. Contained `git ls-files` still ran, which is
what found the related wish, and the answer validated on the first attempt.

Two live suites ride `boundary.test.ts`, skipped when bwrap, socat or the mikro runtime are absent;
both green on this host (`bun test scripts/mikro/boundary.test.ts`, 37 pass / 0 fail):

| probe | arm | expected | observed | verdict |
|---|---|---|---|---|
| facts-context-readable | boundary | with `--dir` ≠ the trusted root, the facts md is readable inside | `cat` printed `FACTS-CANARY` | ✔ |
| facts-context-readonly | boundary | a write to it from inside fails, bytes unchanged | non-zero exit, file still `FACTS-CANARY` | ✔ |
| contained-git-worktree | boundary | `ls-files` / `rev-parse` / `grep -c` all exit 0 over a LINKED worktree | exit 0, `sprocket.ts`, `sprocket.ts:1` | ✔ |

The third answers the one open question this slice had: a linked worktree's `.git` is a file, and
the already-bound `git rev-parse --git-common-dir` is what makes contained git resolve it. Nothing
had to be added to the bind set for it.
