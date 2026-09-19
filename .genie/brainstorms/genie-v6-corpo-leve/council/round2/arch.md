# Council rodada 2 — lente ARCHITECTURE

_Rodada 2 (2026-08-25): brief da Sofia. Relatório integral do subagente._

# ARCHITECTURE — rodada 2 (fronteira Sofia)

## DELTAS
- **Mudo meu voto de C1.** Rodada 1 pedi 3 skills flat. Medido: `genie` 13 menções de board/task, `work` 10, `wish` 4, `review` 2 (`grep -c 'genie task|genie board|genie.db' skills/*/SKILL.md`). O corte honesto é por acoplamento medido: `work` separado, `wish`/`review` não.
- **A "borda" da Sofia já existe e não precisa de ports.** `installWorkspaceCheck` (`src/lib/interactivity.ts:168`) é um `program.hook('preAction')` instalado em `src/genie.ts:199`, com set de isenção em `interactivity.ts:45-53`. Modo = mais um preAction do mesmo formato, instalado **antes** dele.
- **Injeção de capability é indireção sem dono aqui.** Commander não tem slot de contexto por comando; os 29 call-sites de `openDb(` (v5-task 19, v5-board 3, mcp-tools 3, ui-bridge/idea/context/doctor 1 cada) não valem threading de port. Assinatura realista: `resolveExecutionMode(cwd): 'standalone'|'orca'` puro (~30 LOC) + `ORCA_FORBIDDEN` set espelhando `WORKSPACE_EXEMPT`. Recusa no preAction; **registro sempre** (não gate `registerV5TaskCommands` em `genie.ts:191-197`), senão `genie task` vira "unknown command" em vez de recusa com razão.
- **Zod comporta a chave sem risco.** `GenieConfigSchema` (`src/types/genie-config.ts:207`) é `z.object` puro — sem `.strict()`, sem `.passthrough()`. Default do Zod é *strip*: chave `execution` escrita hoje é silenciosamente descartada na leitura **e na escrita** (`saveGenieConfig` re-parseia, `src/lib/genie-config.ts:72`) — nunca hard-fail. `execution: z.object({mode: z.enum(['standalone','orca']).default('standalone')}).default({})` é aditivo, mesma forma de `codex`/`otel`/`omni`/`brain`.
- **Fail-closed concreto:** exit **2** (código já usado como "operador precisa agir" em `interactivity.ts:128,140`; 1 é falha genérica e ficaria indistinguível de erro de board). stderr: `Error (genie): unknown execution mode in <path>. Valid: standalone|orca.` — sem ecoar o valor bruto (DESIGN Risk 6).
- **Evidência durável = stamp append-only, não sync** (C5). Reconcilia itens 1 e 2 da Sofia sem adapter.

## OBJEÇÕES NOVAS
1. `.genie/config.json` (DESIGN §IN) é um **segundo marcador de config por repo** ao lado de `.genie/workspace.json` (`src/lib/workspace.ts:75`, walk-up + migração + validação em `:270`). Item 6 exige requisito mensurável para nova durable state — não há. Ponha `execution.mode` em `workspace.json`.
2. `installWorkspaceCheck` **cria** `.genie/workspace.json` interativamente (`interactivity.ts:133-159`) antes de comandos de board. Em modo orca isso é scaffolding silencioso do corpo que o modo abole. O gate de modo tem de vir antes na ordem de `program.hook`.
3. `genie mcp` expõe **17 tools `genie_*`** (`src/lib/v5/mcp-tools.ts`, 3 `openDb(`). Em modo orca, `init.ts` não pode escrever a entrada `genie` no `.mcp.json` — senão o agente recebe write tools de board apesar do modo. Recusar só na CLI não fecha o buraco.
4. `doctor.ts` (1 `openDb`) roda o check `jar: index-lane drift` que junta `tasks.wish`. Em modo orca não há tabela para juntar: o check tem de degradar para INDEX-vs-disco, ou reporta `unlinked` para toda entrada.
5. `omni-approval.ts:5` é o único handler que toca a global `genie.db`; nenhum outro handler em `src/hooks/` lê board (grep confirmou). Isso decide C3.

## CONFLITOS
**C1 — a Product e a Dissent.** Product-2, sua condição ("`wish`/`review` ganham seção `## Orca dispatch` gated por modo") está **certa no número e errada no mecanismo**. Sob o item 4: seção gated em prosa É condicional espalhada — e pior que uma no código, porque é avaliada pelo modelo a cada leitura, sem gate testável. Arquivo separado é condicional avaliada **uma vez, na seleção**, pela mesma borda que resolveu o modo. Dissent-2: sua contagem honesta ("1 replacement + 2 overlays + 3 guards") é a que os números sustentam, e sua objeção — "as 213 linhas de critério de `review` são o que o overlay implicitamente usa" — é argumento *a favor* de um arquivo só, não de dois. **Síntese proposta:** `genie-orca-work` é a única skill separada (10 menções + loop Run/Task genuinamente outro); `wish` e `review` carregam o delta como **arquivo de referência carregado** (`skills/wish/references/orca.md`), não como parágrafo gated — a base tem **uma** linha condicional no topo ("se mode=orca, carregue `references/orca.md`"), grep-ável e testável. Satisfaz o item 4 sem virar Approach A.

**C2 — a Product e a Dissent.** No modo orca o Orca é dono do *worktree*, mas branch-guard/git-freeze-guard protegem o **repo git** (§19 humans-only-main, freeze) — que o Orca não impõe, e os workers rodam `claude`/`codex` em child worktrees do mesmo repo. Logo são mode-independentes. Product-2: concordo em dropar `identity-inject`/`freshness` (alimentam board/sessão). Dissent-2, contra o "tudo ou nada": o corte não é arbitrário, é **pelo que o handler lê** — quem lê board sai, quem lê git fica. Re-homear via `genie init` → `.claude/settings.json` (o `.mcp.json` em `init.ts:137` já é a mesma decisão de confiança de nível de repo).

**C4 — fallback proibido.** `work:108`, `wish:80`, `brainstorm:114` são fallback **para longe** do board ("task tracking is an enhancement"), não para ele. O que a Sofia proíbe é o inverso. Então: não vire "recusa" na prosa — a via orca simplesmente **nunca cita board**, e a recusa mora na CLI (exit 2). Teste do critério (a): repo tmp com `GENIE_HOME` isolado, modo orca, brainstorm→wish→work; assertar (i) `.genie/genie.db` inexistente / mtime inalterado, (ii) `genie task create` sai 2 com a mensagem de modo, (iii) `.mcp.json` sem entrada `genie`.

**C5 — provenance vs. fragilidade do Orca.** A casa já existe e é o padrão mais forte do repo: bloco delimitado `<!-- genie-design-review:start -->` + SHA-256 do conteúdo revisado, gravado por `references/design-review-evidence.mjs` (`skills/brainstorm/SKILL.md:7`). Aplicar o mesmo a work: o coordenador **anexa** um bloco `genie-orca-provenance` na WISH.md a cada transição de gate, com Run/Task/Dispatch/worker_done ids. **Não é sync**: é append-only, unidirecional (Orca→git), nunca relido para mutar o Orca — sync é reconciliação bidirecional com política de resolução (cf. `task sync` three-way). Provenance não tem política de resolução porque o Genie nunca escreve de volta. É exatamente o item 1 da Sofia e torna a Decisão 13 do DESIGN (Dispatch plan é fonte, Orca é cache) verificável depois da corrupção de 2026-08-23.

**C6 — respondido nos DELTAS** (borda = `genie.ts:199`/`interactivity.ts:168`; assinatura pura, sem port; 29 call-sites em 7 arquivos; Zod aditivo; exit 2).

## ACEITE (Sofia 5)
- (a) **viável** — teste acima; requer também a objeção 3 (`.mcp.json`), senão passa em falso.
- (b) **precisa reformulação** — "prova provenance **no Orca**" é indurável (Risk #2); reformule para "prova no bloco de provenance da WISH.md, derivado do Orca".
- (c) **viável** — nada muda se `execution.mode` default `standalone` e o preAction só recusa em orca.
- (d) **viável** — spawn genérico não passa pelo gate; só os verbos em `ORCA_FORBIDDEN`.
- (e) **viável** — em orca o Genie não tem task manager; o bloco de provenance não é estado reconciliável (write-once).
- (f) **viável** — rollback = remover a chave de `workspace.json`; testável porque o schema faz strip, não fail.
- (g) **viável** — `Tracker: none` já é o tier 3 e é o único que a wish real exercita.

## DEFAULT RECOMENDADO
- **C1:** `genie-orca-work` como única skill separada; `wish`/`review` com delta em `references/orca.md` carregado por **uma** linha condicional no topo. Não seção gated em prosa, não 3 skills flat.
- **C2:** re-homear branch-guard + git-freeze-guard + audit-context via `genie init` → `.claude/settings.json`, nos dois modos; deletar identity-inject + freshness + omni-approval.
- **C3:** **deletar Omni.** Teste do item 6: único produtor é o caminho PermissionRequest/PreToolUse, já **desligado por default** (`enabled: z.boolean().default(false)`, OmniApprovalsConfigSchema). Default-off + um usuário + NATS + um **segundo banco** (`global-db.ts`, `omni-queue.ts`) = zero requisito mensurável.
