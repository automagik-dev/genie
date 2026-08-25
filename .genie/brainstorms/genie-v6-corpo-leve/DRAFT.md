# DRAFT — genie v6 "corpo leve": como genie e Orca funcionam juntos

**Slug:** `genie-v6-corpo-leve` · **Início:** 2026-08-23 · **Dono:** Felipe

**Seed:** protótipo em `skills/genie-orca/{wish,work,review}` + `scripts/{retro-collect,migrate-to-linear}.ts`
(commits 49afc7a58, a0fa6fb55 — "draft from practice", 1 wish executada no brain, PR #163).
Registros de decisão citados pelo draft (brain `.genie/brainstorms/genie-v6-corpo-leve/COUNCIL.md`,
`.genie/wishes/compiled-artifact-honesty/{COUNCIL-agent-home,RETRO}.md`) **não estão acessíveis**
nem no khal-labs nem localmente — tratar como perdidos até alguém apontar onde estão.

## WRS

```
WRS: ██████████ 100/100
 Problem ✅ | Scope ✅ | Decisions ✅ | Risks ✅ | Criteria ✅
```

## Reenquadramento (Felipe, 2026-08-23)

"v6" **não é reescrita**: é o **modo Orca** do genie. Na instalação/configuração escolhe-se
`standalone` (board do genie, v5 como está) ou `orca` (Orca é o executor/estado; genie fica com
documentos + protocolo). Os dois modos convivem por escolha explícita, não por transição.

## Problem (✅)

genie v5 carrega o próprio corpo: board (`genie.db` + `roadmap.json`), claim/lease de tarefa, sync por hooks,
estado de lifecycle — tudo duplicando o que Orca (dispatch/worktree/receipts), Linear (status) e brain
(preferências) já guardam. O protótipo v6 inverte: **genie fica só com os documentos (WISH.md) e o protocolo
do coordenador**; o resto é dos donos naturais. O draft saiu de uma única execução e precisa virar um
desenho de verdade antes da primeira wish real (caio-cria-ds-tokens-hapvida, run `run_c90e56f0bcd5`).

## O que o draft já afirma (a confirmar, não decidido)

- Invariante: genie não persiste estado de lifecycle; WISH.md é o único artefato durável.
- 1 Run por wish · 1 Task por grupo · 1 worker supervisionado por grupo em child worktree.
- Review = worker read-only, modelo de família diferente do engenheiro; VERDICT SHIP/FIX-FIRST/BLOCKED.
- Fix loop máximo 2 por grupo → gate humano.
- Linear: coordenador é o único escritor, só em transições.
- Gates humanos: `wish-approval`, `[dogfood]`, `merge`. Orca não tem primitivo de "página humana": gate = gate-create + Linear status + worktree comment, **polled**.
- Grupo integrador sempre existe; roda por último no branch da wish; coordenador faz os merges.
- Regra de modelo (Felipe 2026-08-23): nunca haiku/sonnet; pesado em `codex gpt-5.6-terra xhigh`; coordenador em Fable; reviewer de família diferente.

## Tensões abertas (do README do draft — "owner's call")

1. wish "compiler" vs tabela de Dispatch simples
2. 2 vs 3 gates humanos por padrão
3. `review` como skill própria ou embutida em `work`
4. terceiro modelo de review sempre-ligado vs opt-in

## Contradições internas do draft (a resolver)

- `work` § "Model routing" ainda manda `claude --model sonnet` para workers; a "Model rule" no mesmo arquivo proíbe sonnet.
- `work` diz que brainstorm "unchanged from v5 (human-mandatory)" mas v5 brainstorm crystalliza via `genie task create` (board v5) — que o v6 apaga.
- Header da wish exige ids de Linear; a primeira wish real (caio-cria) não tem Linear.

## Scope (✅)

**IN**
- Seletor de modo: `genie init --mode standalone|orca` grava em `~/.genie/config.json` (`execution.mode`), com override por repo e por env (`GENIE_MODE`). O hook de SessionStart passa a imprimir `mode=<x>` no "Genie wish context" — é como as skills sabem o modo.
- Modo orca = as skills `genie-orca-{wish,work,review}` promovidas de draft a skills do plugin, como **overlay** das base: `wish` + seção Dispatch plan/Orchestration; `work` substituído pelo loop do coordenador; `review` + contrato de worker read-only e tiers.
- Tracker de status em modo orca, cadeia de fallback: Linear (se o header da wish tem ids) → GitHub issue (se a wish/worktree tem `#N`; Orca `linkedIssue` + `gh` para comentar/estado) → só WISH.md (Status log). Coordenador é o único escritor, só em transições.
- Gates humanos padrão: `wish-approval` + `merge`. `[dogfood]` só quando a wish declara.
- `review` skill própria; painel de 3 modelos opt-in (padrão 2 famílias, Fable ↔ gpt-5.6-terra).
- Regra de modelo consolidada (sem contradição): nunca haiku/sonnet em nenhuma coluna.
- Retro é **skill**, não script (Felipe 2026-08-23: o script foi um erro): `genie-orca-review` em modo retro lê ele mesmo `orca orchestration worker-show`/`worker-list`, receipts e os `.jsonl` de sessão (`~/.claude/projects/<worktree>/`, `~/.codex/sessions/`) e emite findings → edições nas SKILL.md. `retro-collect.ts` sai; `migrate-to-linear.ts` fica só como one-shot documentado fora do plugin.
- Brainstorm em modo orca: crystallize sem `genie task create`; INDEX.md é o ponteiro.

**OUT**
- Mexer no modo standalone (board, hooks, claim/lease): zero mudança.
- `report`, `pm`, `dream` em modo orca (leem o board) — ficam standalone-only até haver demanda medida.
- Compilador de wish (intent → dispatch): tabela de Dispatch escrita à mão basta (Simplicity Gate).
- Notificador out-of-band para gates humanos: gate é polled; dizer isso no PR.
- Federação/remoto (Orca em outro host): a primeira wish roda no host local.

## Decisions (✅ — Simplicity Gate)

Simplest complete: um flag de modo + três skills overlay + uma linha no hook. Nada de estado novo no genie.

| # | Decisão | Por quê |
|---|---|---|
| 1 | Modo em `~/.genie/config.json` com override repo/env, exposto pelo hook | config já existe; skills são prosa e precisam ler o modo de algum lugar que já chega no contexto |
| 2 | Overlay, não fork: `genie-orca-wish/review` só carregam o delta; `genie-orca-work` é substituto integral | o loop de work é estruturalmente outro (Run/Task/Dispatch vs claim/lease); wish e review compartilham 80% |
| 3 | Tracker = cadeia Linear → GitHub → WISH.md, decidida pelo header da wish | Orca já liga worktree a Linear e a issue GitHub; sem tracker não bloqueia (caio-cria não tem Linear) |
| 4 | 2 gates humanos; dogfood declarado por wish | 3 gates fixos = polling fixo; dogfood só faz sentido com UI |
| 5 | 3º modelo de review opt-in | custo fixo por wish sem evidência de que o 3º pega o que o 2º não pegou |
| 6 | Sem compilador de wish | tabela manual foi suficiente na única execução; compilador é máquina sem requisito presente |
| 7 | Modelos: nunca haiku/sonnet; terra xhigh para carga; Fable coordena | regra do Felipe 2026-08-23, remove a contradição do draft |

### Abordagens consideradas

- **A. Fork** (estado atual do draft): `genie-orca-*` são cópias completas. Duas prosas divergem — foi o que aconteceu com CLAUDE.md vs AGENTS.md no caio-cria.
- **B. Overlay** (escolhida): base + delta por modo; o orquestrador (`genie` skill) resolve `work` → `genie-orca-work` quando `mode=orca`.
- **C. Adapter de executor**: skills neutras + `executor-{standalone,orca}` com primitivos (claim, dispatch, status). Mais elegante, mas o loop de work não é o mesmo com primitivos trocados — vira abstração vazia.

## Risks (✅)

Conhecidos do draft: child worktrees em `<repo>/~/…` (bug do `~`); `--setup skip` exige bun install pelo worker;
worktrees aninhadas varridas pelo `bun test`; receipts sem tokens (retro-collect faz o join só para Claude);
gate humano só por polling.

## Criteria (✅)

- Wish real `caio-cria-ds-tokens-hapvida` roda ponta a ponta em modo orca (run `run_c90e56f0bcd5`): Task/Dispatch por grupo em `orca orchestration task-list`, review por worker read-only, PR aberto.
- Standalone intocado: suíte do genie passa; `genie init` sem `--mode` = standalone.
- Hook imprime `mode=<resolvido>`; `validate-wish` aceita Dispatch plan quando mode=orca.
- Retro da wish real feita pela skill (sem script), com pelo menos uma edição de SKILL.md derivada dela.

## Log

- 2026-08-23: aberto. Skills do draft instaladas globalmente em `~/.claude/skills/genie-orca-*` (cópia, não symlink).
- 2026-08-23: Felipe — v6 = modo Orca (standalone|orca na config), Linear opcional → GitHub → WISH.md, 2 gates, review skill própria c/ 3º modelo opt-in, modo global + override repo/env, retro é skill (script era erro). WRS 100 → crystallize.
- 2026-08-23: design review 1ª passada **FIX-FIRST** (3 critical / 7 major / 3 minor; sha 530c0161…). Incorporados: emenda da wish v5 com Dispatch plan como veículo; reconstrução Run/Task do Dispatch plan (run já perdido 1x); hook muda nos 2 modos (token aditivo, 3 formas); overlay = instrução "carregue a base + deltas" testada; guarda de modo nas bases; validador com fixture por modo + `--mode`; `.genie/config.json` (enum fechado) no lugar de `repo-profile.md`, confiança explícita; tracker justificado pelo brain (Linear) e caio-cria (tier 3); espelhos + smoke; schema `execution.mode`; `genie context`; critérios reescritos.
- 2026-08-23: design review 2ª passada **FIX-FIRST** (1 critical / 11 major / 7 minor; sha 581a20fa…, carimbado). Achados principais: wish do caio-cria já em andamento (child worktree nasce de ref → commitar antes); `genie init` é só do repo; `.genie/workspace.json` já é a config de repo; `genie context` é JSON versionado; hook não passa `--mode` ao validador; `orchestration reset` é global do host; overlay/guarda só testáveis por asserção estática + procedimento manual; escopo sem appetite. **Decisão do Felipe:** não iterar o design agora — congelar como está (Ready, FIX-FIRST auditável) e aplicar o skillset corrigido nas skills globais desta máquina para usar genie-orca já no caio-cria. Tracker nesta instância privada = só Linear (opcional). Veículo = caio-cria commitando o em-andamento e dispatchando só o que falta.
- 2026-08-25: **council de simplificação, 2 rodadas, 5 lentes cada** → [COUNCIL.md](COUNCIL.md) (dossiê em [council/](council/)). Rodada 1 avaliou a rev. 3 crua (deletar `plugins/`, skills via skills.sh, harness mínimo, board só no standalone, sem UI/khal); rodada 2 aplicou a fronteira da Sofia (Genie = compilador de intenção e gates; Orca = única fonte de verdade da execução ativa; sem dual-write nem sync). **Convergido:** nenhuma seção gated por modo dentro de SKILL.md (as 5 lentes mudaram de voto); deletar Omni inteiro; a via orca nunca cita board e a recusa é mecânica na CLI; provenance append-only unidirecional ≠ sync; sem capability/ports (a borda já existe como `preAction` em `genie.ts:199`); fail-closed precisa de um 3º estado `unresolved` (o "cai para o global" de hoje é fail-open). **Resolvido por evidência:** 3 skills flat (as instaladas em `~/.claude/skills/genie-orca-*` já divergiram do repo em 69/105/29 linhas, e o "overlay" instalado é cópia byte-idêntica da base — o fork já aconteceu); gate dentro de `openDb()`; só `branch-guard` tem efeito em modo orca (`git-freeze-guard` é no-op provado lá); `execution.mode` vai em `.genie/workspace.json`, não num arquivo novo. **Furo achado e fechado:** `genie context --wish` (`context.ts:372`) é o único dono do base SHA da wave e escreve no db → em orca usa-se `--plan` (já read-only) e a base vai para a célula `Base (branch @ sha)` do header da wish. **Aberto para o Felipe:** qual modo é o caminho feliz da v6 (standalone vira legado congelado ou segue produto de primeira classe?). Não cristalizado: DESIGN segue rev. 2 / FIX-FIRST.
- 2026-08-25: **D1 decidido pelo Felipe — Orca é o caminho feliz da v6; o modo clássico fica como compatibilidade congelada** (mantido e testado, sem features novas). Mais duas decisões na mesma rodada: o **modo é escolhido na instalação** (`orca` ou `classic`, prompt único; o clássico segue exatamente como está) e **`genie mcp` é deletado inteiro** ("só tava testando") — o que fecha por deleção o furo das 17 write tools `genie_*` furarem o modo por outra porta. [DESIGN.md](DESIGN.md) reescrito para **rev. 3** com a síntese validada do council: fronteira Genie (compilador de intenção/gates/evidência) ↔ Orca (execução ativa), sem dual-write nem sync; `execution.mode` em `.genie/workspace.json` com 3 estados (`classic|orca|unresolved`, fail-closed); gate dentro de `openDb()`; base da wave via `context --wish --plan` + header da wish; 3 skills orca flat + guarda de 1 linha + 3 lints; `plugins/` fora com os 5 assets não-skill re-homeados antes da deleção; Omni deletado; hooks por modo (orca = só `branch-guard`); 22 decisões, 10 riscos, critérios (a)-(g) reformulados e sequência de 9 PRs. O carimbo de design review da rev. 2 foi removido (o conteúdo mudou). **Gate pendente: design review da rev. 3 — a wish não pode ser vertida antes.**
