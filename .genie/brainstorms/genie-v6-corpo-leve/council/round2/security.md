# Council rodada 2 — lente SECURITY

_Rodada 2 (2026-08-25): brief da Sofia. Relatório integral do subagente._

## DELTAS
1. R3 muda de alvo: se as células do Dispatch plan viram argv, o único gate mecânico possível é `validate-wish --mode orca` no momento da escrita/lint — o coordenador é prosa e não é um controle. Não existe runtime genie no caminho para validar (DESIGN.md:43).
2. C2: retiro "hooks morrem inteiros". Sob a fronteira, branch-guard fica MAIS relevante em modo orca (o coordenador é o único escritor git e o único que faz merge e PR — genie-orca-work:53,66), e git-freeze-guard vira no-op provado.
3. C1: mudo o voto para skills flat separadas — por razão de segurança, não de estilo (evidência nova em OBJEÇÕES 1/2).
4. C5: "evidência final no Genie" não é sync se for append-only, unidirecional e nunca relida para decidir dispatch.
5. Item 4 (fail-closed): DESIGN.md:104/115 hoje diz "valor inválido cai para o global" — isso é fail-OPEN em repo orca (cai em standalone = board escreve, exatamente o que o item 4 proíbe). Precisa de um terceiro estado.

## OBJEÇÕES NOVAS
1. O que está instalado já divergiu do git: `~/.claude/skills/genie-orca-{wish,work,review}/SKILL.md` ≠ `skills/genie-orca/{wish,work,review}/SKILL.md` (diff em description, invariante, precondições, "sol" vs "terra"). A regra do round 1 ("verifique por diff contra a tag") já está quebrada antes de publicar. Qualquer embalagem escolhida precisa de um smoke de paridade no `check`.
2. O overlay hoje é implementado como **cópia**: `~/.claude/skills/genie-orca-wish/references/base-wish/SKILL.md` (113 linhas) é byte-idêntico a `skills/wish/SKILL.md` (113) — hoje. Cópia sem pin é o drift pelo qual o Approach A foi rejeitado (DESIGN.md:65). Exige check de paridade byte-a-byte no padrão de `hook-bundle-parity`/`codex-plugin-only-smoke`.
3. `genie hook install` não existe: `hook` só tem `dispatch` (src/hooks/dispatch-command.ts:226,229) e `claude-settings.ts` só limpa legado. C2 na versão "re-homear" é código novo que escreve `~/.claude/settings.json`, não uma realocação.
4. `worker_done` não prova nada sobre git: payload = taskId/dispatchId/outcome/filesModified (genie-orca-work:43); SHA/branch/validation vêm como **prosa digitada pelo worker** (:90). `filesModified` é auto-declarado. Não há session id no receipt (DESIGN.md:101).
5. `validation_cmd` é célula de tabela em prosa de repo executada em shell dentro do worktree do worker. Um PR que adiciona uma linha no Dispatch plan é execução de código no host — hoje sem nenhuma restrição de forma.

## CONFLITOS
- **C1 (a Product-2/Dissent-2):** muda meu voto. Seções gated dentro de um arquivo são condicional em prosa que **nenhum teste consegue afirmar** — não dá para provar "o ramo standalone não foi lido". Com arquivos separados, a guarda vira asserção de seleção (DESIGN.md:116) e o Risk#5 (roteador contornado) fica testável. Ganha Architecture-2/Delivery-2 — com a condição da objeção 2 (paridade da base bundlada) e da 1 (paridade repo↔publicado).
- **C2 (a Dissent-2 "tudo ou nada" e a Product-2 "manter os três"):** a Product-2 mantém um no-op. git-freeze-guard discrimina por `agent_id/agent_type` do subagente no MESMO checkout (git-freeze-guard.ts:11-17); em modo orca os workers são processos separados em child worktrees, `agent_id` chega null → allow sempre. audit-context injeta `git log` no Write/Edit (audit-context.ts:1-9) e o coordenador não edita arquivo de grupo (:10) — é conveniência, não controle. À Dissent-2: o "meio-estado" ruim é ter dois veículos de dispatch, não um conjunto de handlers escolhido por modo; o envelope fail-closed (src/hooks/index.ts:141-192) fica intacto nos dois.
- **C3 (a Product-2/Architecture-2):** concordo com deletar, com o item 6 aplicado: sem H6/PreToolUse não há produtor da fila (omni-approval.ts é handler PreToolUse), approvals já nascem OFF (omni-config.ts:131) — `~/.genie/genie.db` global + NATS é durable state + daemon com zero consumidor medido.
- **C5 (à Sofia):** (1) hoje o Orca prova identidade de dispatch (task/dispatch id, `launch.effective` do receipt — genie-orca-work:38) e nada mais; SHA/branch/validação são auto-relato e o join sessão↔dispatch é declarado frágil (DESIGN.md:101). (2) Para a auditoria sobreviver à perda do `orchestration.db` (DESIGN.md:100), a linha de Status log (:53) precisa carregar 7 campos: data · grupo · `run_/task_/dispatch_` · agent+model+effort **efetivos do receipt** · faixa de SHA **verificada pelo coordenador com `git log`, não copiada da prosa** · verdict + família do reviewer · comando de validação + linha de resumo citada. (3) Não é sync: sync é bidirecional e reconciliável (foi isso que quebrou aqui — "genie.db e roadmap.json divergiram", DESIGN.md:11). Isto é append-only, num sentido só, em transição, lossy por design. A regra que impede virar sync: **nada que o genie escreve pode ser relido pelo coordenador para decidir dispatch** — a única exceção é o Dispatch plan, que é *upstream* do Orca (Decisão 13), não espelho dele. Teste: com o run resetado, a reconstrução lê só o Dispatch plan + header e nunca o Status log.
- **R3 sob o novo enquadramento (quem valida argv):** o validador, no lint, mais o gate humano. Concreto: `validate-wish --mode orca` reprova a wish (não avisa) se `agent`/`model`/`effort` saírem de enums fechados, `worktree` não casar `^[a-z0-9][a-z0-9-]{0,63}$`, ou `validation_cmd` contiver `;`, `&&`, `||`, `|`, backtick, `$(`, `>`/`<` ou newline. O diff do Dispatch plan é parte explícita do que o humano aprova no gate `wish-approval`. O coordenador escala em vez de dispatchar uma linha fora de forma. O prompt do worker (prosa da wish) continua injeção não coberta, igual v5: sem delta.

## ITEM 4 — o que "fail-closed" tem de garantir para não virar oráculo
- Três estados, não dois: `standalone` | `orca` | `unresolved`. Valor desconhecido/malformado NUNCA cai para o global (isso escolhe standalone = board escreve). Na CLI, `unresolved` é exit ≠ 0 nomeando a chave e o enum permitido; no SessionStart (que não pode recusar), emite `mode=unresolved` e as skills base tratam como "pare e pergunte", nunca como standalone.
- Anti-oráculo: cap de tamanho ANTES do parse; saída byte-idêntica para todas as causas inválidas (JSON quebrado, arquivo grande, enum errado, tipo errado, ilegível, ausente); nenhum byte do arquivo em stdout/stderr (nem truncado, nem em erro do Zod); alvo fora de `.genie/` recusado sem `stat`.
- Testes: (1) tabela sobre {2 válidos, string desconhecida, tipo errado, valor com newline/ANSI/`../`, 1 MB, JSON inválido, symlink para fora, ausente} afirmando saída byte-idêntica em todos os inválidos e que nenhuma substring ≥8 chars do input aparece em stdout/stderr; (2) propriedade: para qualquer input, stdout casa `^mode=(standalone|orca|unresolved)$`; (3) precedência env > repo > global; (4) exit code na borda CLI; (5) worker (`GENIE_WORKER=1`) continua `{}` (DESIGN.md:23).

## ACEITE (a)-(g)
(a) viável — testável por "nenhum `genie.db` criado + nenhuma linha `genie task` executada" num repo temporário.
(b) precisa reformulação — o Orca prova Run/Task/Dispatch e `launch.effective`; NÃO prova SHA nem arquivos (auto-relato, :90). Reformular para "provenance = ids do Orca + SHA verificado pelo coordenador".
(c) viável — suíte atual é o baseline; standalone não muda.
(d) viável — depende de (b) reformulado: o rótulo vem do header `Orchestration`, não do spawn.
(e) viável e é o critério mais forte: casa com a regra "nada escrito pelo genie é relido para decidir dispatch".
(f) viável — rollback = trocar valor + reiniciar sessão; teste = mesma wish em modo default não recusa.
(g) viável — `Tracker: none` já está implementado como Status log em `genie-orca-work:17`.

## DEFAULT RECOMENDADO
- **C1:** três skills flat publicadas (`genie-orca-{wish,work,review}`), sem seções gated; obrigatório check de paridade byte-a-byte para (i) repo ↔ publicado e (ii) `references/base-*` ↔ skill base. Sem esse check, flat vira o fork que o DESIGN rejeitou.
- **C2:** um veículo (`genie hook install` escrevendo `~/.claude/settings.json`, código novo), conjunto de handlers por modo — **modo orca instala só branch-guard**; git-freeze-guard e audit-context ficam default-mode-only. Envelope fail-closed idêntico nos dois modos.
- **C3:** deletar Omni inteiro (queue global, NATS, runner, handler de aprovação). Sem produtor e sem requisito medido.
