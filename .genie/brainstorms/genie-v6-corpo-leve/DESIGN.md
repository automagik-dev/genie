# Design: genie v6 "corpo leve" — modo Orca como caminho feliz

| Campo | Valor |
|-------|-------|
| **Slug** | `genie-v6-corpo-leve` |
| **Rev.** | 3 (2026-08-25) — reescrita sobre a rev. 2 (2026-08-23) após council de 2 rodadas × 5 lentes |
| **WRS** | 100/100 |
| **Council** | [COUNCIL.md](COUNCIL.md) · dossiê em [council/](council/) |
| **Design review** | rev. 2 recebeu FIX-FIRST 2× (digest `581a20fa…`, carimbo removido: o conteúdo mudou). **Rev. 3 ainda não revisada.** |

## Problema

O genie v5 carrega o próprio corpo — board (`genie.db` + `roadmap.json`), claim/lease de tarefa, hooks de sync, plugin de marketplace com máquina de delivery assinada — duplicando o que Orca (dispatch, worktrees, receipts), Linear/GitHub (status) e brain (preferências) já guardam. Quando Orca está presente, esse corpo só gera atrito: o hook do board acusou "genie.db e roadmap.json divergiram" ao abrir este próprio brainstorm.

A rev. 2 tratava isso como "um modo de execução, não uma reescrita", e mantinha o corpo intacto ao lado. A rev. 3 vai além por decisão do Felipe (2026-08-25): **Orca é o caminho feliz da v6**. O corpo não é apenas contornado — ele para de crescer.

## Decisão de enquadramento (D1 — Felipe, 2026-08-25)

> **Orca é o caminho feliz da v6. O modo `classic` fica como compatibilidade congelada: mantido e testado, sem features novas.**

Consequências que atravessam todo o resto deste documento:

- O caminho documentado, otimizado e dogfoodado é o modo `orca`. `classic` sai do centro do README e da quickstart.
- O board (`genie.db`, `roadmap.json`, `genie task`, `genie board`, `genie idea`) entra em **congelamento**: continua funcionando, continua com testes de paridade, mas não recebe verbo novo nem coluna nova. Bug de correção sim; feature não.
- Nenhum trabalho de v6 é justificado por "melhorar o board". Trabalho no board só entra se for para **manter a compatibilidade viva** (paridade, migração, correção).
- Onde a decisão for empatada entre "melhor para orca" e "melhor para classic", ganha orca.

## Scope

### IN

**1. O modo, resolvido uma vez na borda**

- `execution.mode` mora em **`.genie/workspace.json`** — o arquivo de config de repo que já existe, com walk-up, migração e validação (`src/lib/workspace.ts:75,270`). Não se cria `.genie/config.json`.
- Precedência: `GENIE_MODE` (env) > repo (`workspace.json`) > global (`genieHome()/config.json`) > `classic`.
- **Três estados: `classic` | `orca` | `unresolved`.** Valor desconhecido, malformado, grande demais ou ilegível resolve para `unresolved` e **nunca** cai para o global — cair para o global escolheria `classic`, e em repo orca isso é o board escrevendo, exatamente o que o modo proíbe. (A rev. 2 dizia "cai para o global": era fail-open.)
- `GenieConfigSchema` (`src/types/genie-config.ts:207`) é `z.object` puro, sem `.strict()`: a chave é aditiva e hoje é silenciosamente *stripped*, nunca hard-fail. Mesma forma de `codex`/`otel`/`omni`.
- Anti-oráculo: cap de tamanho **antes** do parse; saída byte-idêntica para toda causa inválida (JSON quebrado, enum errado, tipo errado, arquivo grande, ilegível, ausente); nenhum byte do arquivo em stdout/stderr, nem truncado, nem dentro de erro do Zod; alvo fora de `.genie/` recusado sem `stat`.
- **O modo é escolhido na instalação.** `genie install`/`genie init` perguntam `orca` ou `classic` (prompt único; `--mode classic|orca` para não-interativo, `--no-interactive` exige a flag). Sem escolha registrada = `classic`, e o repo clássico segue exatamente como está hoje.
- `genie context` imprime `mode=<resolvido>`; o SessionStart (onde existir) emite o mesmo token. `unresolved` chega às skills como "pare e pergunte", nunca como classic. Worker (`GENIE_WORKER=1`) continua recebendo `{}`.

**2. O gate do board, mecânico**

- O gate vive **dentro de `openDb()`** (`src/lib/v5/genie-db.ts:404`), antes do `openSqlite` — não em cada verbo. É o único ponto que cobre de uma vez os ~27 call-sites restantes e os git hooks, e é a única forma de a asserção forte (`.genie/genie.db` **não existe**) ser verdadeira. `openDb` é `CREATE TABLE IF NOT EXISTS`: uma abertura acidental deixaria `count(*) FROM tasks = 0` e passaria em falso.
- Em modo `orca` os verbos de board continuam **registrados** no commander e recusam com razão (exit **2**, código já usado como "operador precisa agir"). Não se desregistra o comando — "unknown command" esconde a causa.
- `genie task sync` vira no-op fail-closed em orca; `genie init --mode orca` não instala git hooks de `roadmap-sync`. (Os `.husky/*` de hoje já são guardados por `-f src/genie.ts` **e** `-f .genie/roadmap.json`, logo já inertes em repo sem board — mas a garantia passa a ser explícita.)
- **`genie mcp` sai inteiro** (Felipe, 2026-08-25: "só tava testando") — `src/lib/v5/{mcp-server,mcp-tools}.ts`, o verbo `mcp`, e a escrita da entrada `genie` em `.mcp.json` por `genie init`. Isso fecha por deleção o buraco das 17 tools `genie_*`, que furariam o modo por outra porta, e remove 3 dos call-sites de `openDb`.
- **Sem capability/ports injetados.** A borda já existe como `program.hook('preAction')` (`src/genie.ts:199` → `installWorkspaceCheck`, `src/lib/interactivity.ts:168`). O resolvedor é uma função pura (`resolveExecutionMode(cwd)`, ~30 LOC) mais um conjunto `ORCA_FORBIDDEN` espelhando `WORKSPACE_EXEMPT`. Threadar um port por ~14k LOC de `src/lib/v5` para gatear o que o modo já decide não-invocando é a alternativa "adapter de executor" que este design rejeita por ficar vazia.

**3. A base da wave sem banco**

`genie context --wish` (`src/term-commands/context.ts:372`, `writeWishBase`) é hoje o **único** lugar que computa branch de integração + base SHA da wave (`src/lib/v5/base-state.ts:77`) — e grava no `genie.db`. Em modo orca:

- usa-se **`genie context --wish --plan`**, que já existe e é estritamente read-only (`context.ts:436`);
- o resultado vai para a célula **`Base (branch @ sha)`** do header da wish, que o protótipo `genie-orca-wish` já carrega.

O Genie continua *computando* a base — é o compilador; ele só não a persiste em banco. Sem isso, o modo orca ficaria sem base pinada, que é o Risco 1 deste design.

**4. Fronteira Genie ↔ Orca**

- **Genie** é o compilador Git-native de intenção e gates: brainstorm, WRS, DESIGN, wish, acceptance criteria, review `SHIP|FIX-FIRST|BLOCKED`, `.genie/INDEX.md` e **evidência final**.
- **Orca** é a fonte de verdade da **execução ativa**: Run, Task/DAG, Dispatch, worker, retries, perguntas/escalations, terminal/worktree, `worker_done`.
- **Sem dual-write, sem adapter de sincronização, sem Genie Task ↔ Orca Task.** Em modo orca o Genie não tem task manager, logo não há nada a reconciliar.
- **Provenance é append-only, unidirecional, e nunca relida.** O coordenador anexa um bloco delimitado à WISH.md a cada transição de gate — mesmo padrão que o repo já usa em `<!-- genie-design-review:start -->` + SHA-256 (`skills/*/references/design-review-evidence.mjs`) — com sete campos: data · grupo · `run_`/`task_`/`dispatch_` · agent+model+effort **efetivos do receipt** · faixa de SHA **verificada pelo coordenador com `git log`, não copiada da prosa do worker** · verdict + família do reviewer · comando de validação + linha de resumo citada.
- **Regra que impede virar sync:** nada que o Genie escreve pode ser relido pelo coordenador para decidir dispatch. A única exceção é o **Dispatch plan**, que é *upstream* do Orca (é a fonte da reconstrução), não espelho dele.

**5. Skills**

- Três skills publicadas e autônomas: `skills/genie-orca-{wish,work,review}` (flat; a árvore aninhada `skills/genie-orca/` some, junto com `scripts/retro-collect.ts`).
- `wish`, `work` e `review` (bases) abrem com **uma** guarda de uma linha: se `mode=orca`, invoque a skill orca correspondente. Uma condicional por arquivo, grep-ável e testável — **nunca** seções gated por modo no meio do texto (condicional em prosa que nenhum teste consegue afirmar).
- O router `genie` perde a tabela "Operational Command Mapping" (`skills/genie/SKILL.md:74-93`, 13 menções de board) e passa a delegar por modo; State Detection: `APPROVED → genie-orca-work` em modo orca.
- `brainstorm` fica inalterado exceto o ponteiro de board no crystallize — `.genie/INDEX.md` é o ponteiro.
- Três lints mecânicos: (i) nenhuma fence de `skills/genie-orca-*` invoca `genie task|genie board|genie idea` (`scripts/skills-lint.ts:114-125` já extrai fences e invocações); (ii) a primeira instrução de cada skill orca nomeia a base que ela substitui; (iii) paridade byte-a-byte entre `skills/` no repo e o que é publicado.
- **Por que lint e não confiança:** as cópias instaladas hoje em `~/.claude/skills/genie-orca-*` **já divergiram** do repo (69 / 105 / 29 linhas de diff em wish/work/review, em dois dias), e o "overlay" instalado é uma **cópia da base inteira** (`references/base-wish/SKILL.md` = 113 linhas byte-idênticas a `skills/wish/SKILL.md`). O fork já aconteceu uma vez sem ninguém notar.
- `report`, `pm`, `dream` leem o board → classic-only, e congelados junto com ele.

**6. Sem plugin**

- `plugins/` inteiro sai: `plugins/genie` (manifests `.claude-plugin`/`.codex-plugin`/`.kimi-plugin`, hooks, scripts, agents, workflows, rules, references, espelho de skills), `plugins/hermes-genie`, `plugins/pi-genie`.
- Sai junto toda a máquina de delivery/ativação: `src/lib/{codex-*,hermes-*,agent-sync,runtime-integrations,install-promotion,install-transaction,install-version-marker,update-capabilities,ordered-lifecycle-leases}`, `src/genie-commands/{codex-*,install-promote,update-integrations,local-delivery-repair,auxiliary-trees,setup --codex}`, e os scripts/jobs de CI que só provam o plugin.
- **Skills passam a ser publicadas como skillset em skills.sh** (`npx skills add automagik-dev/genie`): SKILL.md + arquivos irmãos (`references/`, `templates/`), instalados por symlink ou cópia em dezenas de runtimes. skills.sh **não** carrega hooks, agents, MCP nem workflows — por isso os assets não-skill do plugin precisam de casa antes da deleção:
  - `plugins/genie/agents/*.md` (7 perfis de papel, nomeados por `skills/work` como obrigatórios) → `templates/agents/`, materializados por `genie init` em `.claude/agents/`;
  - `session-context.ts` → verbo de CLI (`genie context --session`), carregando o token `mode=`;
  - `validate-wish.ts` → `scripts/` (é importado por `scripts/wishes-lint.ts`: deletar sem realocar quebra o lint, não só o hook);
  - `references/{dispatch-contract,review-criteria,lenses}` → dentro das skills que os leem;
  - `workflows/council.js` → a skill `council` passa a ser a superfície em todo runtime.
- A cadeia de integridade do **binário** fica intacta: `install.sh` verify, `update` com manifest + cosign/attestation, `SECURITY.md` pin block, `verify-release.sh`, `release-guard.sh`, `sign-attest.yml`, `signing-identity-pin.yml`. Só a segunda cadeia — a que assinava a *árvore do plugin* — some, porque o sujeito assinado deixa de existir.

**7. Hooks**

- `genie init --claude-hooks` escreve as entradas em `.claude/settings.json`. Isto é **código novo**, não realocação: hoje `genie hook` só tem `dispatch` e `claude-settings.ts` apenas limpa legado.
- Modo **orca: só `branch-guard`.** `git-freeze-guard` discrimina por `agent_id`/`agent_type` da mesma sessão CC e é fail-open quando nulo (`src/hooks/handlers/git-freeze-guard.ts:11-28`); o worker do Orca é processo separado em worktree filha, então lá ele libera sempre — enforcement fantasma. `branch-guard` casa por padrão de comando, é sessão-agnóstico, e é a única execução mecânica do §19 (main é humano) que sobrevive.
- Modo **classic (congelado): `git-freeze-guard` e `audit-context` seguem** como estão.
- `identity-inject`, `freshness` e `omni-approval` saem. O envelope fail-closed e a exceção do `AskUserQuestion` (`src/hooks/index.ts`) ficam idênticos nos dois modos.
- Onde não houver hook instalado, a perda de enforcement é **declarada** no README e a proteção passa a ser branch protection no servidor.

**8. Omni sai inteiro**

`src/lib/omni-*.ts`, `src/lib/v5/{global-db,omni-queue}.ts`, verbo `genie omni`, `src/hooks/handlers/omni-approval.ts`, `skills/omni`, dependência `nats`, e a asserção correspondente em `tests/e2e/v5-lifecycle.sh`. Teste do simplicity gate: o único produtor da fila é o hook H6/PermissionRequest do plugin, que sai; approvals já nascem `enabled: false` (`src/lib/omni-config.ts:131`); o custo é um **segundo banco global** + daemon + ~9k LOC com zero consumidor medido. O item "perguntas/escalations" já pertence ao Orca — manter Omni seria um segundo protocolo paralelo.

**9. Sem UI, sem khal**

`packages/genie-ui`, `genie ui-bridge`, `src/lib/v5/bridge-watcher.ts`, a tabela `hire_roster` (com bump de `user_version` e migração — não basta apagar o comando) e os docs de UI/desktop. Os ledgers de UI/khal já foram removidos do `.genie/` em 2026-08-25 (`d77808bff`).

**10. Veículo de aceite**

A wish real `caio-cria-ds-tokens-hapvida` (v5, `IN_PROGRESS`, sem Linear) entra em modo orca **por emenda explícita**: header `Orchestration`/`Tracker` + Dispatch plan derivado dos grupos existentes → `validate-wish --mode orca` verde → `genie-orca-work`. Esse é o único caminho de transição v5→orca previsto.

### OUT

- Reescrever o board ou "melhorar" o classic (D1: congelado).
- Adapter de sincronização, dual-write, segundo banco, protocolo paralelo.
- Capability/ports injetados (só se um terceiro modo aparecer).
- Compilador de wish (intent → dispatch): a tabela manual basta.
- Notificador out-of-band para gates: polling.
- Orca remoto/federado.
- `report`, `pm`, `dream` em modo orca.
- `migrate-to-linear.ts`: one-shot documentado fora do produto.

## Approach

Uma flag resolvida na borda, um gate mecânico no ponto onde o corpo é aberto (`openDb`), três skills separadas para o loop que é genuinamente outro, e o documento em git como única memória durável. Nada de indireção nova: o resolvedor é uma função pura e o gate é uma checagem antes de abrir arquivo.

Alternativas descartadas:

- **Seções gated por modo dentro das skills base** — condicional em prosa avaliada pelo modelo a cada leitura; não falha fechado e nenhum teste consegue afirmar que o ramo errado não foi lido. As 5 lentes do council convergiram contra.
- **Overlay "carregue a base e aplique deltas"** — sem primitivo de include, overlay é cópia. Já virou cópia: a base bundlada nas skills instaladas é byte-idêntica hoje e vai divergir amanhã.
- **Adapter de executor / capability boundary** — o loop do `work` não é o mesmo com primitivos trocados; a abstração fica vazia.
- **Manter o plugin como veículo** — ele existe para autenticar bytes que deixam de existir.

## Simplicity Case

- **Estado durável novo:** nenhum. `execution.mode` entra num arquivo que já existe; a provenance é texto no documento que já é commitado.
- **Máquina nova:** um resolvedor de modo puro (~30 LOC), um gate em `openDb()`, um writer de hooks, e três lints de skill. Nada mais.
- **Complexidade removida:** `genie mcp` inteiro (servidor + 17 tools); `plugins/` inteiro e a máquina de delivery assinada (~50k LOC src + ~30k test); Omni (segundo banco global + NATS + daemon); UI e `hire_roster`; o board do caminho feliz; a ambiguidade de seleção de skill; o script `retro-collect.ts`.
- **Adiado até medir:** capability/ports; skills.sh como gate de CI (só depois do smoke de paridade existir); 3ª família de review sempre ligada; notificador de gate.

## Decisões

### Novas (council rev. 3)

| # | Decisão | Razão |
|---|---|---|
| 1 | **Orca é o caminho feliz; `classic` é compatibilidade congelada** | Felipe, 2026-08-25 |
| 2 | `execution.mode` em `.genie/workspace.json`; 3 estados; `unresolved` nunca cai para o global | Não criar durable state nova; o "cai para o global" da rev. 2 era fail-open |
| 3 | Gate dentro de `openDb()`, verbos permanecem registrados, exit 2 | Único ponto que cobre 30 call-sites + MCP + git hooks; a asserção forte é ausência do arquivo |
| 4 | Sem capability/ports; borda = `preAction` que já existe | Commander não tem slot de contexto; port por 14k LOC é abstração vazia |
| 5 | Três skills orca flat + guarda de 1 linha nas bases + 3 lints | Seção gated não é testável; overlay-por-referência já virou fork (69/105/29 linhas de drift medido) |
| 6 | Base da wave via `context --wish --plan` + header da wish | `writeWishBase` é o único dono do base SHA e escreve no db; `--plan` já é read-only |
| 7 | Provenance append-only, unidirecional, nunca relida; Dispatch plan é a exceção porque é upstream | Distingue evidência de sync; sync bidirecional foi o que quebrou (`genie.db` × `roadmap.json`) |
| 8 | Plugins fora; skills via skills.sh; assets não-skill re-homeados antes da deleção | skills.sh só carrega SKILL.md + irmãos; `validate-wish` é importado pelo `wishes-lint` |
| 9 | Hooks por modo: orca = só `branch-guard` | `git-freeze-guard` é no-op provado em orca (discrimina por `agent_id` da mesma sessão) |
| 10 | Omni deletado inteiro | Sem produtor após o plugin; default off; maior durable state órfã do repo |
| 11 | **`genie mcp` deletado inteiro**, nos dois modos | Era exploratório e nunca teve consumidor fora de teste; deletar fecha o furo das 17 write tools sem precisar de gate |
| 12 | Dispatch plan validado como argv: enums fechados, `worktree` por regex, `validation_cmd` sem metacaracteres | As células viram argv de `worker-start`; WISH.md é prosa editável por PR |

### Herdadas da rev. 2 (inalteradas)

| # | Decisão |
|---|---|
| 13 | Tracker por cadeia: Linear → GitHub issue → WISH.md (Status log), escolhida pelo header `Tracker` |
| 14 | Dois gates humanos: `wish-approval` e `merge`; `[dogfood]` só quando a wish declara |
| 15 | Review: por grupo 1 reviewer de família ≠ engenheiro; nos gates 2 famílias; 3ª opt-in por wish |
| 16 | Sem compilador de wish |
| 17 | Nunca `haiku`/`sonnet` em coluna `model` ou exemplo de dispatch; carga pesada em `codex gpt-5.6-terra --effort xhigh`; coordenador em Fable |
| 18 | Retro é skill, não script; a lacuna do join sessão↔dispatch é declarada no RETRO.md |
| 19 | Coordenador é o único escritor no tracker, e só em transições |
| 20 | Validador com fixture por modo (`wish-template.orca.md`, `--mode orca`); classic ignora `## Dispatch plan` |
| 21 | Wish v5 entra em orca só por emenda explícita com Dispatch plan |
| 22 | Dispatch plan é a fonte; Run/Task do Orca é cache reconstruível |

## Riscos

| # | Risco | Sev. | Mitigação |
|---|---|---|---|
| 1 | Modo orca sem base de worktree pinada | High | Decisão 6: `--plan` + header `Base (branch @ sha)`; critério (a) reformulado permite explicitamente esse caminho |
| 2 | Estado do Orca não é durável — `orchestration.db` corrompeu em 2026-08-23 e `run_c90e56f0bcd5` voltou vazio | **High** | Dispatch plan obrigatório e commitado; passo de reconstrução em `genie-orca-work`; bloco de provenance na WISH.md sobrevive à perda; critério de aceite prova reconstrução contra run resetado |
| 3 | Drift entre skill no repo e skill publicada — **já ocorreu** (69/105/29 linhas) | **High** | Lint de paridade byte-a-byte no `check`; skills orca autônomas (sem base bundlada) |
| 4 | Perda de enforcement client-side ao remover o plugin | Med-High | `genie init --claude-hooks`; `branch-guard` nos dois modos; perda declarada no README; branch protection no servidor é o controle duro |
| 5 | `validation_cmd`/Dispatch plan como argv: um PR que adiciona linha executa código no host | Med-High | Decisão 12 (validador reprova, não avisa) + o diff do Dispatch plan é parte explícita do gate `wish-approval` |
| 6 | skills.sh instala prosa não assinada de um repo GitHub | Med | Skillset prosa-only (nenhum executável dentro de `skills/`); fonte canônica declarada; README ensina diff contra a tag |
| 7 | Pipeline de release hoje trava sem os jobs de Codex (`publish` depende de `codex-dogfood-completeness`) | Med | Reescrever CI **no mesmo PR** que deleta o plugin, com tag de dry-run provando `publish → finalize` |
| 8 | Instalação antiga com plugin habilitado + CLI novo sem `hook dispatch` = deny fail-closed em toda tool call | Med | Uma release de deprecação **antes** da deleção; `genie install` limpa resíduo; `doctor` avisa por ≥2 releases |
| 9 | `.genie/config.json` de um clone escolher o modo | Low | Enum fechado, valor bruto nunca ecoado, `GENIE_MODE` sempre vence (agora em `workspace.json`) |
| 10 | Worktrees filhas do Orca sob `<repo>/~/…` varridas pelo `bun test` da main | Low | `/~/` em `.git/info/exclude`; `git worktree remove` antes do gate integrado; coordenador builda da main |

## Critérios de Sucesso

Os sete critérios da fronteira, na forma que o council verificou ser provável:

- [ ] **(a) Sem corpo em modo orca.** Após `brainstorm → wish → work` num repo orca — incluindo **um commit real**, para exercitar os git hooks — `.genie/genie.db` **não existe**, `.genie/roadmap.json` não existe, e `git status --porcelain` está vazio. Em repo v5 pré-existente convertido: `sha256(genie.db)` e `count(*) FROM tasks` idênticos antes e depois. A escrita de wave base é explicitamente **permitida** na forma read-only da Decisão 6.
- [ ] **(b) Provenance.** `validate-wish --mode orca` exige header `Orchestration` com Run/Task não vazios e `## Dispatch plan` cujos `id` casam com o header; o bloco de provenance na WISH.md carrega os sete campos, com a faixa de SHA verificada pelo coordenador via `git log`. A prova de execução viva no Orca é **evidência de aceite manual**, não gate de CI — não há binário `orca` no runner.
- [ ] **(c) Clássico intocado.** (menos o MCP, deletado nos dois modos por decisão explícita) Golden byte-idêntico de `genie --help`, `genie task --help`, `genie board --json` e schema de `task export`; `tests/e2e/v5-lifecycle.sh` verde e sem diff; sem env e sem config, `resolveExecutionMode()` retorna `classic`.
- [ ] **(d) Rótulo honesto.** "Rotulado como Orca" = header `Orchestration` presente; spawn genérico não recebe o rótulo nem passa pelo gate. Valor de modo desconhecido: exit ≠ 0 e nenhuma substring do valor bruto em stdout/stderr.
- [ ] **(e) Nada a reconciliar.** Teste arquitetural: o conjunto de módulos que importa `v5/genie-db` e o conjunto que menciona `orca` têm interseção vazia; `init --mode orca` não instala os git hooks de `roadmap-sync`.
- [ ] **(f) Rollback do modo.** Flipar orca→classic devolve `genie task create` funcionando; **remover** a chave volta ao global com `git status` limpo (prova de que não há estado a limpar); `GENIE_MODE=classic` vence um repo marcado orca. Rollback é de **modo**, não de wish: uma wish emendada não reconstrói board.
- [ ] **(g) `Tracker: none`.** `wishes-lint` valida o campo `Tracker` com enum `linear:<ids> | #<N> | none`; fixture com `Tracker: none` passa em `--mode orca`; WISH.md + `.genie/INDEX.md` são a identidade humana.

E os critérios de corpo desta rev.:

- [ ] **Skills.** `skills/genie-orca-{wish,work,review}` presentes e autônomas; `skills/genie-orca/` e `retro-collect.ts` removidos; os três lints verdes; nenhuma menção a `haiku`/`sonnet` fora da frase da proibição.
- [ ] **Plugin.** `grep -rn 'CLAUDE_PLUGIN_ROOT\|plugins/genie\|setup --codex' src scripts .github docs README.md` vazio; os cinco assets não-skill re-homeados antes da deleção; `wishes:lint` continua verde (depende de `validate-wish`).
- [ ] **MCP.** Nenhum `genie mcp` no `--help`, nenhum `mcp-server`/`mcp-tools` em `src/`, e `genie init` não escreve `.mcp.json` em nenhum modo.
- [ ] **Omni.** Nenhum `omni` em `src/`, nem `nats` em `package.json`.
- [ ] **Aceite real.** `caio-cria-ds-tokens-hapvida` emendada, `validate-wish --mode orca` verde, executada por `genie-orca-work` com PR aberto; reconstrução provada contra um run deliberadamente resetado.

## Sequência de entrega

Ordem revisada pelo council — o modo sobe para o começo, para que toda deleção posterior já seja provada nos dois modos.

| # | PR | Conteúdo |
|---|---|---|
| 0 | Fixtures de paridade | Goldens do classic + `tests/e2e/orca-mode-lifecycle.sh` (espelho negativo, com commit real). Nada é deletado |
| 1 | **Modo** | `execution.mode` em `workspace.json`, resolvedor puro, gate em `openDb()`, `task sync` no-op, `context --wish --plan`, `init --mode` |
| 2 | UI e MCP saem | `packages/genie-ui`, `ui-bridge`, `bridge-watcher`, `hire_roster` (migração), `mcp-server`/`mcp-tools` + verbo `mcp` + entrada em `.mcp.json`, docs |
| 3 | Realocação | `validate-wish` → `scripts/`, `session-context` → CLI, `references/*` → skills, `agents/*` → `templates/`, promoção das skills orca |
| 4 | CI/release | `ci.yml`, `release-publish.yml` (`publish.if`), `version.yml`, `build-tarballs.yml`, `build-binary.sh` — com o plugin ainda presente e uma tag de dry-run |
| 5 | Omni sai | lib, fila, banco global, handler, verbo, skill, dep |
| 6 | Deprecação | Release que ainda embarca o plugin e ensina a remoção. Único passo irreversível; não deleta nada |
| 7 | `plugins/` sai | + libs/comandos/testes/scripts mortos; rescope de `install/update/uninstall/doctor` |
| 8 | Hooks + publicação | `genie init --claude-hooks` (conjunto por modo); skillset em skills.sh; docs |

## Próximo passo

Review independente desta rev. 3. Depois de SHIP, persistir a evidência e verificar o digest antes de rodar `wish`.

**Gates ainda pendentes:** design review da rev. 3 (não iniciada); a wish só pode ser vertida depois dela.
