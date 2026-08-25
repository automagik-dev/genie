# Council rodada 2 — lente PRODUCT

_Rodada 2 (2026-08-25): brief da Sofia (fronteira Genie↔Orca, modo Orca como decisão fechada). Relatório integral do subagente._

# PRODUCT — rodada 2 (fronteira Sofia)

## DELTAS
1. **C1: meu voto muda, com condição.** Na rodada 1 eu rejeitei skills separadas porque a seleção do modo era prosa (guarda `mode=orca` no topo de 3 bases, DESIGN.md:28, Risk 5 DESIGN.md:103). Sob o item 4 (modo resolvido UMA vez na borda, fail-closed), a seleção deixa de ser prosa — e aí a embalagem mais barata é arquivo separado, sem nenhuma condicional dentro do SKILL.md.
2. Concedo a **Architecture** (round1/architecture.md:60) e à **Delivery** (round1/delivery.md:73): promover `skills/genie-orca-{wish,work,review}` flat. Motivo que aceito e não tinha na rodada 1: seção gated é uma condicional avaliada por LLM em tempo de leitura — não é testável, não falha fechado, e é exatamente "condicional espalhada em prosa" do item 4.
3. **Mas a concessão tem preço**: separação só é fail-closed se a borda controlar a *exposição* (um repo vê UM conjunto). Se os dois conjuntos ficarem instalados lado a lado, volta a ambiguidade de auto-seleção que motivou meu voto original — e nenhuma das duas lentes endereça isso.
4. **C4: abandono a ideia de "recusa na prosa".** A prova do critério (a) não pode morar em SKILL.md. Move para a CLI: em `mode=orca`, os verbos de mutação do board (`task create/checkout/done`, `idea`, `context --wish` não-plan) saem com exit≠0 e mensagem explícita. Uma guarda, na borda, testável.
5. **C3: endureço para DELETE.** Na rodada 1 escrevi "STAYS-RESCOPED ou LEAVES". Com o item 6 aplicado, não há requisito mensurável: default é `false` (`src/lib/omni-config.ts:131`), o único produtor real da fila é o hook H6 de Codex (`plugins/genie/hooks/codex-hooks.json:30` → `src/hooks/handlers/omni-approval.ts:342`); o outro `enqueueApproval` (`src/term-commands/omni.ts:220`) é auto-teste.
6. Item 1 da Sofia já dá "perguntas/escalations" ao Orca. Manter Omni = **segundo protocolo paralelo** de escalation, proibido pelo item 6.
7. Sem delta em: deletar `plugins/`, docs v4, UI/bridge, tmux `shortcuts` — nada na fronteira toca isso.

## OBJEÇÕES NOVAS
- **DESIGN.md:21 viola o item 4 na letra.** Valor inválido em `.genie/config.json` "cai para o global" — isso é fallback silencioso, não fail-closed. Sob a fronteira: valor desconhecido = erro na borda, sessão para.
- **`review` fica quase sem delta.** O único acoplamento a board no `review` é `skills/review/SKILL.md:192` e `:196` (`genie task done`). Duas linhas. Uma skill inteira `genie-orca-review` para deletar duas linhas é caro; o valor real do delta é outro (VERDICT: na 1ª linha, tiers, cap 2). Architecture (round1/architecture.md:76) e Delivery (:97) chamam isso de "overlay" — mas **não existe primitivo de include** (delivery.md:101 admite). "Overlay" hoje = copiar o corpo da base em prosa = drift garantido. Se for flat, que seja **arquivo completo e autossuficiente**, com lint de divergência — não "carregue a base e aplique deltas".
- **`skills/genie/SKILL.md:74–93`** (Operational Command Mapping, 10 linhas de verbos de board + "monitor through `genie board`") é o maior bloco condicional-por-modo do repo. Nenhuma lente propôs partir o roteador — e ele é o ponto de entrada do usuário. Sob o item 4, ou o roteador vira dois arquivos também, ou a tabela some e o roteador delega ("execução: pergunte ao Orca").
- **Corrupção do Orca é fato de produto, não risco teórico** (DESIGN.md:100: `orchestration.db` corrompido em 2026-08-23, `run_c90e56f0bcd5` vazio). O usuário perde o run, não o wish — desde que Dispatch plan seja seção obrigatória e commitada.

## CONFLITOS
- **C1 — para Architecture e Delivery:** vocês ganham o mérito (flat, sem condicional), mas as duas propostas dizem "overlay: carrega a base e aplica deltas" (architecture.md:74/76, delivery.md:95/97). Isso é condicional espalhada com passo extra: o LLM precisa reconciliar dois documentos em tempo de execução. Sob o item 4 não sobrevive. Aceito flat **só como três arquivos autônomos**, sem instrução de "load base". E exijo a exposição exclusiva por repo — senão meu argumento de drift/ambiguidade da rodada 1 continua de pé.
- **C1 — para Dissent (meu aliado anterior):** "dois skillsets = Approach A rejeitada por drift" continua verdade **se** os dois ficarem visíveis juntos. Com exposição exclusiva na borda, drift vira problema de lint, não de UX.
- **C3 — para Security e Dissent ("decidir explicitamente"):** decidido. Delete. ~9.1k LOC (`omni-runner.ts` 2669 + teste 2961, `omni-queue.ts` 1089, `global-db.ts` 480, `omni.ts` 564+463, handler 372, `skills/omni` 89) sustentando um caminho desligado por padrão cujo produtor morre junto com o plugin. Concordo com Architecture que é chamada de produto — e a chamada é remover.
- **C4 — para quem quer recusa na prosa:** recusa em prosa é condicional espalhada com outro nome. Melhor para o usuário é **a skill orca nunca citar board** + a CLI recusar. O usuário nunca lê um "não posso"; ele simplesmente não é levado até lá. A única recusa que fica em prosa é a de `genie-orca-work` sem Dispatch plan — porque é falta de *input*, não de modo.
- **C5:** evidência durável mora no Genie (WISH.md/INDEX/review evidence) — isso é o item 1 ("evidência final"), não sync. Sync proibido é *estado ativo*; ids de Run/Task no header da wish são texto commitado, escrito uma vez pelo coordenador.

## INVENTÁRIO
**Item 2 — o que o modo Orca DESLIGA:** `skills/work/SKILL.md:21,25,28,43,75,82,103,106,108,139` (checkout/list/board/done/`context --plan`/fallback); `skills/wish/SKILL.md:75–80` (step 9 task create) e `:83` (step 12 wave base); `skills/brainstorm/SKILL.md:115` (board pointer); `skills/review/SKILL.md:192,196` (`genie task done`); `skills/genie/SKILL.md:74–93` (tabela operacional inteira); comandos `board`/`task`/`idea`/`mcp`/`ui-bridge` e `src/lib/v5/{task-state,roadmap-sync,launch-worktrees}.ts`; snapshot automático `roadmap.json`.

**Item 3 — o que PRESERVAR:** `skills/brainstorm/SKILL.md:109–114` (stage DESIGN/DRAFT/INDEX) e :119–120 + `references/design-review-evidence.mjs` (evidência de design review carimbada por SHA-256); `skills/wish/SKILL.md:81` (wishes:lint) e `:82` (persistência do veredito pelo orquestrador); `skills/review/SKILL.md` checklists/severidades/VERDICT; `src/lib/wish-status.ts` (vocabulário DRAFT→SHIPPED); `.genie/INDEX.md` + doctor `index-lane drift`; `scripts/{skills-lint,wishes-lint,validate-wish}`; roteamento/bypass do `skills/genie`.

## ACEITE (a)–(g)
(a) viável — mas só se provado na CLI (guarda fail-closed), não em prosa; teste: `mode=orca` + fluxo → `.genie/genie.db` inexistente e `roadmap.json` byte-idêntico.
(b) precisa reformulação — provenance no Orca é volátil (DESIGN.md:100); exija Run+Task+Dispatch+worker_done **e** os ids commitados no header da wish.
(c) viável — default `standalone`, suíte atual verde é o gate (DESIGN.md:114).
(d) viável — rótulo Orca só quando a borda resolveu `mode=orca`; spawn genérico não recebe capability.
(e) viável — consequência direta de deletar o board do caminho orca; nada a reconciliar se nada é escrito.
(f) viável — rollback = trocar o valor na borda; teste de ida-e-volta com o mesmo repo.
(g) viável — `Tracker: none` já é o tier 3 exercitado hoje (DESIGN.md:73); WISH.md/INDEX é identidade humana e sobrevive à corrupção do Orca.

## DEFAULT RECOMENDADO
- **C1:** `skills/genie-orca-{wish,work,review}` **flat e autossuficientes** (sem "load base"), base `wish/work/review` sem nenhuma menção a orca, roteador `genie` com a tabela operacional removida e delegação por modo. Exposição exclusiva por repo decidida na borda; `skills-lint` falha se um arquivo orca contiver `genie task|genie board|genie context --plan`, e se um par base/orca divergir em seção obrigatória.
- **C2:** hooks re-homeados por `genie init` em `.claude/settings.json`; em modo Orca ficam **só `branch-guard` e `git-freeze-guard`** (protegem git, que é do Genie em qualquer modo); `audit-context` é telemetria de execução → só no modo default. `identity-inject`/`freshness`/`omni-approval` deletados.
- **C3:** **DELETE Omni inteiro** em v6 — `src/lib/omni-*.ts`, `src/lib/v5/{global-db,omni-queue}.ts`, comando `genie omni`, `src/hooks/handlers/omni-approval.ts`, `skills/omni`. Some a segunda base de dados global e a dependência NATS. Nota de CHANGELOG, sem camada de compatibilidade.
