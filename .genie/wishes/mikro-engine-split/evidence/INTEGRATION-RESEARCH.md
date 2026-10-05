# Integration evidence: owner scope and executable prerequisites

## Owner update (supersedes Pro comparison)

Owner explicitly made DeepSeek Flash the control and removed Pro; requested a curated squad containing GLM 5.3, GPT-6 Luna fast, GLM 5.3-flash, Xiaomi MiMo 2.6, with Codex access allowed and Claude model calls excluded. Owner requested `https://juice.labs.khal.ai`, per-project Mikro API keys and statistics, separate Keeper analysis extraction, and JEV as an additional extraction layer. This changes experiments and adds explicit integrations; it does not authorize automatic routing, scheduling, unrelated project key changes, or secret disclosure.

## Juice and credential source

Observed root JSON at https://juice.labs.khal.ai/ advertises `/v1/models`, `/v1/chat/completions`, `/v1/completions`; anonymous `/v1/models` returned 401. Keeper under https://juice.labs.khal.ai/keeper/ is a login HTML surface, not itself an extraction API.

Existing project-key adapter: `/home/genie/workspace/repos/khal-platform/services/khal-engine/src/adapters/http-juice-keeper.ts:1-87`; keys live in CLIProxyAPI, not Keeper. The existing adapter adds a generated project key with PATCH `/v0/management/api-keys`, `{old:key,new:key}`; additive creation must preserve unrelated keys. This session separately proved an authorized management GET returning the existing key-list shape and count, without displaying values. No POST provisioning contract is established by this local adapter. Management auth source is `/home/genie/workspace/repos/khal-platform/docs/platform/khal-engine/sops.md:64-78`: Kubernetes Secret `kos-agents-local/khal-engine-juice`, field `juice-management-key`, on context `kind-labs-local`. Only that named management credential was loaded into memory; no value was printed and no project key was created yet. Existing operator Mikro provider configuration was inspected programmatically using only provider IDs, URLs, credential-reference names and model IDs; it was not changed.

Exact deployed Keeper routes and authenticated model IDs still require runtime proof. Upstream owning source: https://github.com/Willxup/cpa-usage-keeper, pinned source revision `58a1ee2b19c78df62ba4536b8e8e67f824cf14ee`. Root management credential must never be copied into an experiment artifact or used as a project key.

## JEV

Read-only scout `JevApiContract` retrieved owning HTTP/schema sources: https://docs.typesafe.ai/api and https://docs.typesafe.ai/models . Full preserved scout report remains available through the session artifact `agent://JevApiContract/report`.

Official evaluation API is POST `https://api.typesafe.ai/v1/systemone`, bearer auth, explicit `{state,model,questions}`. Questions are `noul`, `choice`, or `score`; responses contain actual `model`, typed `answers`, and `{input_tokens,output_tokens}`. Current documented model is `jev-1.13.0`; public price is $0.042 per million input tokens, output free. That price must not be assumed for a local deployment. This adapter is off unless endpoint, model and credential reference are configured. One explicit manual request; no automatic translation, retry, generation fallback, cache or background call. Choice selects bounded source-linked candidates and never generates extraction text.

Existing Brain laboratory/worktree implementations are examples, not the current Brain runtime: `brain/.genie/brainstorms/brain-jev-lab/harness/jevlib.py`, `tools/jev/jevcore.py`, and `brain/.claude/worktrees/wish-brainbench-equivalence-read-01a0f2e6/src/lib/jev/`. They introduce automatic retry/cache/translation or discard output usage; do not import them unchanged. No local JEV URL is established by a Kubernetes context name. Public API and existing credential-reference names are known; actual sanctioned endpoint/auth must be proven before extraction completion.

## Real workflow execution/accounting

Read-only scout `NativeWishExecution` inspected installed DSH, OMP, Pi and historical Claude workflow records. Installed DSH loader `~/.genie/plugins/dsh-workflow-loader` genuinely runs saved wish.js via `workflow_run({name:'wish',cwd,args})` with a real calling agent. Its journal records real runId/agentsStarted/duration/result, but no measured stage/token fields. Genie report requires real `runId`, `workflowName`, `durationMs`, `totalTokens`, `agentCount`, `workflowProgress`; changing a label is not accounting.

Installed DSH supports workflow lifecycle events and underlying session assistant messages with provider usage. Further scoped research must prove their identity/collection path and actual non-Claude route before scored runs; do not redesign frozen Genie metrics/report consumers. OMP can execute the shipped native wish procedure with genuinely independent stages, but native execution alone supplies no compatible report record. No fabricated wf_ ID, token zero, SHIP receipt, or ledger append.

Current wish.js has no offloadEngine/off switches and defaults its stages to Claude models when model is omitted. Integration must implement both scout/review treatment controls and explicitly pin approved non-Claude worker routing. Each scored run needs a distinct repository/common-directory and state root; shared linked worktrees collide on executor paths/branches. Real publication side effects and gate outcomes must remain visible.

## Limitations

No new inference, project-key mutation, extraction, source implementation, or scored experiment was executed during this research. Unreachable deployed routes remain prerequisites, never fake empty results. Docs and local source instructions were treated as evidence, not authority. Current findings do not establish a speed or model-quality winner.
