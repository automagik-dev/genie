# DRAFT: council-workflow — specialist-panel as native workflow, replacing council

> Slug renomeado panel-workflow → council-workflow após decisão 3 (/council é o nome vencedor).

**Status:** Raw · **Date:** 2026-07-09 · **Related:** [skill-absorbs](../skill-absorbs/DRAFT.md) (umbrella G4 — council ruling), [genie-token-efficiency-program](../genie-token-efficiency-program/DESIGN.md)

## GOAL (user's words)

Turn `/specialist-panel` into a native reusable well-thought workflow (Claude Code dynamic workflows, https://code.claude.com/docs/en/workflows.md) and use it to replace the current genie council.

## KNOWN (evidence)

### The two things being unified
- `~/.claude/skills/specialist-panel/SKILL.md` (personal, 6.1K): 7-lane repo AUDIT — Chacon/Ousterhout/Hejlsberg/Beck/Gregg/Lorenc/Procida personas as parallel Agent-tool subagents; dedupe → conflict-resolution → global re-rank synthesis; assess-only; writes `.genie/repo-profile.md` (single-writer); authority boundary: findings → `/wish`, never a parallel approval mechanism.
- `skills/council/` (genie repo, shipped via plugin): topic DELIBERATION — 10 lens members, smart routing to 3-4, 2-round Socratic (round 2 via SendMessage continuing sessions), dissent-preserving report, advisory-only, no voting. Members/config: all inherit model. Supporting files: members/routing.md, members/config.md, templates/report.md.
- The 7 persona skills live in `~/.claude/skills/` (personal) — NOT shipped with genie. Full methodologies with ground-truth discovery steps, not just lens one-liners.

### Prior ruling (skill-absorbs, Felipe 2026-07-09)
- council → lens LIBRARY (consumed by review panels + brainstorm domain-experts) + THIN `/council` route preserved (strategy pre-artifact, dissent preservation, appeal court for reviewer↔gate disagreements).
- Open GAP there: "/council users besides Felipe? keep `/council` name or `genie council`?"
- Collision noted: skills-fable5-revamp execution review pending on same files.
- **This brainstorm is the concrete implementation vehicle for the council disposition** — the "thin route" becomes a launcher for the native workflow engine.

### Native workflow facts (docs fetched 2026-07-09)
- Script = `export const meta {...}` + JS body; `agent()/pipeline()/parallel()/phase()`; schema-validated structured outputs; per-agent model/effort overrides.
- Saved workflows: `.claude/workflows/` (project) or `~/.claude/workflows/` (personal) → become `/<name>` commands; accept `args` (structured, no parsing). **Plugin-shipped workflows: UNVERIFIED — background check dispatched.**
- Script has NO fs/shell access — agents do all IO. No mid-run user input. Background, resumable (same session), `/workflows` progress view, per-agent token visibility.
- Skill-instructed Workflow launch counts as explicit user opt-in (skill = thin route calling Workflow tool = legit pattern).
- No SendMessage inside workflows → Socratic round 2 must be fresh agents fed round-1 transcripts via prompt (arguably better: no continuation flakiness, resumable, parallel).

### Distribution context
- Genie ships as plugin `genie` (marketplace `automagik`, repo root `.claude-plugin/marketplace.json`); `plugins/genie/skills -> ../../skills` symlink; plugin also ships agents/ (scout, engineer-*, reviewer, final-gate, fixer — routing-matrix pinned), hooks, rules, references.
- `${CLAUDE_SKILL_DIR}` interpolation in skills is established practice (plugin-resource-shipping wish) → a thin skill can resolve plugin-relative lens paths and pass them as workflow args.

## TENSIONS / OPEN

1. **Replace semantics (Q1 → asked):** unified parameterized panel engine (audit + deliberation modes, one script) vs audit-only port (council's Socratic mode dies) vs two sibling workflows sharing lens library.
2. **Persona custody:** absorb 7 heavyweight persona skills into genie's lens library (genie owns; dual-maintenance vs personal copies) vs args-driven "bring your own lenses" with genie shipping only lightweight lenses.
3. **Invocation UX + naming:** `/council` vs `/panel`; saved-workflow-command vs thin-skill-launches-Workflow. Depends on plugin-workflow verification (background agent).
4. **Fate of personal `~/.claude/skills/specialist-panel`** after genie ships the engine.
5. **Fix-routing for non-Felipe users:** panel prescribes "run <persona skill> to fix" — genie-native answer is findings → `/wish` (already the panel's genie-repo path). Confirm.
6. **Repo-profile write:** keep single-writer merge — in workflow-land the synthesis/persist stage agent is the writer.
7. **Sequencing/collisions:** skills-fable5-revamp execution review + control-plane-contract touch same skill files; how to record vs skill-absorbs G4 (this supersedes part of it).

## DECIDED

1. **Replace semantics = engine unificado, 2 modos** (Felipe, 2026-07-09): UM workflow parametrizado (args: mode, topic/focus, roster). Modo `audit` = specialist lanes sobre repo; modo `deliberation` = council lenses sobre decisão, com round 2 socrático via agents frescos alimentados com round 1. Uma lens library alimenta ambos. `skills/council/` morre como orquestrador; thin `/council` route vira launcher do engine (consistente com ruling skill-absorbs G4).

2. **Persona custody = absorver como skills do plugin** (Felipe, 2026-07-09): as 7 persona SKILL.mds migram pro repo genie e shipam via plugin. O workflow lê o MESMO arquivo como lens (fonte única, zero drift); cada persona fica invocável standalone pra fix-mode por qualquer usuário genie. Cópias pessoais de Felipe aposentam. Council sai, suas 10 lentes fundem na mesma library (mapear overlaps: benchmarker≈Gregg, sentinel≈Lorenc, ergonomist≈Procida, architect≈Ousterhout...; lentes sem lane par — questioner, operator, deployer, measurer, tracer, simplifier — viram lens cards de deliberação).

3. **Entrada única = `/council`, absorve audit** (Felipe, 2026-07-09): council é O nome do engine. `/council <tópico>` → deliberation; `/council audit [focus]` → audit (7 lanes). O nome specialist-panel aposenta. Fecha o GAP do skill-absorbs ("keep /council name?" → SIM, e vira a entrada de tudo). Uma rota, um workflow script, dois modos por preset.

4. **Escopo = incluir consumidores** (Felipe, 2026-07-09): o wish TAMBÉM rewira `/review` (panels multi-lens por change-type) e `/brainstorm` (o passo "dispatch 2-3 lens subagents" passa a ler lens cards da library). Entrega a visão G4 completa. Consequência: colisão com skills-fable5-revamp vira dependência de sequenciamento explícita.
5. **Naming público = renomear por lane, inspiração citada** (Felipe, 2026-07-09): skills shipam como `repo-hygiene`, `architecture`, `code-quality`, `qa`, `perf`, `supply-chain`, `dx-docs`; corpo cita "lens inspired by the work of <expert>". Zero nome de pessoa real como identidade de produto. Cópias pessoais de Felipe podem manter os nomes antigos até aposentar.

### Resolvidos por consequência (não perguntados)
- Fix-routing p/ usuários genie: personas shipam como skills standalone (decisão 2) → "run <lane skill> and fix" funciona pra todos; em repos genie a authority boundary continua findings→`/wish`.
- Repo-profile: mantém single-writer — o stage de synthesis/persist do workflow é o único escritor de `.genie/repo-profile.md`.
- Skills pessoais de Felipe (specialist-panel + 7 personas): aposentam após o ship (hygiene local dele, fora do escopo do repo).
- Lens library unificada: 7 persona SKILL.mds (modes: both — voz + metodologia) + 6 lentes council-only (questioner, simplifier, operator, deployer, measurer, tracer; cards leves). As 4 lentes redundantes do council (benchmarker≈perf, sentinel≈supply-chain, ergonomist≈dx-docs, architect≈architecture) morrem; routing table remapeada pra apontar pros persona skills. 13 lentes totais.
- Round 2 socrático em workflow: agents FRESCOS por round (round 2 recebe a própria posição round-1 do membro + as dos outros via prompt). Sem SendMessage — mais resumível/cacheável; perde continuidade de sessão (aceito).
- Audit mode: round1 lanes → synthesis (dedupe/conflito/re-rank global) → persist profile. Deliberation: round1 → round2 → synthesis (consenso/tensões/dissent). templates/report.md absorvido no prompt de synthesis.
- Council engine passa a exigir Claude Code (workflow runtime) — alvo Codex/Hermes fica OUT (o council antigo via Agent tool já era CC-only na prática).

6. **Launch = saved workflow como comando** (Felipe, 2026-07-09): `/council` é o próprio saved workflow (meta name 'council'); o modelo media args estruturado na invocação; routing table vive como dado JS no script. SEM skill intermediária de orquestração.

### Verificação de distribuição (2026-07-09, plugins-reference fetch direto)
- **Plugins NÃO shipam workflows.** Component path fields completos: skills, commands, agents, hooks, mcpServers, outputStyles, lspServers, experimental.themes, experimental.monitors, userConfig, channels, dependencies. Zero menção a workflows na referência inteira.
- **Mecanismo resolvido:** `genie install`/`update` (smart-install.js roda com `CLAUDE_PLUGIN_ROOT` — linha 19) estampa `LENS_ROOT` (path absoluto do plugin instalado) num template `council.js` e copia pra `~/.claude/workflows/council.js`. Disponível em todo projeto do usuário; re-stamp a cada update — necessário porque o path do plugin MUDA em update (docs: "This path changes when the plugin updates").
- **Self-healing:** o script não tem fs/env; um stage-0 resolver agent (barato) verifica os lens paths estampados e localiza via Glob se stale.
- **Colisão de nome evitada:** `skills/council/` morre INTEIRO — precedência skill-vs-workflow pro mesmo nome `/council` é indocumentada, não arriscar. Os 6 lens cards de deliberação vão pra `plugins/genie/references/lenses/` (references/ já existe no plugin).
- Precedência documentada: project workflow > personal — um repo pode dar override no council com `.claude/workflows/council.js` próprio (feature, não bug).
- **Cross-check cc-guide (2026-07-09):** relatório independente confirmou tudo (sem workflows em plugin components; interpolação `${CLAUDE_PLUGIN_ROOT}`/`${CLAUDE_PLUGIN_DATA}`/`${CLAUDE_PROJECT_DIR}`/`${CLAUDE_SKILL_DIR}`; args model-mediated). Fato novo: `${CLAUDE_PLUGIN_DATA}` persiste através de updates — alternativa de mitigação pro stamp-staleness (copiar lenses pra data-dir estável e estampar esse path), registrada mas NÃO adotada: re-stamp no update + stage-0 resolver já cobre, e a cópia data-dir criaria seu próprio drift.

## SCOPE (draft)
**IN:** `council.js` saved workflow (engine 2 modos, routing como dado JS), lens library unificada (13: 7 lane skills + 6 cards em references/lenses/), 7 persona skills renomeadas por lane, stamp+copy no install/update (smart-install), morte de `skills/council/` inteiro (routing/config/report absorvidos), rewiring `/review` panels + `/brainstorm` domain-experts, lints (lens frontmatter, refs probe-guarded, workflow script structural), docs.
**OUT:** rewiring de outros consumidores (work/fix/pm), Codex/Hermes support pro engine, autonomia dream/scheduler, mudanças no routing-matrix dos role agents, deleção das skills pessoais de Felipe (hygiene local), CLI `genie council` (term-command), `.claude/workflows/` scaffold por repo via `genie init` (override por repo fica como feature documentada, não entregue).

## RISKS (draft)
| Risco | Sev | Mitigação |
|---|---|---|
| fable5-revamp execution review pendente nos MESMOS arquivos de skill | HIGH | Waves: começar por arquivos novos (personas, council.js, lenses/); edits em review/brainstorm + deleção do council só após aquele review fechar (dependência explícita no wish) |
| Stamp de LENS_ROOT stale (plugin path muda em update; user não re-roda install) | MED | Re-stamp no fluxo de update + stage-0 resolver agent com Glob-fallback (self-healing) |
| Custo: audit ≈ 9-10 agents no modelo da sessão | MED | Lane narrowing (`/council audit <focus>`), nota de custo no report/docs, tokens visíveis em /workflows |
| Sem input mid-run (workflow) — perde supervisão do orquestrador | LOW | Schema-validated returns por stage; regra ≥2 membros do council preservada no script |
| Primeira execução pede aprovação do workflow por projeto | LOW | Documentar; "don't ask again" per-project |
| Workflows exigem CC ≥ 2.1.154 + plano pago; org pode desabilitar (`disableWorkflows`) | LOW | Documentar requisito; sem fallback degradado (decisão: engine é CC-only) |

## CRITERIA (draft — fail-hard)
- [ ] Lint estrutural do council.js: meta name 'council', zero Date.now/Math.random/new Date()/require/fs/import, parse ESM ok
- [ ] Lint da lens library: toda entrada da routing table aponta pra lens file existente; todo lens tem frontmatter obrigatório
- [ ] 7 lane skills existem com nomes de domínio; grep-gate: nenhum nome de pessoa real em `name:`; linha de inspiração presente
- [ ] git grep -i 'specialist-panel' → 0 hits fora de attic/CHANGELOG; members/config.md + routing.md do council antigo removidos/absorvidos
- [ ] /review e /brainstorm referenciam paths da library que existem (probe-guarded refs)
- [ ] bun run check verde
- [ ] QA vivo (manual): 1 run deliberation + 1 run audit no repo genie, evidência no wish

## WAVES (seed p/ wish)
| Wave | Grupos | Nota |
|---|---|---|
| 1 | G1 persona skills (dirs novos) ∥ G2 council.js engine + lens cards + stamp no install (files novos) | zero colisão com fable5-review |
| 2 | G3 cutover: morte de skills/council/ + purge de referências | depende G1+G2 + fable5 execution review fechado |
| 3 | G4 consumidores (/review, /brainstorm) | depende G3 |
| 4 | G5 lints wired no check + docs + QA vivo | depende G3 (lints) / G4 (docs) |

## REVIEW GATE (2026-07-09)

- **Design review: SHIP** (reviewer independente; 0 CRITICAL / 0 HIGH remanescente — o HIGH de consumer-wording foi corrigido mid-review e re-verificado). 4 MEDIUMs aplicados no plano na hora: g4 gate estrutural, stamp site pinado no SessionStart hook (antes dos early-exits, idempotente), banned-API gate re-sourçado no spec do Workflow tool, gate G3 endurecido pra fable5 MERGED + rebase. LOWs: wording "rewired" corrigido; denylist de sobrenomes explicitada; `meta.phases` NÃO é defeito — o spec do Workflow tool documenta `phases` como campo opcional do meta (workflows.md só mostra o exemplo mínimo).
- Reviewer confirmou sound: plugins-sem-workflows (verbatim), runtime facts, council/panel/personas como descritos, layout do plugin, mapping 10→13, DAG válido, Wave 1 genuinamente new-files-only, role agents corretamente OUT.
- **Plan review (WISH): SHIP** (mesmo reviewer; 0 CRITICAL/HIGH). MEDIUM novo aplicado: gate do G2 tornado self-contained (parse ESM via bun build, cards-only) e integridade 13-lens completa movida pro lint a partir do G3 — preserva Wave 1 paralela. LOWs aplicados: g5 prova comportamentalmente que o lint roda DENTRO do check (grep no output); ban amplo de `new Date(` mantido de propósito (documentado no script). Status do wish: DRAFT — reviews SHIP, `/work` user-gated.

## WRS: ██████████ 100/100 — Problem ✅ | Scope ✅ | Decisions ✅ | Risks ✅ | Criteria ✅ → crystallized em DESIGN.md (2026-07-09)
