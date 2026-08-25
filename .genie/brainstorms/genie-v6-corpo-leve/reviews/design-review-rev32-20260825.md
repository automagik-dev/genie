# Terceira review — DESIGN rev. 3.2 — VERDICT: FIX-FIRST

| Campo | Valor |
|-------|-------|
| **Alvo** | `DESIGN.md` rev. 3.2 · sha `2fd44d348c342906e6b4770c7de874b74f6d6fe169d96af9e9b13fc91012e203` |
| **Veredito** | **FIX-FIRST** — 0 critical · 3 major · 8 minor |
| **Reviewer** | subagente independente, read-only (Opus) |
| **Reviewed at** | 2026-08-25T22:20:51Z |
| **Calibração dada ao reviewer** | "se só sobrarem minor, o veredito é SHIP com eles como advisory; FIX-FIRST só por algo que produza gate vermelho, decisão impossível de implementar ou perda de garantia" |

Dos 13 achados da segunda review: **8 resolvidos**, 4 parciais (só resíduo minor), **1 não resolvido** (N2 → R1).

## Os três major

- **R1 [major] — critério (e) falsificado pela própria decisão (3ª recorrência).** "exatamente quatro pontos que leem o modo" é falso pelo próprio documento: `:43` e `:97` mandam `context.ts` imprimir `mode=`, `:54` manda `context.ts` degradar `--wish` para `--plan`, e `:237` manda `init.ts` escolher o conjunto de hooks por modo. Além disso o quarto item da lista (`task sync`) **não lê** o modo — captura um erro. Seguido ao pé da letra, o lint fica vermelho no PR 1 do próprio design.
- **R2 [major] — critério (c) exige `task export` byte-idêntico, e o PR 2 deleta uma chave do export.** `hire_roster` é chave de primeiro nível de `ExportState` (`task-state.ts:1610,1653`), está no `EXPECTED_SCHEMA` (`genie-db.ts:416`), é lida por `importState` (`:1804,1879,1885`) e aparece como `hire_roster: []` no `roadmap.json` commitado (`roadmap-sync.ts:60`). (c) nomeava exceções para `--help` e nenhuma para o export → gate vermelho garantido no PR 2.
- **R3 [major] — `doctor` é um quarto ponto de `openDb` sem tradução.** `checkDatabase` (`doctor.ts:275-306`) só pula quando o `genie.db` **não existe**; mas o critério (a) manda que num repo v5 convertido o arquivo continue lá. Logo `openDb` roda, o gate lança, o catch genérico devolve `status:'fail'`, e `ok: failed.length === 0` (`:2304`) + `process.exitCode` (`:2330`) deixam **`genie doctor` vermelho em todo repo orca convertido**.

## Minor (advisory)

r4 tradução em `openWishDb` inalcançável dado o degrade (e o mascaramento real está uma camada acima, `context.ts:416-424`); r5 "git status vazio" × "documentos que a wish cria"; r6 "12b" × "13*" e duas decisões numeradas 13; r7 (h) antes de (g); r8 "6× board" → 5; r9 contagem de `openDb` (29 hoje, 26 pós-mcp, 3 com `path` explícito) e `ui-bridge.ts:242` sem tradução no intervalo PR 1→PR 2; r10 off-by-N em quatro citações; r11 `help-lists-omni-task-board` está dentro do bloco 9b.

## O que passou (verificado, não regrediu)

Âncora do modo idêntica à do banco (`genie-db.ts:61,76`); `.genie/mode` sem colisão com `GITIGNORE_RULES`; `WORKSPACE_EXEMPT` isenta mesmo os verbos gateados (set completo lido, `:45-91`); **toda escrita passa por `openDb`** — os demais opens em `src/` são `readonly` (a asserção "único ponto" é verdadeira); **`context --plan` devolve o mesmo shape** (`ContextPayload`, `:382-390`), então o degrade não quebra consumidor; Zod aditivo; Omni default off; `git-freeze-guard` no-op provado em orca; drift das skills exatamente 69/105/29 com a base bundlada byte-idêntica; nenhum `omni`/`mcp` no e2e fora do bloco 9b.

## Disposição

Corrigido na **rev. 3.3** (`a8a8fc9e…`), seguindo o "caminho para SHIP" que o próprio reviewer desenhou:
1. **(e) virou comportamental** — "toda escrita passa por `openDb`, que recusa em orca" mais a suíte de modo. Nenhuma contagem de módulos: as três tentativas (interseção vazia → exatamente dois → exatamente quatro) foram falsificadas pelo design, cada uma no ciclo seguinte. A lição está escrita no critério para não voltar.
2. **(c) ganhou a terceira exceção** — `task export` perde `hire_roster` no PR 2, com o bump de `user_version` como prova e o golden do `roadmap.json` atualizado no mesmo PR.
3. **`doctor` virou a quarta tradução nomeada** — `checkDatabase` captura `ModeRefusalError` e emite `skip` ("board congelado em modo orca"), nunca `fail`.
Mais os oito minor.
