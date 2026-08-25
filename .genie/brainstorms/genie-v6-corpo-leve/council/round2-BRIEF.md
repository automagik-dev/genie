# Rodada 2 do council — brief da Sofia (fronteira Genie ↔ Orca)

**Decisão de produto FECHADA, não reabrir:** haverá uma flag/modo específica para Orca. Não argumente contra a existência do modo.

## Fronteira proposta pela Sofia

1. **Separação de responsabilidades.** Genie = compilador Git-native de intenção e gates (brainstorm, WRS, DESIGN, wish, acceptance criteria, review SHIP/FIX-FIRST/BLOCKED, índice e **evidência final**). Orca = **única fonte de verdade da execução ativa** (Run, Task/DAG, Dispatch, worker, retries, perguntas/escalations, terminal/worktree, worker_done).
2. **No modo Orca, sai do caminho operacional obrigatório:** Genie Board, `genie task`, checkout/heartbeat/done, task MCP/UI bridge, snapshots automáticos do Board, e **qualquer sincronização Genie Task ↔ Orca Task**. Proibido dual-write e adapter de sincronização. Board sobrevive apenas no modo legado/default, como projeção/compatibilidade.
3. **"Corpo leve" ≠ apagar o valor do Genie.** Preservar skills e artefatos mínimos de lifecycle/compiler (brainstorm, wish, review, evidence/index, roteamento/bypass). Especialistas de execução/coordenação redundantes podem sair da edição Orca, mas **não apagar os contratos que tornam uma intenção auditável e revisável**.
4. **Mode selection uma vez na borda:** flag explícita, **fail-closed** para valor desconhecido, injeta capabilities/ports; sem condicionais espalhadas. Default atual permanece compatível. **No modo Orca, fallback silencioso para Board/task local é proibido.**
5. **Critérios de aceite sugeridos:** (a) brainstorm→wish→work em modo Orca não cria nem altera task rows/`genie.db`/Board snapshots; (b) toda execução supervisionada prova provenance por Run+Task+Dispatch+worker_done no Orca; (c) default mode mantém comportamento existente; (d) spawn genérico não é rotulado como Orca; (e) nenhum estado precisa ser reconciliado entre dois task managers; (f) rollback da flag é explícito e testado; (g) `Tracker: none` continua válido usando WISH.md/INDEX como identidade humana.
6. **Simplicity gate:** preferir um **adapter/capability boundary pequeno + uma única flag** a fork de produto, sync engine, segundo banco ou protocolo paralelo. Toda nova durable state/recovery path precisa de **requisito atual mensurável**.

## O que mudou vs. a rodada 1 (sua resposta anterior já está registrada; NÃO repita)

- A rodada 1 tratou "modo orca" como uma escolha em aberto. Agora o modo é dado; a discussão é **onde fica a fronteira** e **o que o modo desliga**.
- Sofia introduz "capability/ports injetados na borda" — algo que nenhuma lente propôs. E proíbe explicitamente o fallback silencioso, o que colide com `skills/work/SKILL.md:108` ("No task row? … task tracking is an enhancement, never a blocker") — um fallback silencioso que hoje existe na skill base.

## Conflitos reais a endereçar (cite a posição contrária pelo nome da lente)

- **C1 — Embalagem das skills.** Product-2 e Dissent-2: um skillset publicado, `wish`/`review` como seções gated por modo, só `genie-orca-work` como skill separada ("dois skillsets = Approach A que o DESIGN já rejeitou por drift"). Architecture-2 e Delivery-2: promover `skills/genie-orca-{wish,work,review}` flat. A flag existir não decide a embalagem. Quem está certo **sob a fronteira da Sofia** (item 4: sem condicionais espalhadas)? Seções gated dentro de um arquivo SÃO condicionais espalhadas em prosa — isso muda seu voto?
- **C2 — Hooks.** Architecture-2/Delivery-2/Security-2: re-homear via `genie init`/`genie hook install` em `.claude/settings.json`. Product-2: manter só branch-guard/git-freeze-guard/audit-context. Dissent-2: tudo ou nada, "meio-estado é pior". Sob a fronteira: no modo Orca, quem é dono do worktree é o Orca — os guards do Genie ainda fazem sentido lá, ou são só do modo default?
- **C3 — Omni.** Product-2: deletar (sem H6 não há produtor da fila). Architecture-2: deletar, mas é chamada de produto. Security-2/Dissent-2: decidir explicitamente. Aplique o item 6 (durable state precisa de requisito mensurável): há requisito atual mensurável para `~/.genie/genie.db` global + NATS?
- **C4 — Fallback proibido vs. skills tolerantes.** `work:108`, `wish:80`, `brainstorm:115` hoje fazem warn-and-continue quando não há board. Em modo Orca isso vira **recusa explícita**? Ou a skill simplesmente nunca cita board? Qual é o teste que prova o critério (a)?
- **C5 — Provenance vs. fragilidade do Orca.** Sofia (b) exige provenance por Run+Task+Dispatch+worker_done no Orca; DESIGN Risk #2 registra que `orchestration.db` corrompeu em 2026-08-23 e um run voltou vazio. Se Orca é a única fonte de verdade da execução ativa e é frágil, onde mora a evidência durável — e isso viola o item 2 (sem sync) ou é justamente o item 1 ("evidência final" no Genie)?
- **C6 — Capability/ports na borda.** É realista no código atual (`src/genie.ts` + commander), ou vira indireção sem dono? Architecture: onde exatamente a borda resolve o modo e o que ela injeta?

## Formato da resposta (curto — só deltas)

```
DELTAS (≤10 bullets): o que muda na sua posição da rodada 1 sob esta fronteira. Se nada muda, diga "sem delta" e explique em 1 linha.
OBJEÇÕES NOVAS (≤5): só o que a rodada 1 não cobriu. Cite arquivo:linha.
CONFLITOS: para C1..C6 que tocam sua lente, responda À lente oposta pelo nome, com evidência.
ACEITE: para cada critério (a)-(g) da Sofia: viável / inviável / precisa reformulação (1 linha cada).
DEFAULT RECOMENDADO: para C1, C2, C3 — uma escolha concreta, não "depende". Só marque "pergunte ao Felipe" se nenhuma evidência decidir.
```

Máximo ~60 linhas. Sem repetir o relatório da rodada 1. Não modifique arquivo nenhum. Responda ao team-lead via SendMessage.
