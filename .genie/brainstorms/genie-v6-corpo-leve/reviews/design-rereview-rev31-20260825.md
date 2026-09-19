# Re-review — DESIGN rev. 3.1 — VERDICT: FIX-FIRST

| Campo | Valor |
|-------|-------|
| **Alvo** | `DESIGN.md` rev. 3.1 (o loop de correção dos 14 achados da rev. 3) |
| **Veredito** | **FIX-FIRST** — 0 critical · 6 major novos · 7 minor novos |
| **Reviewer** | subagente independente, read-only (Opus), sem participação na autoria |
| **Reviewed at** | 2026-08-25T22:08:21Z · **sha** `213dc675c6c287d10449dd9b2f22d6d64a274e0e451fa328cc0f6a357c2431ae` |
| **Evidência carimbada?** | Não — só SHIP carimba |

## Disposição dos 14 achados da rev. 3

| id | Estado |
|---|---|
| C1 critério (e) falsificado | **PARCIAL** — reescrito, mas a nova forma ("exatamente dois módulos") também não é testável → N2 |
| C2 modo em `workspace.json` | **RESOLVIDO** — `.genie/mode` não colide com `GITIGNORE_RULES`; resíduo em N3 |
| C3 borda `preAction` | **RESOLVIDO** — e o reviewer confirmou no commander (`_lifeCycleHooks` é hash de arrays) que um 2º `preAction` é registrável |
| C4 clone herda `classic` | **RESOLVIDO** |
| M5 âncora do modo | **PARCIAL** — âncora confirmada idêntica (`genie-db.ts:61,64,76`), mas nenhum critério cobre worktree |
| M6 critério (c) | **PARCIAL** — exceções certas, faixa do bloco errada → N4 |
| M7 `.husky/pre-commit` | **PARCIAL** — fato corrigido, mas a ambiguidade exit-2/exit-0 seguia sem dono → N1 |
| M8 mcp / `.codex/config.toml` | **RESOLVIDO** — atribuição de símbolo errada → n9 |
| M9 PR 5 quebra doctor | **RESOLVIDO** — faixa curta → n11 |
| M10 Risco 1 sem enforcement | **PARCIAL** — regra existe, máquina não orçada → N6 |
| M11 metade vazia de (e) | **RESOLVIDO** |
| m12 · m13 · m14 | **RESOLVIDOS** |

## Achados novos (todos reverificados pelo orquestrador no código)

- **N1 [major]** — "verbo sai 2 / `task sync` sai 0" sem ponto de decisão: `openDb(opts)` (`genie-db.ts:404`) recebe só `{path, cwd}` e não sabe o verbo; `v5-task.ts` chama `openDb()` sem args. Sem um segundo ponto, `.husky/pre-commit:27` cai no `else` e imprime `warn: board snapshot not refreshed` em todo commit.
- **N2 [major]** — critério (e) "exatamente dois módulos" não é testável e quebra assim que `v5-task.ts` traduzir a recusa do `sync` (três módulos).
- **N3 [major]** — critério (a) apoiado em duas falsidades: `init.ts` **não commita** (zero `git commit`/`execSync`) e escreve também `.genie/INDEX.md` + `.gitignore`. `git status` limpo logo após `init` é falso.
- **N4 [major]** — faixa do bloco zero-omni errada: o bloco 9b vai de `:367` a `:442`, e `:425-442` lê `src/lib/omni-runner.ts` (`die "omni-runner source not found"`). Seguindo (c) ao pé da letra, o e2e morre no PR 5.
- **N5 [major]** — `openWishDb` (`context.ts:213-224`) converte **qualquer** throw em `failClosed('unreadable-db')`: a recusa de modo chegaria como "DB ilegível". E `ORCA_FORBIDDEN` nunca foi enumerado.
- **N6 [major]** — Decisão 12b exige um validador que não existe: `validate-wish.ts:256` é puramente estrutural (`parseWishTemplateContract:77-128` só extrai seções e padrões) e `wishes-lint.ts` não conhece `Tracker` (0 hits). Fixture não exprime regra de célula. A máquina não estava no Simplicity Case nem em PR nenhum.
- **n7–n13 [minor]** — 12b listada como "herdada"; "sete critérios" com oito itens e fora de ordem; `hasDuplicateMcpGenieKeys` é check de Hermes (`:1607`), não de rota; "13 menções de board" no router (são 6 na tabela / 8 no arquivo); faixa dos checks omni curta (termina em `:1054`); "Próximo passo" obsoleto; tensão entre `--claude-hooks` e o congelamento do classic.

## O que passou

Âncora do modo idêntica à do banco (worktrees coerentes); `.genie/mode` sem colisão com `GITIGNORE_RULES`; 2º `preAction` registrável; Zod aditivo; Omni default off; `--plan` estritamente read-only; `publish` gated em `codex-dogfood-completeness`; drift de skills exatamente 69/105/29 com a base bundlada byte-idêntica.

## Disposição

Corrigido na **rev. 3.2** (`2fd44d34…`): mecanismo de recusa com três traduções nomeadas + `ORCA_FORBIDDEN` fechado + `context --wish` degradando para `--plan` em orca (N1/N5); critério (e) reescrito sobre os quatro pontos que leem o modo (N2); critério (a) medido após o commit do scaffold (N3); faixa `:367-442` e as asserções `nats-*` (N4); validador de conteúdo orçado no Simplicity Case e alocado no PR 3 (N6); os sete minor. Segue para a terceira review.
