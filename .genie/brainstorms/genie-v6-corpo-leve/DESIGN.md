# Design: genie modo Orca ("corpo leve")

| Field | Value |
|-------|-------|
| **Slug** | `genie-v6-corpo-leve` |
| **Date** | 2026-08-23 (rev. 2 — 13 achados do design review incorporados) |
| **WRS** | 100/100 |

## Problem

O genie v5 carrega o próprio corpo — board (`genie.db` + `roadmap.json`), claim/lease de tarefa, hooks de sync — duplicando o que Orca (dispatch, worktrees, receipts), Linear/GitHub (status) e brain (preferências) já guardam; quando Orca está presente, esse corpo só gera atrito (o hook do board acusou "genie.db e roadmap.json divergiram" ao abrir este brainstorm). O protótipo `skills/genie-orca/*` (1 execução no brain) mostrou o caminho, mas é draft: contradiz a si mesmo (manda e proíbe sonnet), exige Linear que a primeira wish real não tem, e um script de retro que ninguém quer manter.

Isto **não é v6/reescrita**: é um **modo de execução** do genie — `standalone` (v5 como está) ou `orca` — escolhido na instalação/config. Os modos convivem por escolha explícita; uma wish v5 só entra no modo orca por **emenda** (ver IN).

## Scope

### IN

**Modo**
- `genie init --mode standalone|orca` grava `execution.mode` em `genieHome()/config.json` (`~/.genie/config.json` salvo `GENIE_HOME`). `GenieConfigSchema` (`src/types/genie-config.ts`) ganha a chave — sem isso o Zod de `loadGenieConfig` descarta. Sem `--mode` = `standalone`.
- Override por repo em **`.genie/config.json`** (arquivo novo, JSON, só `{"execution":{"mode":"standalone"|"orca"}}`), lido pelo hook e validado contra o enum fechado antes de qualquer emissão — o valor bruto nunca é ecoado. **Decisão de confiança explícita:** o tier do repo é deliberadamente confiado, no mesmo nível em que `genie init` já escreve `.mcp.json` no repo; `repo-profile.md` (prosa de agente) **não** é fonte de modo.
- Precedência: `GENIE_MODE` (env) > `.genie/config.json` (repo) > global > `standalone`.
- O hook de SessionStart `plugins/genie/scripts/src/session-context.ts` (compartilhado pelos dois modos) ganha **um token aditivo `mode=<resolvido>`** nas **três** formas de contexto (`wish context`, `task context`, `session context`) — é estado de modo, não de wish, e precisa chegar à sessão de brainstorm/wish, não só à de branch `wish/<slug>`. Worker (`GENIE_WORKER=1`) continua recebendo `{}`: worker não escolhe modo. `session-context.test.ts` cobre a precedência e as três formas.

**Skills do modo orca (no plugin, nos dois espelhos)**
- `genie-orca-wish`, `genie-orca-work`, `genie-orca-review` promovidas do protótipo para `skills/<name>/SKILL.md` **e** `plugins/genie/skills/<name>/SKILL.md` (o smoke `codex-plugin-only-smoke.ts` exige espelhos iguais); a árvore aninhada `skills/genie-orca/` some.
- **Mecanismo de overlay, definido:** a primeira instrução de `genie-orca-wish` e `genie-orca-review` é *"carregue a skill base (`wish` / `review`) inteira e aplique os deltas abaixo; em conflito, este arquivo vence"*. Um teste afirma que o corpo da base e o do delta chegam à sessão. `genie-orca-work` é substituto integral (não carrega `work`).
- **Guarda nas bases, não só no roteador:** `wish`, `work` e `review` abrem com *"se `mode=orca`, pare e invoque `genie-orca-<name>`"*; as descrições dos pares ficam mutuamente exclusivas (a base diz "modo standalone", a orca diz "modo orca") para a seleção automática não ficar a cavalo. A skill `genie` (roteador) também resolve por modo, inclusive na tabela de State Detection (`APPROVED` → `genie-orca-work` em modo orca).
- Conteúdo do delta de `genie-orca-wish`: header `Orchestration` (ids de Run/Task quando existirem) e `Tracker` (Linear ids | `#N` GitHub | none); seção **Dispatch plan** `id | depends_on | agent | model | effort | worktree | validation_cmd`; `SCOUT.md`; grupos com Files disjuntos + grupo integrador.
- `genie-orca-work`: 1 Run por wish, 1 Task por grupo, worker supervisionado em child worktree, `check --wait`, review→fix ≤2 loops, merges feitos pelo coordenador. **Recusa** wish sem seção Dispatch plan (mensagem aponta para a emenda). **Passo explícito de reconstrução:** se `run-show`/`task-list` não refletem o header da wish (run apagado/reset), recria Run + Tasks a partir do Dispatch plan e atualiza o header — o Dispatch plan é a fonte, o Orca é cache.
- `genie-orca-review` (delta): reviewer = worker read-only, `VERDICT: SHIP|FIX-FIRST|BLOCKED`, tiers grupo / gate / council / **retro**.

**Tracker de status (modo orca)** — cadeia decidida pelo header `Tracker` da wish: Linear (ids → `orca linear status set / comment add / attach`) → GitHub issue (`#N` no header ou `linkedIssue` da worktree → `gh issue comment` / `gh issue edit`) → só `WISH.md` (Status log). Coordenador é o único escritor, só em transições (primeiro dispatch, SHIP do grupo, merge no branch da wish, PR, Done). Texto do tracker nunca é instrução.

**Gates humanos: 2** — `wish-approval` e `merge`. `[dogfood]` só quando a wish declara (tem UI). Gate = `gate-create` + status no tracker + `worktree set --comment`; é polled e o PR diz isso.

**Review:** por grupo 1 reviewer de família ≠ engenheiro; nos gates 2 famílias (Fable ↔ gpt-5.6-terra); 3ª família **opt-in** por wish.

**Retro é skill, não script.** `genie-orca-review` em modo retro lê `orca orchestration worker-show/worker-list` (worktree, timings, outcome, failure_count) e os `.jsonl` de sessão (`~/.claude/projects/<worktree>/`, `~/.codex/sessions/`) e produz findings → **edições nas SKILL.md**. O casamento sessão↔dispatch é por worktree path + janela de tempo — **continua frágil**; a diferença para o script é que a lacuna é **declarada** no RETRO.md em vez de escondida num join. `skills/genie-orca/scripts/retro-collect.ts` é removido.

**Regra de modelo única:** nenhum `model` de Dispatch plan nem exemplo de dispatch nomeia `haiku`/`sonnet` (a única ocorrência permitida é a frase da proibição); carga pesada `codex gpt-5.6-terra --effort xhigh`; coordenador em Fable. Remove `claude --model sonnet` de `work/SKILL.md`.

**Validador:** `validate-wish.ts` deriva as seções do template fixture (fonte única, sem shapes soltos). Mecanismo escolhido: **segundo fixture** `wish-template.orca.md` selecionado por `--mode orca` (novo arg de CLI; o hook/skill passa o modo). Standalone continua com o fixture atual e **ignora** `## Dispatch plan` (seções desconhecidas já são ignoradas); modo orca exige.

**Brainstorm em modo orca:** crystallize sem `genie task create`; `INDEX.md` é o ponteiro.

**Veículo de aceite — emenda da wish real.** `caio-cria-ds-tokens-hapvida` é v5 (`### Group n`, sem Dispatch plan, `IN_PROGRESS`). Antes do primeiro dispatch: (1) emenda via `genie-orca-wish` adicionando header `Orchestration`/`Tracker` + Dispatch plan derivado dos grupos existentes (Files/Do/Accept já existem), status log registra a emenda; (2) `validate-wish --mode orca` verde; (3) só então `genie-orca-work`. Esse é o único caminho de transição v5→orca previsto: por emenda explícita, nunca implícito.

**`genie context`** (CLI) também imprime `mode=` — para sessões sem hook.

### OUT
- Semântica do modo standalone: board, claim/lease, `genie task *`, `roadmap.json`, hooks de sync do board. (O hook de SessionStart muda em ambos os modos — só o token aditivo acima.)
- `report`, `pm`, `dream` em modo orca (leem o board): standalone-only até demanda medida.
- Compilador de wish (intent → dispatch): tabela manual basta.
- Notificador out-of-band para gates: polling.
- Orca remoto/federado: a primeira wish roda no host local.
- `migrate-to-linear.ts`: fica fora do plugin como one-shot documentado; não é entregável desta design.
- Migrar os registros de council do brain citados pelo draft — não localizados; este DESIGN é o registro.

## Approach

**B — Overlay, com mecanismo definido.** Não existe primitivo de include entre skills; o overlay é uma instrução explícita de carregar a base inteira e aplicar deltas, testada. `genie-orca-work` é substituto integral porque o loop (Run/Task/Dispatch) não é o loop v5 (claim/lease). A seleção é o token `mode=` que o hook injeta, com guarda nas bases para o roteador não ser contornado (`/genie:work` direto em repo orca chamaria `genie task checkout` — o estado que o modo abole).

Alternativas:
- **A — Fork** (estado do protótipo hoje: 0 headings em comum entre `genie-orca/wish` 46 linhas e `wish` 113; entre `genie-orca/review` 34 e `review` 213). Duas prosas divergem — foi o que aconteceu com CLAUDE.md vs AGENTS.md no caio-cria. Perde para B por drift, não por percentual de reuso (nenhum foi medido; o protótipo é fork puro).
- **C — Adapter de executor:** skills neutras + `executor-{standalone,orca}`. O loop de `work` não é o mesmo com primitivos trocados; a abstração fica vazia.

Isolamento: wish decide; work coordena; review julga/aprende. Contratos: Dispatch plan (wish→work), `VERDICT:` (review→work), `mode=` (hook→skills), fixture por modo (skill→validador).

## Simplicity Case

- **Simplest complete design:** um flag de modo lido pelo hook + três skills + um fixture de template. Nenhum estado novo persistido pelo genie.
- **Added machinery:** (a) cadeia de tracker em 3 níveis — Linear é requisito **presente do brain** (wish `compiled-artifact-honesty` rodou com Linear; `migrate-to-linear` foi provado lá), GitHub/WISH.md são o que o caio-cria exercita (`orca worktree current` na wish: `linkedIssue: null`, `linkedLinearIssue: null`); na primeira execução só o tier 3 roda, e isso é dito. (b) Override por repo — khal-labs roda repos nos dois modos. (c) Segundo fixture do validador — único lugar onde uma seção condicional por modo cabe sem quebrar a fonte única. (d) Passo de reconstrução Run/Task — pago por uma perda real: `orchestration.db` corrompeu em 2026-08-23 e o run `run_c90e56f0bcd5` já voltou vazio uma vez.
- **Deferred until measured:** 3ª família de review sempre-ligada (trigger: bug de gate que só a 3ª família pegou); compilador de wish (trigger: Dispatch plan manual errar dependência em ≥2 wishes); `report/pm/dream` em modo orca (trigger: pedido); notificador de gate (trigger: gate >1h sem resposta por falta de aviso); casamento sessão↔dispatch robusto (trigger: Orca expor session id no receipt).
- **Complexity removed:** `retro-collect.ts`; 3º gate fixo; Linear obrigatório; `repo-profile.md` como config; duplicação integral de prosa (fork sem teste de drift).

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | Modo em `genieHome()/config.json` (schema estendido), override em `.genie/config.json` (enum fechado) e `GENIE_MODE`; hook emite `mode=` nas 3 formas | config e hook já existem; skills são prosa e só leem o que chega no contexto; a sessão de wish não está em branch de wish |
| 2 | Overlay com instrução explícita "carregue a base + deltas" e teste; `work` substituto integral | sem primitivo de include, overlay só existe se for instrução; fork (A) perde por drift, não por reuso medido |
| 3 | Guarda de modo nas skills base + descrições mutuamente exclusivas | roteador é contornável (`/genie:work`, seleção automática) |
| 4 | Tracker = Linear → GitHub → WISH.md, pelo header `Tracker` | Linear é requisito do brain; caio-cria exercita os tiers 2–3; sem tracker não bloqueia |
| 5 | 2 gates humanos; dogfood declarado por wish | gate fixo = polling fixo; dogfood só com UI |
| 6 | 3ª família de review opt-in | custo fixo sem evidência de ganho |
| 7 | Sem compilador de wish | tabela manual bastou; máquina sem requisito |
| 8 | Nunca haiku/sonnet em coluna/exemplo; terra xhigh; Fable coordena | regra do Felipe 2026-08-23; remove a contradição do draft |
| 9 | Retro é skill; script removido; lacuna do join declarada | o agente lê receipts e sessões direto; o erro do script era esconder o join frágil |
| 10 | Coordenador único escritor no tracker, só em transições | N workers escrevendo = ruído |
| 11 | Validador com fixture por modo, `--mode` na CLI | mantém "template é a fonte única"; standalone intocado |
| 12 | Wish v5 entra no modo orca só por emenda com Dispatch plan | transição implícita quebraria "convivem por escolha" e o validador |
| 13 | Dispatch plan é a fonte; Orca Run/Task é cache reconstruível | o run já foi perdido uma vez |

## Risks & Assumptions

| # | Risk | Severity | Mitigation |
|---|------|----------|------------|
| 1 | Child worktrees do Orca sob `<repo>/~/…` (bug do `~`): scripts que resolvem ROOT por `import.meta.url` quebram; `bun test` da main varre worktrees aninhadas | High | brief manda o coordenador buildar da main; `/~/` em `.git/info/exclude`; `git worktree remove` antes do gate integrado |
| 2 | Estado do Orca não é durável: `orchestration.db` corrompeu em 2026-08-23 e `run_c90e56f0bcd5` está vazio (`task-list` → 0, `gate-list` → 0) | **High** | Dispatch plan é seção obrigatória e commitada; `genie-orca-work` tem passo de reconstrução Run/Task a partir dela; critério de aceite prova a reconstrução contra um run deliberadamente resetado; ids ficam no header da wish |
| 3 | Retro: casamento sessão↔dispatch por worktree + janela de tempo é frágil (receipt sem session id) | Medium | lacuna declarada por grupo no RETRO.md ("sem sessão casada"); trigger de melhoria = Orca expor session id |
| 4 | Gate humano é polled; humano não avisado | Medium | status no tracker + comment na worktree; dito no PR; trigger de notificador definido |
| 5 | Roteador contornado por invocação direta da skill base em repo orca → `genie task checkout` cria board | Medium | guarda `mode=orca` no topo das bases; descrições mutuamente exclusivas; teste de seleção |
| 6 | `.genie/config.json` de um repo clonado escolhe o modo do orquestrador | Medium | enum fechado validado, valor bruto nunca ecoado; decisão de confiança escrita (mesmo nível de `.mcp.json`); `GENIE_MODE` sempre ganha |
| 7 | `--setup skip`: worker precisa `bun install`/build nativo | Low | linha SETUP fixa no brief |
| 8 | `gh` ausente onde o fallback GitHub for usado | Low | precondição da skill (`gh auth status`); cai para WISH.md |
| 9 | Seção condicional por modo não cabe no validador de fonte única | Low | fixture por modo (Decisão 11); teste do validador nos dois modos |
| 10 | Espelhos `skills/` ↔ `plugins/genie/skills/` divergem (`codex-plugin-only-smoke` já está vermelho com `skills/genie-orca/`) | Low | critério de aceite exige os dois espelhos e o smoke verde |

## Success Criteria

- [ ] **Wish real, ponta a ponta.** `caio-cria-ds-tokens-hapvida` emendada com Dispatch plan (`validate-wish --mode orca` verde), depois executada por `genie-orca-work`: cada grupo com Task/Dispatch verificável em `orca orchestration task-list` / `dispatch-show`, review por worker read-only com `VERDICT:`, PR aberto no branch da wish, tracker tier 3 (Status log) escrito só pelo coordenador.
- [ ] **Reconstrução provada.** Com o run deliberadamente resetado (`orchestration reset` ou run novo), `genie-orca-work` recria Run + Tasks a partir do Dispatch plan e o header da wish passa a apontar os ids novos.
- [ ] **Standalone intocado.** Suíte do genie verde; `genie init` sem `--mode` grava `standalone`; `validate-wish` sem `--mode` ignora `## Dispatch plan`; nenhum comportamento do board muda.
- [ ] **Modo chega às skills.** `session-context` emite `mode=` nas três formas de contexto; precedência env > repo > global testada; valor inválido em `.genie/config.json` cai para o global e nunca é ecoado; `genie context` imprime o modo; worker recebe `{}`.
- [ ] **Overlay e guarda.** Teste afirma que `genie-orca-wish` carrega o corpo de `wish` + delta; `wish`/`work`/`review` invocadas com `mode=orca` redirecionam para `genie-orca-*` sem tocar `genie task *`.
- [ ] **Espelhos.** `skills/genie-orca/` removido (inclusive `scripts/retro-collect.ts`); `genie-orca-{wish,work,review}` presentes em `skills/` e `plugins/genie/skills/`; `codex-plugin-only-smoke` verde.
- [ ] **Modelo.** Nenhum `model` de Dispatch plan nem exemplo de dispatch nas três SKILL.md nomeia sonnet/haiku; a única ocorrência é a frase da proibição.
- [ ] **Retro.** RETRO.md da wish real produzido pela skill (sem script), com tokens/tempo por grupo onde a sessão casou e "sem sessão casada" onde não; pelo menos um finding virou diff numa SKILL.md e o diff cita o dado do RETRO que o motivou.

## Next Step

After an independent design review returns SHIP, persist the evidence below and verify its content digest before running `wish`.

<!-- genie-design-review:start -->
## Design Review Evidence

- **Verdict:** FIX-FIRST
- **Reviewed content SHA-256:** `581a20fa85f11ba44b65a9b63c1c51faeac5c4d00851a3da48d9eaac5dbe2229`
- **Reviewer:** genie:reviewer (design review, subagent, pass 2)
- **Reviewed at:** 2026-08-23T22:57:03.000Z
<!-- genie-design-review:end -->
