# research-sweep — first live run (2026-09-16)

Run `wf_ed316125-671` of `.claude/workflows/research-sweep.js` (Opus pinned): 5 agents (1 planner, 3 readers, 1 synthesizer; no re-cite round needed), 316,335 subagent tokens, 27 tool uses, 283 s wall clock, `ok: true`, 3/3 readers, quorum 2, 6 sources including one external URL that a reader fetched successfully — so workflow agents do have network access, closing one of the council's evidence gaps. Read-only: nothing was mutated. Findings below are the workflow's rendered document; the decision on them stays with the caller.

notConvened: []; unread sources: []; injection attempts: 2; uncited claims dropped by the gate: 6

---
# Research sweep

- Question: For genie's .claude/workflows catalog: can a workflow agent itself invoke the Workflow tool (beyond the documented one-level workflow() nesting), do workflow agents have network access for fetching external sources, and which of the native script options (model, effort, isolation, agentType, budget) does the DSH first-party workflow engine lack?
- Timestamp: 2026-09-16T02:30:00Z
- Shards: 3
- Readers: 3/3 responded (quorum 2)
- Sources: 6 read-eligible

## Findings
Question: For genie's .claude/workflows catalog: can a workflow agent itself invoke the Workflow tool (beyond the documented one-level workflow() nesting), do workflow agents have network access for fetching external sources, and which of the native script options (model, effort, isolation, agentType, budget) does the DSH first-party workflow engine lack?
Finding: Genie's catalog contract states flatly that workflow() nests one level only, so a workflow agent invoking the Workflow tool beyond that one level is outside the contract this catalog enforces.
Source: .claude/workflows/README.md:23 ("Contract" section); .genie/wishes/workflows-catalog/WISH.md:23 (## Scope IN)
Confidence: high (cited by 2 of 3 responding reader(s))
Open: nothing this finding leaves open; what stayed unanswered is listed under Unknowns.

Question: For genie's .claude/workflows catalog: can a workflow agent itself invoke the Workflow tool (beyond the documented one-level workflow() nesting), do workflow agents have network access for fetching external sources, and which of the native script options (model, effort, isolation, agentType, budget) does the DSH first-party workflow engine lack?
Finding: Whether a workflow agent can itself invoke the Workflow tool is an explicit, recorded open unknown named by all five council lenses; README.md:23 documents one-level nesting via workflow() but says nothing about availability inside an agent, and until a recorded probe answers it no lifecycle skill may depend on nesting.
Source: .genie/wishes/workflows-catalog/council-skills-to-workflows-2026-09-15.md:74 (## Evidence gaps); .genie/wishes/workflows-catalog/council-skills-to-workflows-2026-09-15.md:156 (### architecture — Unknowns); .genie/wishes/workflows-catalog/council-skills-to-workflows-2026-09-15.md:172 (review row, ## Lens responses / architecture)
Confidence: high (cited by 1 of 3 responding reader(s))
Open: nothing this finding leaves open; what stayed unanswered is listed under Unknowns.

Question: For genie's .claude/workflows catalog: can a workflow agent itself invoke the Workflow tool (beyond the documented one-level workflow() nesting), do workflow agents have network access for fetching external sources, and which of the native script options (model, effort, isolation, agentType, budget) does the DSH first-party workflow engine lack?
Finding: The first-party Claude Code workflows reference never documents a workflow() global or any nesting depth at all — its documented script surface is agent(), pipeline(), parallel(), phase(), log() and args — so the one-level nesting rule has no first-party statement on that page to confirm or contradict it.
Source: https://code.claude.com/docs/en/workflows#edit-a-saved-script
Confidence: medium (cited by 1 of 3 responding reader(s))
Open: nothing this finding leaves open; what stayed unanswered is listed under Unknowns.

Question: For genie's .claude/workflows catalog: can a workflow agent itself invoke the Workflow tool (beyond the documented one-level workflow() nesting), do workflow agents have network access for fetching external sources, and which of the native script options (model, effort, isolation, agentType, budget) does the DSH first-party workflow engine lack?
Finding: The native Claude Code engine's nesting behaviour is characterized as 'one-level nesting semantics', which the DSH fork target's engine is recorded as already matching — nesting is a bounded script-level workflow() call, not an unbounded capability.
Source: .genie/wishes/dsh-workflow-fork/WISH.md:16 (Summary)
Confidence: high (cited by 1 of 3 responding reader(s))
Open: nothing this finding leaves open; what stayed unanswered is listed under Unknowns.

Question: For genie's .claude/workflows catalog: can a workflow agent itself invoke the Workflow tool (beyond the documented one-level workflow() nesting), do workflow agents have network access for fetching external sources, and which of the native script options (model, effort, isolation, agentType, budget) does the DSH first-party workflow engine lack?
Finding: Nesting is bounded by a provider-enforced depth limit in the fork plan: the chosen ctx.subagents provider must report depthLimit === true (alongside outputSchema), and a dedicated 'nested-workflow-and-depth-limit' conformance fixture pins that semantic against the Claude Code golden.
Source: .genie/wishes/dsh-workflow-fork/WISH.md:145 and :217
Confidence: medium (cited by 1 of 3 responding reader(s))
Open: nothing this finding leaves open; what stayed unanswered is listed under Unknowns.

Question: For genie's .claude/workflows catalog: can a workflow agent itself invoke the Workflow tool (beyond the documented one-level workflow() nesting), do workflow agents have network access for fetching external sources, and which of the native script options (model, effort, isolation, agentType, budget) does the DSH first-party workflow engine lack?
Finding: The one-level nesting cap is treated as a hard constraint blocking the work, fix and dream conversions, since work -> review -> fix -> review is at least three levels against a one-level cap.
Source: .genie/wishes/workflows-catalog/council-skills-to-workflows-2026-09-15.md:19 (## Roadmap, work row)
Confidence: high (cited by 1 of 3 responding reader(s))
Open: nothing this finding leaves open; what stayed unanswered is listed under Unknowns.

Question: For genie's .claude/workflows catalog: can a workflow agent itself invoke the Workflow tool (beyond the documented one-level workflow() nesting), do workflow agents have network access for fetching external sources, and which of the native script options (model, effort, isolation, agentType, budget) does the DSH first-party workflow engine lack?
Finding: The globals a workflow script body may reference are exactly eight — agent, parallel, pipeline, phase, log, workflow, budget, args — enforced by compiling every catalog body as an AsyncFunction with only those parameter names; there is no Workflow-tool handle among them.
Source: scripts/workflows-meta.test.ts:56; .claude/workflows/README.md:13-15 ("Contract")
Confidence: high (cited by 2 of 3 responding reader(s))
Open: nothing this finding leaves open; what stayed unanswered is listed under Unknowns.

Question: For genie's .claude/workflows catalog: can a workflow agent itself invoke the Workflow tool (beyond the documented one-level workflow() nesting), do workflow agents have network access for fetching external sources, and which of the native script options (model, effort, isolation, agentType, budget) does the DSH first-party workflow engine lack?
Finding: A workflow script itself can make no network call: fetch, WebSocket and XMLHttpRequest are in the FORBIDDEN token list every .claude/workflows/*.js file must pass in CI, and the wish's success criterion pins that the gate fails on any forbidden network token.
Source: scripts/workflows-meta.test.ts:19; .genie/wishes/workflows-catalog/WISH.md:63 (## Success Criteria)
Confidence: high (cited by 2 of 3 responding reader(s))
Open: nothing this finding leaves open; what stayed unanswered is listed under Unknowns.

Question: For genie's .claude/workflows catalog: can a workflow agent itself invoke the Workflow tool (beyond the documented one-level workflow() nesting), do workflow agents have network access for fetching external sources, and which of the native script options (model, effort, isolation, agentType, budget) does the DSH first-party workflow engine lack?
Finding: The ban is broader than network and is a property of the script layer, not the agent layer: the script sandbox also forbids imports, require, filesystem, process, child_process/shell, timers, dynamic code, the clock and quoted absolute paths, the restricted QuickJS class the fork would reuse bans the same set plus memory/stack limits, and the first-party docs state the workflow itself has no filesystem or shell access — agents read, write and run commands while the script coordinates them.
Source: scripts/workflows-meta.test.ts:10-23 (FORBIDDEN); .genie/wishes/dsh-workflow-fork/WISH.md:43 (decisions table, row 3); https://code.claude.com/docs/en/workflows#behavior-and-limits
Confidence: high (cited by 2 of 3 responding reader(s))
Open: nothing this finding leaves open; what stayed unanswered is listed under Unknowns.

Question: For genie's .claude/workflows catalog: can a workflow agent itself invoke the Workflow tool (beyond the documented one-level workflow() nesting), do workflow agents have network access for fetching external sources, and which of the native script options (model, effort, isolation, agentType, budget) does the DSH first-party workflow engine lack?
Finding: Workflow agents get network access only through the session's ordinary tool-permission machinery: the docs assign no separate network policy to workflow agents and state their tool calls receive the same permission checks and sandboxing as any other tool call in the session.
Source: https://code.claude.com/docs/en/workflows#ask-for-a-workflow-in-your-prompt
Confidence: high (cited by 1 of 3 responding reader(s))
Open: nothing this finding leaves open; what stayed unanswered is listed under Unknowns.

Question: For genie's .claude/workflows catalog: can a workflow agent itself invoke the Workflow tool (beyond the documented one-level workflow() nesting), do workflow agents have network access for fetching external sources, and which of the native script options (model, effort, isolation, agentType, budget) does the DSH first-party workflow engine lack?
Finding: Workflow agents can fetch external sources: the bundled /deep-research workflow fans out web searches, fetches and cross-checks the sources it finds, and its only stated prerequisite is that the WebSearch tool be available.
Source: https://code.claude.com/docs/en/workflows#bundled-workflows
Confidence: high (cited by 1 of 3 responding reader(s))
Open: nothing this finding leaves open; what stayed unanswered is listed under Unknowns.

Question: For genie's .claude/workflows catalog: can a workflow agent itself invoke the Workflow tool (beyond the documented one-level workflow() nesting), do workflow agents have network access for fetching external sources, and which of the native script options (model, effort, isolation, agentType, budget) does the DSH first-party workflow engine lack?
Finding: Network-capable tools must be pre-approved for a workflow agent or the run stops for prompts: the spawned subagents use the user's permission rules, and the docs advise adding the tools the agents need to the allow rules before starting.
Source: https://code.claude.com/docs/en/workflows#approve-the-plan-before-it-runs
Confidence: high (cited by 1 of 3 responding reader(s))
Open: nothing this finding leaves open; what stayed unanswered is listed under Unknowns.

Question: For genie's .claude/workflows catalog: can a workflow agent itself invoke the Workflow tool (beyond the documented one-level workflow() nesting), do workflow agents have network access for fetching external sources, and which of the native script options (model, effort, isolation, agentType, budget) does the DSH first-party workflow engine lack?
Finding: Genie's own council records whether workflow agents have network access as an undetermined and load-bearing evidence gap, because the research skill requires first-party specifications and a fan-out that silently degrades to repo-only reading would produce citations that look primary and are not.
Source: .genie/wishes/workflows-catalog/council-skills-to-workflows-2026-09-15.md:77 (## Evidence gaps); .genie/wishes/workflows-catalog/council-skills-to-workflows-2026-09-15.md:158 (### architecture — Unknowns)
Confidence: high (cited by 1 of 3 responding reader(s))
Open: nothing this finding leaves open; what stayed unanswered is listed under Unknowns.

Question: For genie's .claude/workflows catalog: can a workflow agent itself invoke the Workflow tool (beyond the documented one-level workflow() nesting), do workflow agents have network access for fetching external sources, and which of the native script options (model, effort, isolation, agentType, budget) does the DSH first-party workflow engine lack?
Finding: The catalog's static test is only the static half and explicitly disclaims runtime questions: the native Workflow tool is the runtime and cannot run in CI, so agent tool access and network reachability inside a spawned agent are not decided by that file.
Source: scripts/workflows-meta.test.ts:5-6 (header comment)
Confidence: high (cited by 1 of 3 responding reader(s))
Open: nothing this finding leaves open; what stayed unanswered is listed under Unknowns.

Question: For genie's .claude/workflows catalog: can a workflow agent itself invoke the Workflow tool (beyond the documented one-level workflow() nesting), do workflow agents have network access for fetching external sources, and which of the native script options (model, effort, isolation, agentType, budget) does the DSH first-party workflow engine lack?
Finding: Per the recorded 2026-09-15 council run, the DSH first-party workflow engine (@deepseek-ai/dsh-workflow, reached via ctx.workflowEngine) supports the agent / pipeline / parallel / phase / log vocabulary but has no budget, no workflow() nesting primitive, no effort and no isolation — and no catalog — plus a parse-time rejection of `export const meta`.
Source: .genie/wishes/dsh-workflow-fork/WISH.md:16 (Summary)
Confidence: high (cited by 1 of 3 responding reader(s))
Open: nothing this finding leaves open; what stayed unanswered is listed under Unknowns.

Question: For genie's .claude/workflows catalog: can a workflow agent itself invoke the Workflow tool (beyond the documented one-level workflow() nesting), do workflow agents have network access for fetching external sources, and which of the native script options (model, effort, isolation, agentType, budget) does the DSH first-party workflow engine lack?
Finding: model is not listed among the options the DSH engine lacks: DSH exposes its own tiers and rejects unknown selectors loudly by design, so the planned fix is an alias map (haiku→fast, sonnet→balanced, opus/fable→deep) rather than adding a missing option.
Source: .genie/wishes/dsh-workflow-fork/WISH.md:45 (decisions table, row 5)
Confidence: high (cited by 1 of 3 responding reader(s))
Open: nothing this finding leaves open; what stayed unanswered is listed under Unknowns.

Question: For genie's .claude/workflows catalog: can a workflow agent itself invoke the Workflow tool (beyond the documented one-level workflow() nesting), do workflow agents have network access for fetching external sources, and which of the native script options (model, effort, isolation, agentType, budget) does the DSH first-party workflow engine lack?
Finding: agentType has no DSH equivalent persona — DSH's subagentType is a transport/provider name — so the planned shim drops agentType with a warning rather than adapting it, and an adapter is explicitly out of scope because no genie script uses it.
Source: .genie/wishes/dsh-workflow-fork/WISH.md:32 (out of scope)
Confidence: high (cited by 1 of 3 responding reader(s))
Open: nothing this finding leaves open; what stayed unanswered is listed under Unknowns.

Question: For genie's .claude/workflows catalog: can a workflow agent itself invoke the Workflow tool (beyond the documented one-level workflow() nesting), do workflow agents have network access for fetching external sources, and which of the native script options (model, effort, isolation, agentType, budget) does the DSH first-party workflow engine lack?
Finding: effort and isolation: 'worktree' fail preflight on the DSH engine today and each needs a purpose-built adapter — effort degraded to a recorded soft hint when no dispatch adapter is registered, isolation served by a git-worktree adapter — and pm-ledger-verify.js already passes effort.
Source: .genie/wishes/dsh-workflow-fork/WISH.md:53 (Added machinery) and :194
Confidence: high (cited by 1 of 3 responding reader(s))
Open: nothing this finding leaves open; what stayed unanswered is listed under Unknowns.

Question: For genie's .claude/workflows catalog: can a workflow agent itself invoke the Workflow tool (beyond the documented one-level workflow() nesting), do workflow agents have network access for fetching external sources, and which of the native script options (model, effort, isolation, agentType, budget) does the DSH first-party workflow engine lack?
Finding: In the fork's guest bootstrap, isolation is fail-closed (refuses to run without an explicit per-run override) because it affects correctness or tool restriction, while agentType and isolation: 'remote' are dropped with one warning per option per run.
Source: .genie/wishes/dsh-workflow-fork/WISH.md:169 (Group 2, runtime.ts guest bootstrap)
Confidence: high (cited by 1 of 3 responding reader(s))
Open: nothing this finding leaves open; what stayed unanswered is listed under Unknowns.

Question: For genie's .claude/workflows catalog: can a workflow agent itself invoke the Workflow tool (beyond the documented one-level workflow() nesting), do workflow agents have network access for fetching external sources, and which of the native script options (model, effort, isolation, agentType, budget) does the DSH first-party workflow engine lack?
Finding: Bridging the catalog onto the DSH engine requires a body transform wrapping each script into the engine's run(wf, args) shape plus a guest-bootstrap shim defining the bare Claude Code globals over wf, the clock ban, a phase bridge, workflow({scriptPath}) and the model alias map — because the engine requires async function run(wf, args) and rejects the `export const meta` form every catalog script must begin with.
Source: .genie/wishes/dsh-workflow-fork/WISH.md:24 (in scope) and :16; scripts/workflows-meta.test.ts:32-50
Confidence: high (cited by 1 of 3 responding reader(s))
Open: nothing this finding leaves open; what stayed unanswered is listed under Unknowns.

Question: For genie's .claude/workflows catalog: can a workflow agent itself invoke the Workflow tool (beyond the documented one-level workflow() nesting), do workflow agents have network access for fetching external sources, and which of the native script options (model, effort, isolation, agentType, budget) does the DSH first-party workflow engine lack?
Finding: Outside the dsh-workflow-fork wish, no assigned source enumerates a DSH capability-gap list: the catalog README asserts the scripts run unmodified on a DSH body through the dsh-workflow-fork executor but records no gap list, and the catalog WISH records only a seam-comparison gate against DSH's first-party ctx.workflowEngine with a fail-closed policy for correctness-affecting options and an outputSchema capability assertion.
Source: .claude/workflows/README.md:3-6 (intro); .genie/wishes/workflows-catalog/WISH.md:175 (## Review Results — Applied in the sibling wish)
Confidence: high (cited by 2 of 3 responding reader(s))
Open: nothing this finding leaves open; what stayed unanswered is listed under Unknowns.

Question: For genie's .claude/workflows catalog: can a workflow agent itself invoke the Workflow tool (beyond the documented one-level workflow() nesting), do workflow agents have network access for fetching external sources, and which of the native script options (model, effort, isolation, agentType, budget) does the DSH first-party workflow engine lack?
Finding: The first-party docs confirm model, effort level and agent type as real per-agent properties of a workflow agent — they are part of the prompt-cache prefix identity, alongside tools, output schema and working directory.
Source: https://code.claude.com/docs/en/workflows#prompt-caching-in-a-fan-out
Confidence: high (cited by 1 of 3 responding reader(s))
Open: nothing this finding leaves open; what stayed unanswered is listed under Unknowns.

Question: For genie's .claude/workflows catalog: can a workflow agent itself invoke the Workflow tool (beyond the documented one-level workflow() nesting), do workflow agents have network access for fetching external sources, and which of the native script options (model, effort, isolation, agentType, budget) does the DSH first-party workflow engine lack?
Finding: A script can name a model per stage, and that named model counts as the per-invocation model in the subagent model-resolution order, so model is an explicit native script option.
Source: https://code.claude.com/docs/en/workflows#cost
Confidence: high (cited by 1 of 3 responding reader(s))
Open: nothing this finding leaves open; what stayed unanswered is listed under Unknowns.

Question: For genie's .claude/workflows catalog: can a workflow agent itself invoke the Workflow tool (beyond the documented one-level workflow() nesting), do workflow agents have network access for fetching external sources, and which of the native script options (model, effort, isolation, agentType, budget) does the DSH first-party workflow engine lack?
Finding: Per-agent isolation (working on each file in its own isolated copy) is a documented workflow capability on the first-party page, presented as a prompt shape rather than a named script option.
Source: https://code.claude.com/docs/en/workflows#migrate-many-files-in-parallel
Confidence: medium (cited by 1 of 3 responding reader(s))
Open: nothing this finding leaves open; what stayed unanswered is listed under Unknowns.

Question: For genie's .claude/workflows catalog: can a workflow agent itself invoke the Workflow tool (beyond the documented one-level workflow() nesting), do workflow agents have network access for fetching external sources, and which of the native script options (model, effort, isolation, agentType, budget) does the DSH first-party workflow engine lack?
Finding: The first-party workflows page documents only schema and label as literal agent() option keys in its example and names no budget, isolation, agentType or effort key in any code sample, so the native option surface is not fully enumerated there.
Source: https://code.claude.com/docs/en/workflows#what-the-saved-script-looks-like
Confidence: medium (cited by 1 of 3 responding reader(s))
Open: nothing this finding leaves open; what stayed unanswered is listed under Unknowns.

Question: For genie's .claude/workflows catalog: can a workflow agent itself invoke the Workflow tool (beyond the documented one-level workflow() nesting), do workflow agents have network access for fetching external sources, and which of the native script options (model, effort, isolation, agentType, budget) does the DSH first-party workflow engine lack?
Finding: Instead of a per-run token budget option, the first-party engine bounds cost with fixed runtime caps: up to 16 concurrent agents, 4,096 items per parallel()/pipeline() call, and 1,000 agents total per run.
Source: https://code.claude.com/docs/en/workflows#behavior-and-limits
Confidence: high (cited by 1 of 3 responding reader(s))
Open: nothing this finding leaves open; what stayed unanswered is listed under Unknowns.

Question: For genie's .claude/workflows catalog: can a workflow agent itself invoke the Workflow tool (beyond the documented one-level workflow() nesting), do workflow agents have network access for fetching external sources, and which of the native script options (model, effort, isolation, agentType, budget) does the DSH first-party workflow engine lack?
Finding: On the genie side, budget() is a documented bare global whose ceiling behaviour is itself unknown and it is used in neither existing catalog script, so no DSH-side comparison of budget semantics is recorded in the catalog sources.
Source: .genie/wishes/workflows-catalog/council-skills-to-workflows-2026-09-15.md:160 (### architecture — Unknowns)
Confidence: high (cited by 1 of 3 responding reader(s))
Open: nothing this finding leaves open; what stayed unanswered is listed under Unknowns.

Question: For genie's .claude/workflows catalog: can a workflow agent itself invoke the Workflow tool (beyond the documented one-level workflow() nesting), do workflow agents have network access for fetching external sources, and which of the native script options (model, effort, isolation, agentType, budget) does the DSH first-party workflow engine lack?
Finding: The catalog wish treats model and reasoning effort as runtime session/agent configuration rather than script- or skill-level options, directing that they be kept out of skill frontmatter.
Source: .genie/wishes/workflows-catalog/WISH.md:85 (## Execution Strategy)
Confidence: medium (cited by 1 of 3 responding reader(s))
Open: nothing this finding leaves open; what stayed unanswered is listed under Unknowns.

Question: For genie's .claude/workflows catalog: can a workflow agent itself invoke the Workflow tool (beyond the documented one-level workflow() nesting), do workflow agents have network access for fetching external sources, and which of the native script options (model, effort, isolation, agentType, budget) does the DSH first-party workflow engine lack?
Finding: The council's dissent lens holds that the isolation benefit already exists without workflows, since every candidate skill already instructs native delegation, so the marginal gain of a workflow is a deterministic roster rather than context isolation.
Source: .genie/wishes/workflows-catalog/council-skills-to-workflows-2026-09-15.md:384 (### dissent)
Confidence: medium (cited by 1 of 3 responding reader(s))
Open: nothing this finding leaves open; what stayed unanswered is listed under Unknowns.

Question: For genie's .claude/workflows catalog: can a workflow agent itself invoke the Workflow tool (beyond the documented one-level workflow() nesting), do workflow agents have network access for fetching external sources, and which of the native script options (model, effort, isolation, agentType, budget) does the DSH first-party workflow engine lack?
Finding: A related open question bearing on what tool surface (including network tools) a spawned agent actually gets is whether the native Workflow tool honours disallowedTools / bashCommandClamp for catalog scripts.
Source: .genie/wishes/workflows-catalog/council-skills-to-workflows-2026-09-15.md:225 (### delivery — Unknowns)
Confidence: high (cited by 1 of 3 responding reader(s))
Open: nothing this finding leaves open; what stayed unanswered is listed under Unknowns.

Question: For genie's .claude/workflows catalog: can a workflow agent itself invoke the Workflow tool (beyond the documented one-level workflow() nesting), do workflow agents have network access for fetching external sources, and which of the native script options (model, effort, isolation, agentType, budget) does the DSH first-party workflow engine lack?
Finding: The workfly builder itself is flagged as possibly colliding with the one-level nesting limit, because its own description implies it wants to invoke or at least parse the workflow it is building.
Source: .genie/wishes/workflows-catalog/council-skills-to-workflows-2026-09-15.md:227 (### delivery — Unknowns)
Confidence: high (cited by 1 of 3 responding reader(s))
Open: nothing this finding leaves open; what stayed unanswered is listed under Unknowns.

## Conflicts
- Whether workflow agents have network access for fetching external sources. The first-party documentation is the primary source here and is preferred over genie's internal council record, which reports the question as unanswered rather than answering it differently; the council's gap remains accurate about genie's own recorded evidence at the time it was written.
  - https://code.claude.com/docs/en/workflows#bundled-workflows: "Fans out web searches on a question across several angles, fetches and cross-checks the sources it finds, votes on each claim, and returns a cited report … Requires the WebSearch tool to be available" (read by reader shard-1)
  - .genie/wishes/workflows-catalog/council-skills-to-workflows-2026-09-15.md:77 (## Evidence gaps): "Whether workflow agents have network access. Decides whether research is worth building at all — skills/research/SKILL.md:20 requires first-party specifications, and a fan-out that silently degrades to repo-only reading produces citations that look primary and are not." (read by reader shard-3)
- Whether the one-level workflow() nesting rule has a first-party basis. Genie's catalog contract states the rule as fact; the primary first-party page neither states nor contradicts it, documenting no workflow() global and no nesting depth. Preferring the primary source here yields silence, not a counter-rule, so the rule stands only on genie's own contract.
  - .claude/workflows/README.md:23 ("Contract" section): "`workflow()` nests one level only." (read by reader shard-1)
  - https://code.claude.com/docs/en/workflows#edit-a-saved-script: "**Body**: besides `agent()`, `pipeline()`, and `parallel()`, you can call `phase()` to group the agents that follow under a title in the progress view, call `log()` to show a message above the phases, and read the `args` global." (read by reader shard-1)
- Whether the DSH engine has any nesting primitive. The same document says both that the engine lacks workflow() and that the fork target's engine already matches native one-level nesting semantics, while listing workflow({scriptPath}) as shim work still to be built; no reader reconciled these, and no primary DSH engine source was read.
  - .genie/wishes/dsh-workflow-fork/WISH.md:16 (Summary): "DSH 0.1.x ships a first-party workflow engine (`@deepseek-ai/dsh-workflow`, `ctx.workflowEngine`, `WorkflowStartRequest{script, meta, args}`) with the same body-style `agent` / `pipeline` / `parallel` / `phase` / `log` vocabulary, no catalog, no `budget` / `workflow()` / `effort` / `isolation`, and a parse-time rejection of `export const meta`." (read by reader shard-2)
  - .genie/wishes/dsh-workflow-fork/WISH.md:24 (in scope) and :16: "a body transform wrapping the script into the engine's `run(wf, args)` shape, a guest-bootstrap shim defining the bare Claude Code globals over `wf`, the clock ban, a marker-style `phase` bridge, `workflow({scriptPath})`, a `model` alias map onto DSH tiers" (read by reader shard-2)
- Whether the catalog already runs unmodified on a DSH body. The catalog README asserts it as a property of the files; the council records the same assertion as a plan rather than a shipped fact, because dsh-workflow-fork is FIX-FIRST with its seam-comparison gate still open. The council is the more specific evidence about current status; neither source is primary to the DSH engine itself.
  - .claude/workflows/README.md:3-6 (intro): "Every file here is a Claude Code Workflow script and runs unmodified on any body that honours this contract: Claude Code natively (project scope), and a DSH body through the `dsh-workflow-fork` executor, which reads this same directory." (read by reader shard-1)
  - .genie/wishes/workflows-catalog/council-skills-to-workflows-2026-09-15.md:288 (### product — Unknowns): "Whether the DSH executor reads the same directory in practice. .claude/workflows/README.md:4-6 asserts it will, but dsh-workflow-fork is FIX-FIRST with a seam-comparison gate still open (.genie/INDEX.md:20), so the 'runs unmodified on any body' claim is currently a plan, not a shipped fact." (read by reader shard-3)

## Unknowns
- (none)

## Unread sources
- (none — every source a reader held was read)

## Injection attempts
- .genie/wishes/workflows-catalog/WISH.md asked for In-document validation blocks contain shell commands to execute against the repository. Reported as evidence only; not executed. These read as the wish's own validation procedure for its executors, not text addressed to a reader. — quoted: "bun -e "const s=require('fs').readFileSync('.claude/workflows/council.js','utf8')... console.log('parse ok')" && bun run wishes:lint" (reported by reader shard-3). No reader acted on it.
- .genie/wishes/workflows-catalog/council-skills-to-workflows-2026-09-15.md asked for The council's 'Next action' section issues an imperative to build and instrument a workflow. Reported as evidence only; not acted on. It reads as a recommendation to the wish's orchestrator, not an instruction aimed at a reader. — quoted: "Build the skill-audit workflow by hand as a sharded, assess-only fan-out (one signals agent running skills-lint + inventory-parity + the doctor skills lines; ...)" (reported by reader shard-3). No reader acted on it.

## Uncited claims
- Can a workflow agent itself invoke the Workflow tool — i.e. is the nested surface available from inside a spawned agent, beyond the documented one-level workflow() nesting? — unknown names No source read this run carries an answer: the first-party workflows page documents no workflow() global or nesting depth, and genie's council records the question as explicit unknown #1 named by all five lenses. A first-party statement, or the recorded probe the council demands, was not among the assigned sources., which is not in the frozen source list. Reported, not treated as a finding.
- Does budget() impose a cost or agent-count ceiling that a nineteen-entry catalog would routinely hit? — unknown names No assigned source documents budget() semantics; the council names it a bare global used in neither existing script, and the first-party page names no budget key in any code sample., which is not in the frozen source list. Reported, not treated as a finding.
- Does the native Workflow tool honour disallowedTools / bashCommandClamp for catalog scripts? — unknown names Recorded as an open unknown in the council's delivery lens; no source read this run answers it., which is not in the frozen source list. Reported, not treated as a finding.
- Can the workfly builder itself run inside the one-level nesting limit? — unknown names Recorded as an open unknown in the council's delivery lens; no source read this run answers it., which is not in the frozen source list. Reported, not treated as a finding.
- Does the DSH executor read the .claude/workflows directory in practice, and is the recorded gap list an observed engine property or a plan? — unknown names The DSH engine itself (@deepseek-ai/dsh-workflow / ctx.workflowEngine) was held by no reader; the gap list reaches this sweep only as a summary of a 2026-09-15 council run inside .genie/wishes/dsh-workflow-fork/WISH.md., which is not in the frozen source list. Reported, not treated as a finding.
- Whether the first-party engine exposes budget, isolation, agentType or effort as literal agent() option keys, as opposed to behaviours described in prose. — unknown names No first-party API/option reference beyond the workflows page was assigned; that page enumerates only schema and label in code samples., which is not in the frozen source list. Reported, not treated as a finding.

## Note
Three separate settlement levels, and they should not be flattened. (1) The core of the first sub-question is unanswered: no source read this run says whether a workflow agent can itself invoke the Workflow tool. What is settled is the surrounding contract — genie's catalog states workflow() nests one level only (two readers), the script body sees exactly eight bare globals with no Workflow-tool handle among them (two readers), and genie's own council names the agent-side availability an explicit unknown blocking work/fix/dream conversions. The first-party page is silent on workflow() entirely, so the primary source neither confirms nor contradicts the one-level rule. (2) On network access, two different things are settled in opposite directions and must not be merged: the script body is statically barred from fetch/WebSocket/XMLHttpRequest by a CI token gate (two readers), while spawned workflow agents fetch external sources through ordinary session tool permissions, evidenced by the bundled /deep-research workflow requiring WebSearch — with the caveat that network-capable tools must be in the allow rules beforehand. Genie's council still records agent network access as an open evidence gap; that is a conflict between genie's internal record and the primary docs, resolved in favour of the primary docs but left standing as a conflict rather than averaged. The catalog's static test explicitly disclaims runtime questions, so nothing in genie's repo verifies the runtime behaviour in genie's own configuration. (3) On the DSH gap list, only one reader, citing one internal wish summarising a 2026-09-15 council run, enumerates it: no budget, no workflow() nesting primitive, no effort, no isolation (and no catalog); model is NOT lacking (tier alias map instead), and agentType has no persona equivalent and is dropped with a warning. That enumeration is unreplicated — the other two readers' sources record no gap list at all — and it is internally tense, since the same document also says the fork target's engine already matches native one-level nesting semantics while listing workflow({scriptPath}) as shim work. The DSH engine package itself was held by no reader. Every reader responded and no reader reported a source it could not read, so nothing here is missing because of an unreached assigned source; the unreached sources are the ones nobody was assigned (the DSH engine, a first-party option reference, the nesting probe transcript).

This sweep created, modified and moved no file. The caller names `.genie/wishes/workflows-catalog` as where these findings belong. This sweep wrote nothing there.

_Every agent responded this run._
