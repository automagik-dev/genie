# Council rodada 2 — lente DELIVERY

_Rodada 2 (2026-08-25): brief da Sofia. Relatório integral do subagente._

## DELTAS (vs. rodada 1)
- **Omni deixa de ser "STAYS unchanged"** → **DELETE** (ver C3). Era a única área onde eu não aplicava o item 6.
- **Hooks: decisão fecha** — `genie init --claude-hooks`, com conjunto *por modo* (C2).
- **O gate de modo não pode ficar por verbo**: com o critério (a), o gate tem de morar em `openDb()` (`src/lib/v5/genie-db.ts:404`) — há 18 chamadas em `src/term-commands/v5-task.ts:214…582`; 18 lugares para esquecer.
- **PR-0 ganha um irmão**: `tests/e2e/orca-mode-lifecycle.sh`, espelho negativo de `tests/e2e/v5-lifecycle.sh`.
- **`.husky/pre-commit` entra no escopo do modo** (objeção 1).

## OBJEÇÕES NOVAS
1. **`.husky/pre-commit` roda `genie task sync`** (`.husky/pre-commit:15-22`; idem `post-merge`/`post-rewrite`). Num repo orca, qualquer commit re-materializa `genie.db` + `roadmap.json`. O critério (a) morre na camada git, não na CLI. `task sync` precisa no-op fail-closed em modo orca.
2. **`genie context` não-`--plan` escreve** (`src/term-commands/context.ts:214-224`: "may create/backfill the DB — the record write is the point"). O DESIGN manda `genie context` imprimir `mode=`, ou seja, skills o chamam. Em modo orca ele tem de cair no caminho read-only de `:226-240`.
3. **"Sem task rows" é asserção fraca**: `openDb` é `CREATE TABLE IF NOT EXISTS` + `PRAGMA user_version` (`genie-db.ts:404,526`). Um `openDb()` acidental deixa `count(*) FROM tasks = 0` e passa. A asserção forte é **ausência do arquivo**.
4. **Verificado**: `genie init` **não** cria `genie.db` — só o gitignora (`src/term-commands/init.ts:82`). O hook de SessionStart abre o db **read-only** e degrada com "genie.db absent" (`plugins/genie/scripts/src/session-context.ts:336,356`). Logo `! -e .genie/genie.db` é postcondition alcançável hoje.
5. **`scripts/skills-lint.ts:114-125` já extrai invocações `genie …` de fences** — única alavanca mecânica sobre a prosa (C4).

## CONFLITOS
- **C1 — a Product-2/Dissent-2:** voto **muda para flat**, por razão de teste: propriedade de arquivo inteiro é linteável ("nenhuma fence deste arquivo invoca `genie task|board|idea`", skills-lint.ts:125); seção gated por modo dentro de `wish/SKILL.md` não é. O medo de drift é real mas **testável**: um teste afirma que a 1ª instrução do overlay nomeia a base (DESIGN Decisão 2). Drift testável > condicional não testável.
- **C2 — a Dissent-2 ("tudo ou nada"):** meio-estado só é pior se for implícito. Orca ser dono do worktree não o torna dono da política de branch: `branch-guard` + `git-freeze-guard` + `audit-context` são repo-level; `omni-approval` e `identity-inject` são do modo default.
- **C3:** decidido: **deletar**. Único produtor é `src/hooks/handlers/omni-approval.ts:339-340` (H6). Custo: `global-db.ts` 18.7K + `omni-queue.ts` 39.2K src + 34.5K/16.4K de teste — a maior durable state do repo sem consumidor. `v5-lifecycle.sh:398-419` afirma `genie omni status`; sai junto.
- **C4:** em modo orca a skill **nunca cita board**; o CLI recusa fail-closed. O teste está em (a).
- **C5:** evidência durável fica no Genie (item 1) — Dispatch plan commitado + header com ids. Não é sync: escrita unidirecional sem leitura de volta. Reconstrução (Risk #2) é rebuild-from-source, não merge de dois trackers.

## ACEITE (a)-(g) — o teste concreto
**(a) viável, em 3 camadas.** *CLI* — `src/lib/v5/mode-gate.test.ts`: tmpdir + `GENIE_HOME` isolado, modo orca; para cada verbo (`task create|list|checkout|done`, `board`, `idea`, `context` sem `--plan`): `exitCode !== 0`, stderr contém `mode=orca`, e **`existsSync('.genie/genie.db') === false`** — só verdadeira se o gate estiver *dentro* de `openDb` (genie-db.ts:404), antes de `openSqlite`. *repo pré-existente* — `sha256(genie.db)` + `count(*) FROM tasks` idênticos antes/depois. *e2e* — `tests/e2e/orca-mode-lifecycle.sh`: fixture git, `genie init --mode orca`, cria brainstorm+wish, **faz um commit real** (exercita `.husky/pre-commit`), então `ASSERT ! -e .genie/genie.db`, `ASSERT ! -e .genie/roadmap.json`, `git status --porcelain` vazio. *prosa* — regra em `skills-lint.ts`: nenhum `genie task|genie board|genie idea` em fences de `skills/genie-orca-*`.

**(b) precisa reformulação.** Não há `orca` em `src/` nem binário no CI. Reformular: `validate-wish --mode orca` exige header `Orchestration` com Run/Task não vazios e `## Dispatch plan` cujos `id` casam; a prova de execução vira **evidência de aceite manual**, não gate de CI.

**(c) viável, o mais barato.** PR-0 golden: `genie --help`, `task --help`, `board --json`, tools MCP, `task export` schema byte-idênticos; `v5-lifecycle.sh` verde e sem diff; `git diff --stat src/lib/v5/ src/term-commands/v5-*.ts` == 0 nos PRs 2-6; unit: sem env e sem config, `resolveMode() === 'standalone'`.

**(d) viável.** `src/lib/execution-mode.test.ts`: valor desconhecido → exit ≠ 0 **e** `expect(stderr).not.toContain(<valor bruto>)`; ausência → `standalone`; `GENIE_WORKER=1` → `{}`.

**(e) viável como teste arquitetural.** `src/__tests__/no-dual-write.test.ts`: módulos que importam `v5/genie-db` e módulos que mencionam `orca` têm interseção vazia; + `roadmap.json` ausente de (a).

**(f) viável.** (1) flipar orca→standalone e provar que `task create` volta a funcionar; (2) **remover** `.genie/config.json` → volta ao global, `git status` limpo (prova de que não há estado a limpar); (3) `GENIE_MODE=standalone` vence repo marcado orca.

**(g) viável.** `scripts/wishes-lint.ts` já lê metadata (`metadataValue`, `:203`): adicionar campo `Tracker` com enum `linear:<ids> | #<N> | none` + fixture `Tracker: none` passando em `--mode orca`.

**Não prováveis hoje:** só **(b)** — falta binário `orca` no runner, fixture de `orchestration.db` e `worker_done` reproduzível.

## ORDEM DE PRs — o que muda
1. PR-0 ganha o e2e negativo orca — tripwire de (a), (c) e (f) de uma vez.
2. **Modo sobe de PR-7 para PR-1**: com o modo cedo, cada deleção posterior já é provada nos dois modos.
3. O gate entra em `openDb()` + `task sync` + `.husky/*`, não em cada verbo — 1 PR, 1 teste, 18 call sites cobertos.
4. Board não é tocado por PR nenhum → PR-2 (UI) e PR-6 (rescope install) ficam independentes do modo, podem correr em paralelo.
5. Omni vira um PR próprio antes de PR-5.
6. PR-4 (hooks) passa a depender de PR-1: o writer instala conjuntos diferentes por modo.

## DEFAULT RECOMENDADO
- **C1:** skills flat `genie-orca-{wish,work,review}` + lint de overlay ("1ª instrução nomeia a base") + lint de fence.
- **C2:** `genie init --claude-hooks`; modo default = os 6 handlers atuais; modo orca = `branch-guard` + `git-freeze-guard` + `audit-context`.
- **C3:** deletar Omni inteiro. Maior durable state órfã do repo.
