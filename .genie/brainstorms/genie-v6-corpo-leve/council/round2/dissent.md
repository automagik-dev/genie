# Council rodada 2 — lente DISSENT

_Rodada 2 (2026-08-25): brief da Sofia. Relatório integral do subagente._

## DELTAS
- **C1 muda meu voto.** Round 1 pedi "um skillset, seções gated". Sob o item 4, seções gated em prosa são condicionais espalhadas com pior fail-mode (não existe borda que as resolva — skill é prosa). O que o DESIGN já escolheu — guarda de 1 linha no topo da base (Decisão 3) + arquivo overlay separado (Decisão 2) — é *uma* decisão no ponto de entrada. Passo a apoiar `skills/genie-orca-{wish,work,review}` flat.
- **Isso NÃO é Approach A.** Um skillset publicado com 3 arquivos a mais ≠ fork: a instrução de overlay mantém o corpo da base como corpo. Meu argumento de round 1 só vale se as bases forem duplicadas.
- **C2 muda.** "Tudo ou nada" cai: os guards não são homogêneos — um deles já é inerte em modo Orca.
- **C4 sem delta na conclusão, com novo fundamento**: os fallbacks não precisam ser proibidos porque são **inalcançáveis** em modo orca.
- Sem delta em C3 (Omni), agora com o teste do item 6 aplicado.

## OBJEÇÕES NOVAS
1. **`genie context --wish` é ESCRITOR de `genie.db`.** `src/term-commands/context.ts:372` chama `writeWishBase`; `context.ts:293,331` + `src/lib/v5/base-state.ts:77` (`resolveIntegration`) são o **único** lugar que computa branch de integração + base SHA da wave. `skills/wish/SKILL.md:80` manda rodar isso em APPROVED. Orca não sabe qual é a base de integração. Sob o critério (a) literal, o modo orca fica **sem base pinada** — exatamente o Risk #1 do DESIGN. **Furo estrutural.**
2. **O item 1 já é falso pela própria decisão do DESIGN.** Decisão 13: "Dispatch plan é a fonte; Orca Run/Task é cache reconstruível", com passo de reconstrução obrigatório. Se o Genie reconstrói o Run a partir de um documento em git, o Orca **não** é a única fonte de verdade da execução ativa — é o executor.
3. **`git-freeze-guard` é NO-OP em modo Orca.** `git-freeze-guard.ts:11-18` discrimina por `agent_id`/`agent_type` do PreToolUse da *mesma sessão* CC; `:20-28` é fail-open quando `agent_id` é null. Worker do Orca é processo separado em worktree filha → allow sempre. `branch-guard.ts:20-26` é por padrão de comando, sessão-agnóstico → esse **sim** vale e é a única execução mecânica do §19.
4. **Nenhum handler lê `genie.db`** (grep vazio). Os guards são mode-independentes por construção; a discussão C2 é sobre *re-homing*, não sobre modo.
5. **`roadmap.json` é o vetor de dual-write que ninguém citou.** `roadmap-sync.ts` roda por git hook. Em repo orca, um `git pull` reconcilia board sozinho. Critério (e) só é verdade se `genie init --mode orca` **não instalar** esses hooks.

## CONFLITOS
- **C1 — a Product-2 e ao meu eu de round 1:** seções gated colocam as duas prosas no mesmo arquivo mas não impedem a divergência; a base `wish` tem 113 linhas contra 46 do protótipo — gating em prosa vira `if` em linguagem natural em ~8 pontos. Guarda no topo + overlay é 1 ponto de decisão por arquivo. **Architecture-2/Delivery-2 estão certos sob o item 4.**
- **C2 — a Product-2:** manter `git-freeze-guard` "no modo Orca" é manter enforcement fantasma (obj. 3). Declarar que o freeze é standalone-only e que em orca a proteção é a worktree filha do próprio Orca.
- **C4 — à Sofia:** `grep -n "genie task|genie board|genie context|genie.db" skills/genie-orca/*/SKILL.md` → **zero hits**. O protótipo já nunca cita board. `work:108`, `wish:80`, `brainstorm:115` estão em skills que a guarda de modo abandona antes da linha ser lida. Transformar em recusa explícita **piora**: cria fail-mode novo numa branch inalcançável, e mata o critério (g) — `work:108` ("drive from WISH.md directly") *é* o mecanismo de `Tracker: none`. Proibir fallback e exigir (g) é contradição interna. O teste de (a) é asserção de filesystem/DB, não de prosa.
- **C5 — à Sofia:** (b) é inverificável depois de um reset. O Success Criteria do DESIGN manda **provar reconstrução com o run resetado**; nesse instante `task-list` → 0 e a "provenance por Run+Task+Dispatch+worker_done" não existe mais. Evidência durável tem que morar no Genie, que é o item 1 da própria Sofia. Não é sync: escrita unidirecional em transições (Decisão 10), sem leitura de volta.
- **C6 — a Architecture-2:** não há borda. `src/genie.ts` tem 203 linhas de registro commander e seis módulos importam `openDb` direto. "Injetar ports" significa threadar um binding por ~14k LOC de `src/lib/v5` para gatear algo que o modo já decide **não invocando o comando**. É a Alternativa C do DESIGN com outro nome. Se quiserem guarda dura: checagem fail-closed no `.action()` de `task`/`board`/`context --wish` quando `mode=orca`. Três linhas, não um capability boundary.

## ACEITE
- (a) **precisa reformulação** — `genie.db` ≠ board; trocar por "nenhuma linha em `tasks`/`boards` e `roadmap.json` sem diff"; a gravação de wave base fica explicitamente permitida (obj. 1).
- (b) **precisa reformulação** — Orca prova execução *viva*; a prova durável é o WISH.md/bloco de review.
- (c) **viável** — testável hoje.
- (d) **viável, sem teste definido** — definir "rotulado como Orca" = header `Orchestration` presente; teste = `validate-wish --mode orca`.
- (e) **viável só com emenda** — `init --mode orca` não instala os git hooks de `roadmap-sync`.
- (f) **precisa reformulação** — rollback do *flag* é trivial; rollback da *wish* não existe (Decisão 12 só prevê v5→orca). Escrever: "rollback = volta de modo, não reconstrói board".
- (g) **viável, e colide com o item 4** — depende exatamente do fallback que o item 4 proíbe.

## DEFAULT RECOMENDADO
- **C1:** um skillset publicado, `skills/genie-orca-{wish,work,review}` flat + guarda de 1 linha no topo de `wish`/`work`/`review`. Sem seções gated.
- **C2:** re-homear `branch-guard` + `session-context` (carrier do `mode=`) via `genie init`; declarar `git-freeze-guard` standalone-only por escrito (inerte em orca); demais handlers seguem o corte do plugin, sem gate de modo.
- **C3:** **deletar** Omni inteiro. Item 6 aplicado: único produtor era o hook H6/PermissionRequest do plugin.

**Conclusão:** a fronteira tem **furo estrutural** — `genie context --wish` é o único dono do base SHA da wave e grava em `genie.db` (`context.ts:372`), então o critério (a) como escrito deixa o modo Orca sem base de worktree pinada.
