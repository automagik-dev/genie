# Council — genie v6 "corpo leve", rev. 3 (síntese)

| Campo | Valor |
|-------|-------|
| **Data** | 2026-08-25 |
| **Rodadas** | 2 (rodada 1: proposta rev. 3 crua · rodada 2: fronteira Genie↔Orca da Sofia) |
| **Lentes** | architecture · product · delivery · security · dissent (5 por rodada, independentes) |
| **Status** | Avaliação. **Não cristalizado, não implementado.** DESIGN.md continua em rev. 2 / FIX-FIRST |
| **Dossiê** | [round1/](council/round1/) (5 relatórios + brief) · [round2/](council/round2/) (5 relatórios) · [round2-BRIEF.md](council/round2-BRIEF.md) |

**Decisão de produto fechada, fora de debate:** existe uma flag/modo específica para Orca.

---

## A. Decisões convergentes (as 5 lentes, com evidência)

| # | Decisão | Evidência decisiva |
|---|---|---|
| A1 | **Nenhuma "seção gated por modo" dentro de um SKILL.md.** Todas as 5 lentes mudaram de voto na rodada 2 | Seção gated é condicional avaliada pelo LLM a cada leitura: não falha fechado e nenhum teste consegue afirmar "o ramo standalone não foi lido". Arquivo separado é uma condicional resolvida **uma vez**, pela mesma borda que resolveu o modo (item 4) |
| A2 | **Deletar Omni inteiro** — `src/lib/omni-*.ts`, `src/lib/v5/{global-db,omni-queue}.ts`, verbo `genie omni`, `src/hooks/handlers/omni-approval.ts`, `skills/omni`, dep `nats` | Item 6 aplicado: único produtor da fila é o hook H6/PermissionRequest do plugin (`omni-approval.ts:339`), que sai; approvals já nascem `enabled: false` (`omni-config.ts:131`); custo = segundo banco global + daemon + ~9k LOC, zero consumidor medido |
| A3 | **Fallback não vira "recusa em prosa".** A via orca simplesmente nunca cita board; a recusa é mecânica, na CLI | `grep "genie task\|genie board" skills/genie-orca/*/SKILL.md` → **0 hits**: o protótipo já nunca cita board. `work:108`/`wish:80`/`brainstorm:115` estão em skills que a guarda de modo abandona antes da linha ser lida |
| A4 | **Provenance no Genie é append-only, unidirecional e nunca relida — não é sync** | Sync é reconciliação bidirecional com política de resolução (foi o que quebrou: "genie.db e roadmap.json divergiram"). Regra dura: *nada que o Genie escreve pode ser relido pelo coordenador para decidir dispatch* — exceto o Dispatch plan, que é upstream do Orca (Decisão 13), não espelho dele |
| A5 | **Sem capability/ports injetados.** A borda já existe: `program.hook('preAction')` em `src/genie.ts:199` → `installWorkspaceCheck` (`src/lib/interactivity.ts:168`) | Commander não tem slot de contexto por comando; threadar um port por ~14k LOC de `src/lib/v5` para gatear o que o modo já decide não-invocando é a Alternativa C do DESIGN ("adapter de executor", rejeitada por ficar vazia) com outro nome |
| A6 | **Fail-closed precisa de um terceiro estado.** `standalone` \| `orca` \| `unresolved` | DESIGN.md:21 hoje manda "valor inválido cai para o global" — isso é fail-**open** num repo orca (cai em standalone = o board escreve, exatamente o que o item 4 proíbe) |

---

## B. Diferenças que sobraram (e como resolvo cada uma)

| # | Divergência | Posições | Resolução |
|---|---|---|---|
| B1 | Embalagem fina das skills | 3 arquivos flat (product · security · delivery · dissent) vs. `genie-orca-work` flat + delta em `references/orca.md` para wish/review (architecture) | **3 flat.** Evidência empírica: as instaladas **já divergiram** do repo (69/105/29 linhas de diff) e o "overlay" instalado é cópia da base inteira (`references/base-wish/SKILL.md` = 113 linhas byte-idênticas a `skills/wish/SKILL.md`). O overlay-por-referência já virou fork uma vez, sem ninguém notar — logo precisa de lint, e o lint é mais simples sobre arquivo inteiro |
| B2 | Onde mora o gate de modo | preAction / `.action()` (architecture · dissent) vs. dentro de `openDb()` (delivery) | **`openDb()`** (`src/lib/v5/genie-db.ts:404`), antes do `openSqlite`, + preAction só para a mensagem. Só assim a asserção forte (`! -e .genie/genie.db`) é verdadeira, e cobre de uma vez os 30 call-sites em 8 arquivos, o MCP e os git hooks |
| B3 | Quais handlers ficam em modo orca | 3 (arch) · 2 (product) · 1 (security · dissent) | **Só `branch-guard`.** `git-freeze-guard.ts:11-28` discrimina por `agent_id`/`agent_type` da *mesma sessão* CC e é fail-open quando nulo; worker do Orca é processo separado em worktree filha → allow sempre = enforcement fantasma. `branch-guard.ts:20-26` casa por padrão de comando, sessão-agnóstico → é a única execução mecânica do §19 que sobrevive |
| B4 | Onde mora `execution.mode` | `.genie/config.json` novo (DESIGN rev. 2) vs. `.genie/workspace.json` existente (architecture) | **`workspace.json`.** Item 6 proíbe durable state nova sem requisito mensurável — e a 2ª passada do design review já tinha apontado isso ("`.genie/workspace.json` já é a config de repo") |

---

## C. Recomendação — simples e completa

1. **Modo.** `execution.mode` em `.genie/workspace.json` (walk-up já implementado), precedência `GENIE_MODE` > repo > global > `standalone`. Zod aditivo e seguro: `GenieConfigSchema` (`src/types/genie-config.ts:207`) é `z.object` puro sem `.strict()`, então a chave é *stripped* hoje — nunca hard-fail. Três estados; `unresolved` nunca cai para standalone.
2. **Gate.** Dentro de `openDb()` antes do `openSqlite`, exit **2** (código já usado como "operador precisa agir"), stderr nomeando a chave e o enum **sem ecoar o valor bruto**; cap de tamanho antes do parse e saída byte-idêntica para toda causa inválida (anti-oráculo). `genie task sync` vira no-op fail-closed em orca; os verbos continuam **registrados** (recusa com razão, não "unknown command").
3. **O furo do `context --wish` — resolvido sem emenda dolorosa.** `context.ts:372` (`writeWishBase`) é hoje o único dono do branch de integração + base SHA da wave, e o critério (a) literal deixaria o modo orca sem base pinada (Risk #1). Saída: em orca usa-se **`genie context --wish --plan`**, que já existe e é estritamente read-only (`context.ts:436`), e o resultado vai para o **header da wish** — o protótipo `genie-orca-wish` já carrega a célula `Base (branch @ sha)`. O Genie continua *computando* a base (item 1: é o compilador); só não a persiste em banco.
4. **MCP.** Em modo orca `genie init` não escreve a entrada `genie` no `.mcp.json` — senão as 17 tools `genie_*` furam o modo por outra porta.
5. **Skills.** `skills/genie-orca-{wish,work,review}` flat e publicadas; guarda de 1 linha no topo de `wish`/`work`/`review`; a tabela "Operational Command Mapping" sai do router `genie` (`skills/genie/SKILL.md:74-93`, 13 menções de board) e vira delegação por modo. Três lints, todos mecânicos: (i) nenhuma fence de `genie-orca-*` invoca `genie task|board|idea` (`skills-lint.ts:114-125` já extrai fences); (ii) a 1ª instrução do overlay nomeia a base; (iii) paridade byte-a-byte repo ↔ publicado.
6. **Hooks.** `genie init --claude-hooks` é **código novo** (hoje `genie hook` só tem `dispatch`, e `claude-settings.ts` só limpa legado) — não é "realocação". Modo default: os handlers que sobreviverem ao corte do plugin. Modo orca: **só `branch-guard`**; `git-freeze-guard` declarado standalone-only por escrito.
7. **Omni:** deletar inteiro (A2).
8. **Provenance.** Bloco delimitado append-only na WISH.md por transição de gate, no padrão que já existe no repo (`<!-- genie-design-review:start -->` + SHA-256, gravado por `references/design-review-evidence.mjs`), com 7 campos: data · grupo · `run_`/`task_`/`dispatch_` · agent+model+effort efetivos do receipt · faixa de SHA **verificada pelo coordenador com `git log`, não copiada da prosa** · verdict + família do reviewer · comando de validação + linha de resumo citada.
9. **Dispatch plan como argv (R3).** `validate-wish --mode orca` **reprova** (não avisa) se `agent`/`model`/`effort` saírem de enums fechados, `worktree` não casar `^[a-z0-9][a-z0-9-]{0,63}$`, ou `validation_cmd` contiver `;`, `&&`, `||`, `|`, crase, `$(`, `>`/`<` ou newline. O diff do Dispatch plan é parte explícita do que o humano aprova no gate `wish-approval` — é o único anchor de confiança real.

### Correções que o DESIGN rev. 3 precisa absorver nos critérios da Sofia

| Critério | Veredito | Reformulação |
|---|---|---|
| (a) | viável, reformular | "não altera `genie.db`" → **"`.genie/genie.db` não existe e `roadmap.json` não tem diff"** (`openDb` é `CREATE TABLE IF NOT EXISTS`: `count(*)=0` passa em falso). `genie init` **não** cria o db hoje (`init.ts:82` só gitignora) e o SessionStart abre read-only degradando com "genie.db absent" — a ausência é postcondition alcançável |
| (b) | **precisa reformulação** | Provenance "no Orca" é indurável: o Success Criteria do próprio DESIGN manda provar reconstrução **com o run resetado**, e nesse instante `task-list` → 0. Reformular: "ids do Orca **+** SHA verificado pelo coordenador, gravados no bloco de provenance da WISH.md". `worker_done` carrega taskId/dispatchId/outcome/filesModified — SHA e validação são prosa auto-declarada pelo worker |
| (c) | viável | Mais barato de todos: golden de `--help`/`board --json`/tools MCP + `v5-lifecycle.sh` sem diff |
| (d) | viável | "rotulado como Orca" = header `Orchestration` presente; teste por `validate-wish --mode orca` |
| (e) | viável **com emenda** | `init --mode orca` não instala os git hooks de `roadmap-sync`; `.husky/{pre-commit,post-merge,post-checkout,post-rewrite}` rodam `task sync` (hoje guardados por `-f src/genie.ts` **e** `-f .genie/roadmap.json`, logo já inertes em repo sem board) |
| (f) | viável, reformular | Rollback do *flag* é trivial (remover a chave; o schema faz strip, não falha). Rollback da *wish* não existe — a Decisão 12 só prevê v5→orca. Escrever: "rollback = volta de modo, não reconstrói board" |
| (g) | viável | `Tracker: none` já é o tier 3 exercitado; **mas colide com o item 4**: `work:108` ("drive from WISH.md directly") *é* o mecanismo de `Tracker: none`. Proibir fallback e exigir (g) é contradição interna — resolvida por A3 (a via orca nunca chega nessa linha) |

### Ordem de trabalho (delivery, revisada)

O **modo sobe de PR-7 para PR-1**: com o modo cedo, toda deleção posterior já é provada nos dois modos. PR-0 (fixture de paridade) ganha um irmão, `tests/e2e/orca-mode-lifecycle.sh` — espelho negativo do `v5-lifecycle.sh`, com um commit real para exercitar o husky. Board não é tocado por PR nenhum (fica só no default), então UI-leaves e rescope-install ficam independentes e paralelos. Omni vira PR próprio antes da deleção do `plugins/`.

---

## D. Decisões humanas que ainda mudam o desenho

Só uma sobrou; todo o resto foi decidido por evidência.

> **D1 — Qual modo é o caminho feliz da v6?** A Sofia escreve que o Board "sobrevive apenas no modo legado/default como projeção/compatibilidade". Se `orca` é o alvo real de uso, o `standalone` vira **modo legado congelado** (board mantido, sem features novas, docs em segundo plano) — e isso muda o que é documentado como default, quanto vale investir no board, e se `genie mcp`/`idea`/`roadmap.json` merecem manutenção. Se `standalone` continua sendo o produto para terceiros, o board é primeira classe e ganha os testes de paridade a cada PR. **Evidência não decide isso: é chamada de produto.**

Recomendações que **não** precisam de você (decididas por evidência, mas reversíveis se discordar): `genie mcp` desligado em orca (não só read-only); `shortcuts` (tmux) sai; o próprio repo `genie` continua em modo standalone (é o dogfood do board).

---

## Simplicity Gate

- **Estado durável novo:** nenhum. `execution.mode` entra num arquivo que já existe; a provenance é texto no documento que já é commitado.
- **Máquina nova:** um resolvedor puro de modo (~30 LOC) + um gate em `openDb()` + um writer de hooks. Sem adapter, sem sync engine, sem segundo protocolo.
- **Removido:** Omni inteiro (segundo banco global + NATS + daemon), o board do caminho orca, e a ambiguidade de seleção de skill.
- **Adiado até medir:** capability/ports (só se um terceiro modo aparecer); publicação em skills.sh como gate de CI (só depois do smoke de paridade existir).
