# Design review — DESIGN rev. 3 — VERDICT: FIX-FIRST

| Campo | Valor |
|-------|-------|
| **Alvo** | `.genie/brainstorms/genie-v6-corpo-leve/DESIGN.md` (rev. 3) |
| **Veredito** | **FIX-FIRST** — 4 critical · 7 major · 3 minor |
| **Reviewer** | subagente independente, read-only (Opus), sem participação na autoria |
| **Reviewed at** | 2026-08-25T21:15:47Z |
| **SHA-256 do conteúdo revisado** | `c4fd4cbfdb317fc56e128532e1b4f1cfa323c6b7ce889e06e77fae7cceddbee0` |
| **Evidência carimbada?** | **Não.** O fluxo só permite carimbar `SHIP`. Este bloco é o registro auditável do FIX-FIRST |

> **Nota de ferramenta.** `skills/brainstorm/references/design-review-evidence.mjs digest` **falha** quando o DESIGN ainda não tem o bloco `<!-- genie-design-review:start/end -->` ("must contain exactly one bounded design-review evidence block"), porque `reviewableDesign()` é definido como "o arquivo com o bloco removido". Sem bloco, o digest do conteúdo revisado é, por identidade, o `sha256sum` do arquivo — confirmado independentemente: `c4fd4cb…`. Quem for carimbar depois de corrigir precisa recalcular (o conteúdo vai mudar).

Os quatro `critical` e os `major` 6 e 7 foram **reverificados pelo orquestrador** no código, um a um, antes de aceitar o veredito. Todos procedem.

---

## Critical

### C1 — Critério (e) é falsificado pela Decisão 3
`DESIGN.md:195` exige interseção vazia entre "módulos que importam `v5/genie-db`" e "módulos que mencionam `orca`". Mas `DESIGN.md:44,146` põem o gate **dentro de** `openDb()` (`src/lib/v5/genie-db.ts:404`), que passa a chamar `resolveExecutionMode` e recusar em `orca` — logo `genie-db.ts` pertence aos dois conjuntos. O teste arquitetural falha por construção, já no PR 1.
**Correção:** excluir explicitamente o módulo que hospeda o gate, ou reescrever para "nenhum *consumidor* de `openDb` ramifica por modo".

### C2 — `execution.mode` em `workspace.json` quebra o critério (a)
`DESIGN.md:34,145` vs `DESIGN.md:191` (`git status --porcelain` vazio). **Verificado:** `.genie/workspace.json` não é rastreado (`git ls-files | grep -c workspace.json` → 0), **não é ignorado** (`git check-ignore` → not ignored) e **não existe** neste repo. `GITIGNORE_RULES` (`src/term-commands/init.ts:82`) só cobre `genie.db*` e `launch/`. Num repo orca recém-inicializado, (a) falha com `?? .genie/workspace.json`.
**Correção:** decidir e escrever — (i) o modo é **commitado** (e aí `workspace.json` precisa separar o modo dos campos machine-local `daemonPid`/`tmuxSocket`/`pgUrl`), ou (ii) é machine-local e entra no gitignore — mas então cai em C4.

### C3 — A "borda que já existe" não roda para os verbos gateados
`DESIGN.md:48` cita `program.hook('preAction')` → `installWorkspaceCheck`. **Verificado** em `src/lib/interactivity.ts:45-92`: `WORKSPACE_EXEMPT` contém `init`, `doctor`, `task`, `board`, `context`, `idea`, `mcp`, `ui-bridge`, `install`, `omni` — `commandRequiresWorkspace` (`:110`) devolve `false` e o hook retorna antes de tudo. A borda citada **nunca** é atingida pelos verbos de board que o modo proíbe.
Agravante: quando o `preAction` *roda* (comando não isento, sessão interativa), `ensureWorkspace` (`:143-160`) **cria** `workspace.json` sem `execution.mode` — num clone de repo orca isso fixa a ausência do modo, o walk-up para ali, e o resultado é `classic`: o board escrevendo. Fail-open silencioso. O comentário em `:60-65` ainda registra que "v5 `genie init` deliberadamente nunca escreve um workspace.json".
**Correção:** parar de citar `preAction` como a borda do modo (a única borda real é o próprio `openDb`), e escrever a regra para `workspace.json` sem `execution.mode` (ignorar e continuar o walk-up, ou fazer `ensureWorkspace` gravar o modo).

### C4 — Clone de repo orca herda `classic`; o Risco 9 cobre a direção errada
`DESIGN.md:184` ainda fala de `.genie/config.json` — resíduo da rev. 2, que a Decisão 2 substituiu. O risco real e não coberto: `workspace.json` é untracked, então `git clone` de um repo orca chega **sem** o arquivo → precedência cai para o global → `classic` → board escreve num repo orca.
**Correção:** declarar o modo como estado **commitado** (é config de projeto, não de máquina) + critério novo: "clonar um repo orca e rodar `genie task create` recusa com exit 2 sem nenhuma configuração local".

---

## Major

### M5 — O gate não define de onde vem o modo, e há call-sites com `path` explícito
Seis `openDb({ path })` não-teste (`doctor.ts:287`, `context.ts:218`, `v5-board.ts:261`, `mcp-tools.ts:203,205,367`) apontam para um db que pode não pertencer ao `process.cwd()`. Pior: worktrees **compartilham** `.genie/genie.db` via `git rev-parse --git-common-dir` (`genie-db.ts:61,76`), mas o walk-up de `workspace.json` (`workspace.ts:75-110`) é por diretório — uma worktree filha pode resolver `orca` enquanto o checkout principal resolve `classic`, **sobre o mesmo banco**.
**Correção:** o gate resolve o modo a partir do repo dono do `dbPath` (não do cwd); worktrees herdam o modo do git-common-dir; critério cobrindo o caso worktree.

### M6 — Critério (c) é insatisfazível como escrito
`DESIGN.md:193` pede golden byte-idêntico de `genie --help` e `v5-lifecycle.sh` "verde e sem diff". Contradiz `DESIGN.md:99` (deletar `omni` **e** sua asserção no e2e) e a Decisão 11 (deletar `mcp`). **Verificado** em `tests/e2e/v5-lifecycle.sh:400-404`: o script assere literalmente que `--help` lista `omni`, `task` e `board`. O parêntese de (c) só isenta o MCP.
**Correção:** (c) = "golden de `--help` idêntico **exceto as linhas `mcp` e `omni`**" e "e2e verde, com o único diff sendo a remoção do bloco zero-omni (368-427) e daquela asserção".

### M7 — Afirmação factualmente errada sobre `.husky/pre-commit`
`DESIGN.md:46` diz que os hooks "já são guardados por `-f src/genie.ts` **e** `-f .genie/roadmap.json`". **Verificado:** `post-merge`, `post-rewrite` e `post-checkout` têm as duas guardas; **`pre-commit` não** — linha 23 é só `[ "$git_dir" = "$git_common" ] && [ -f src/genie.ts ]`, e ele roda `task sync` em todo commit. A premissa "já inerte" que justificou não tocar nos hooks é falsa.
**Correção:** corrigir a frase, pôr `.husky/pre-commit` no PR 1, e resolver a ambiguidade entre "exit 2 para verbos de board" (`:45`) e "`task sync` no-op fail-closed" (`:46`) — não são a mesma coisa.

### M8 — Deleção do `genie mcp` não trata `.codex/config.toml` nem os checks do doctor
`src/term-commands/init.ts:207` chama `registerMcpConfigs(root, { codexEntry: genieFacadeMcpEntry(), forceCodexFallback: true })` → `src/lib/codex-project-mcp.ts`, dono da rota marker-owned em `.codex/config.toml`. E `doctor.ts:67,77,455-672` audita essa rota. Entre o PR 2 (deleta mcp) e o PR 7 (deleta a máquina Codex), `genie init` reconciliaria rota para um verbo inexistente.
**Correção:** nomear `.codex/config.toml`, `codex-project-mcp.ts` e os checks do doctor; critério `:203` vira "não escreve rota `genie` em `.mcp.json` **nem** em `.codex/config.toml`".

### M9 — PR 5 (Omni) quebra o doctor, que só é rescopado no PR 7
`doctor.ts:79` importa `resolveOmniRuntimeConfig`; `doctor.ts:886-1045` implementa três checks omni. Deletar `src/lib/omni-*.ts` no PR 5 rebenta o typecheck.
**Correção:** incluir a remoção dos três checks omni no conteúdo do PR 5.

### M10 — Risco 1 (High) tem mitigação sem enforcement
A mitigação é a célula `Base (branch @ sha)` no header, mas o validador do critério (b) só exige header `Orchestration` + `Dispatch plan`. A Decisão 6 é tecnicamente sólida (`context --wish --plan` é read-only de verdade e funciona sem db), **mas** `resolveWishBase` com `db === null` **recomputa** a base a cada chamada a partir de um branch de integração móvel: a base só fica pinada se um humano colar o valor — e nada verifica.
**Correção:** `validate-wish --mode orca` reprova wish orca sem célula `Base` com SHA de 40 hex; incorporar em (b).

### M11 — Metade do critério (e) é vazia
"`init --mode orca` não instala os git hooks de `roadmap-sync`": **verificado** que nada em `src/` ou `scripts/` instala git hook (`grep -rn "\.git/hooks\|hooksPath\|husky" src scripts --include=*.ts` → zero). `genie init` nunca instalou hook em modo nenhum; o critério afirma ausência de feature inexistente e passa vacuamente.
**Correção:** trocar por asserção sobre o que existe: "num repo orca, um commit real não dispara `task sync` — ou, se disparar, sai 0 e `roadmap.json` continua ausente".

---

## Minor

- **m12** — `DESIGN.md:191` diz "escrita de wave base permitida na forma read-only": contraditório. A Decisão 6 não escreve nada; ela imprime e um humano persiste na WISH.md.
- **m13** — Decisão 18 ("retro é skill") ficou órfã: a rev. 3 publica três skills orca e não diz onde o retro mora. O caminho também está errado — é `skills/genie-orca/scripts/retro-collect.ts`, não `scripts/`.
- **m14** — §6 cita só `wishes-lint` como consumidor de `validate-wish`; também dependem dele `plugin-executables-check.ts:21`, `hook-bundle-parity.ts:16` (release gate) e `hook-budgets-lint.ts:64`.

---

## O que passou

- **Ausência real de dual state em modo orca:** o gate em `openDb` **cobre**. Depois das deleções previstas (mcp, ui-bridge, omni), `openDb` é o único criador de `.genie/genie.db`; todos os demais opens não-teste são `new Database(..., {readonly:true})` e não criam arquivo. `roadmap-sync.ts` e `base-state.ts` só recebem um `Database` já aberto. O buraco restante não é código — é o `.husky/pre-commit` (M7).
- `genie init` **não** cria o db (só gitignora): a asserção "`.genie/genie.db` não existe" é alcançável.
- Zod aditivo confirmado (`z.object` sem `.strict()` — chave stripped, nunca hard-fail).
- `git-freeze-guard` é fantasma em orca; `branch-guard` é sessão-agnóstico — a Decisão 9 procede.
- Omni default off (`omni-config.ts:131`) — Decisão 10 procede.
- `publish` do `release-publish.yml` está mesmo gated em `codex-dogfood-completeness` (`:1032,1040`) — Risco 7 procede.
- Critérios (d), (f) e (g) são verificáveis como escritos.
- `--plan` é read-only de verdade; a Decisão 6 é sólida no mecanismo (o furo é de enforcement, M10).

---

## Disposição

**Nada foi carimbado** — o fluxo do brainstorm só permite persistir evidência de `SHIP`. O DESIGN permanece em rev. 3 / FIX-FIRST, e **a wish não pode ser vertida**. Próximo passo é um loop de correção sobre os 4 critical + 7 major e uma nova review; o digest muda junto com o conteúdo.
