# Quarta review — DESIGN rev. 3.3 — VERDICT: **SHIP** ✅

| Campo | Valor |
|-------|-------|
| **Alvo** | `DESIGN.md` rev. 3.3 |
| **Veredito** | **SHIP** — 0 critical · 0 major · 4 advisories |
| **Reviewer** | reviewer-independente-4a-rodada (Claude Opus, read-only) |
| **Reviewed at** | 2026-08-25T22:33:36Z |
| **SHA-256 do conteúdo revisado** | `d91de43a1d03ba55f87652182b2a008ea42246eeae7c8e05aec9b35d2c4d2889` |
| **Evidência carimbada?** | **Sim** — bloco no fim do DESIGN; `design-review-evidence.mjs verify` → rc 0 |

## Os três major da rev. 3.2, fechados

- **R1 — critério (e) comportamental: RESOLVIDO.** O reviewer confirmou no código que a prova estrutural é verdadeira hoje: os únicos `new Database(` fora do primitivo são `doctor.ts:571,2024`, `context.ts:187,199`, `mcp-tools.ts:140` — **todos `readonly: true`**; os únicos `openSqlite(` são `genie-db.ts:405` (dentro do próprio `openDb`) e `global-db.ts:77` (o outro banco, que morre no PR 5). Procurou por falsificação vinda de outra decisão do documento e **não achou**: `init.ts` não abre banco, nenhum handler de `src/hooks/` toca o banco de repo, `resolveProjectDatabaseBinding` não cria arquivo.
- **R2 — exceção de `hire_roster`: RESOLVIDO.** Todas as citações conferem (`task-state.ts:1610,1653`, `genie-db.ts:416`, `importState:1804,1879,1885`, `roadmap-sync.ts:60`) e o `roadmap.json` commitado tem a chave. **Nenhuma outra chave do export morre** nestes PRs; `schemaVersion` muda de valor pelo bump, que o critério já nomeia como prova.
- **R3 — quarta tradução no `doctor`: RESOLVIDO.** O reviewer enumerou os **29** call-sites de `openDb` um a um (19 `v5-task`, 3 `v5-board`, 3 `mcp-tools`, `idea:35`, `doctor:287`, `context:218`, `ui-bridge:242`) e confirmou que **não sobrou quinto ponto** capaz de produzir gate vermelho. Verificou ainda que os dois readonly do doctor que poderiam falhar num repo orca fresco degradam para `warn`/tolerância, nunca `fail`. `ui-bridge.ts:242` no intervalo PR 1→PR 2 é aceitável: não roda em `check`, `doctor` nem no e2e, e seus testes usam repos tmp sem `.genie/mode`.

Os oito minor: **cinco resolvidos e verificados**, três parciais (só resíduo de citação).

## Advisories — vertidos na wish, não bloqueiam

- **A1 (advisory alto)** — o critério (c) diz "duas exceções nomeadas" (`mcp`, `omni`), mas o PR 2 também deleta **`ui-bridge`**, que é comando de topo visível (`src/term-commands/ui-bridge.ts:290-291`, com `.description()` e sem `.hidden()`). Ao pé da letra, o golden do `--help` fica vermelho no PR 2. Classificado como advisory porque a deleção é decisão fechada, explícita na própria linha do PR, nenhuma garantia se perde e a correção é regenerar o golden no mesmo PR. **A wish deve verter (c) com três exceções: `mcp`, `omni`, `ui-bridge`.**
- **A2** — o Simplicity Case (`:149`) ainda diz "três traduções" enquanto o escopo (`:49-53`) manda quatro (o `doctor`). Contradição interna; `:49-53` é a autoritativa e nenhum gate depende de `:149`.
- **A3** — `:49` ainda usa contagem ("exatamente quatro lugares"). Hoje não é falsificada por nada e **não está dentro de um critério de aceite**, então não vira lint vermelho — mas é o formato que quebrou três vezes; melhor como lista sem numeral.
- **A4** — `'skip'` não existe em `CheckStatus` (`src/genie-commands/doctor.ts:105` = `'pass' | 'warn' | 'fail'`). A quarta tradução usa `pass` com detalhe (como o caso "absent" já faz, `:279-283`) ou estende a união + `renderCheckLines`.

## Nota sobre o carimbo

O `stamp` falhou na primeira tentativa: o corpo do DESIGN **citava literalmente** o marcador `<!-- genie-design-review:start -->` na seção 4, dando duas ocorrências, e `design-review-evidence.mjs:19` recusa com "must contain exactly one bounded design-review evidence block" — em `stamp`, `verify` e `digest`. Uma edição de uma linha (a citação virou `` `genie-design-review` ``, sem os delimitadores HTML) desfez a colisão. Como qualquer edição pós-review invalida o digest por contrato, o diff exato foi devolvido ao **mesmo reviewer**, que confirmou ser cosmético (`git diff --numstat` → `1 1`, nenhuma decisão/critério/risco/citação tocada), manteve o SHIP e re-emitiu o digest. Só então o bloco foi carimbado.
