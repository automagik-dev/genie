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
