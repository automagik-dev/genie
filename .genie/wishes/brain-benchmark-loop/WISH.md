# Wish: brain-benchmark-loop

> Find the optimal KB organization strategy by benchmarking every combination of splitting, metadata, and retrieval against a real PagBank customer-support dataset with LLM-as-judge evaluation.

## Status: IN_PROGRESS

## Context

We have the first **real production dataset** for brain:

- **`kb.md`** (1.5 MB, 21K lines) — 1,417 PagBank support articles, each with `[Problema]`, `[Solução]`, `[Tipificação]`, `[Sugestão de fala]` blocks
- **`questions.csv`** (812 KB) — 1,449 questions with expected answers, single category `adquirencia`
- 96.3% of expected answers appear verbatim in `kb.md` — this dataset has near-perfect alignment

This is the **first real-world benchmark** for the brain engine. The results will define our **KB templates** — the recommended way to organize content for maximum retrieval accuracy.

## Objective

Build a **benchmark harness** that:

1. Splits `kb.md` using multiple strategies (not just monolithic)
2. Creates test brains with each strategy
3. Runs all 1,449 questions through each brain
4. Uses **LLM-as-judge** (via brain's own rlmx/CAG) to score answer correctness — never leaks ground truth into the retrieval pipeline
5. Records metrics per experiment: Recall@K, MRR, confidence calibration, latency
6. Produces a comparison matrix identifying the optimal KB strategy

## Non-Goals

- NOT building a permanent `bench` CLI command (that's a separate wish)
- NOT modifying the brain engine core — use it as-is
- NOT testing against multiple domains — this is PagBank-specific
- NOT optimizing for cost at this stage — optimize for correctness first

## Approach: LLM-as-Judge

**Critical:** The benchmark must NOT compare search results to expected answers via string matching. Instead:

1. For each question, run search against the test brain
2. Collect the top-K search results (content + confidence)
3. Send to LLM judge: "Given this question and these search results, rate answer completeness 0-10"
4. Separately, use **CAG strategy** and **rlmx analyze** for deep evaluation on a sample
5. Score dimensions: **correctness** (does the answer address the question?), **completeness** (all relevant info?), **confidence calibration** (does brain confidence match actual quality?)

This simulates real-world usage where there IS no ground truth — the agent must judge quality from search results alone.

## Experiment Matrix

### Phase 1: Splitting Strategies (find the right document granularity)

| ID | Strategy | Description |
|----|----------|-------------|
| S1 | monolith | Entire `kb.md` as 1 file |
| S2 | by-separator | Split on `---` boundaries (~716 docs) |
| S3 | by-problem | Each `[Problema]...[Sugestão]` = 1 doc (~1,417 docs) |
| S4 | by-product | Group by product field (61 category files) |
| S5 | qa-clean | Extract problem + solution only, strip metadata |
| S6 | sugestao-only | Only `[Sugestão de fala]` blocks (concise answers) |
| S7 | hierarchical | Unidade/Produto/article.md with MOC index files |
| S8 | hybrid-smart | S3 + frontmatter from tipificação + wikilinks between related |

### Phase 2: Retrieval Strategies (on top-2 splits from Phase 1)

| ID | Strategy | Description |
|----|----------|-------------|
| R1 | RAG default | BM25(1.0) + Trigram(0.8) + Vector(1.2) |
| R2 | RAG keyword-heavy | BM25(2.0) + Trigram(1.0) + Vector(0.5) |
| R3 | RAG semantic-heavy | BM25(0.5) + Trigram(0.3) + Vector(2.0) |
| R4 | CAG | RAG + full docs + rlmx reasoning |

### Phase 3: Parameter Sweep (on best split + strategy)

- `--limit`: 1, 3, 5, 10
- `--min-confidence`: 0.0, 0.3, 0.5

## Evaluation Protocol

### Sampling Strategy

- **Full sweep** for Phase 1: Use a **representative sample of 100 questions** (stratified by answer length: short/medium/long) per splitting strategy to keep cost manageable
- **Focused sweep** for Phase 2-3: Run full 1,449 on top-2 configs

### LLM Judge Scoring (per question)

```
Score 0-2: MISS — search results don't address the question at all
Score 3-5: PARTIAL — some relevant info but incomplete or indirect  
Score 6-8: GOOD — answer is substantially correct and useful
Score 9-10: PERFECT — complete, accurate, directly answers the question
```

### Aggregate Metrics

| Metric | Formula | Target |
|--------|---------|--------|
| **Hit Rate** | % of questions scoring >= 6 | >= 90% |
| **Perfect Rate** | % of questions scoring >= 9 | >= 75% |
| **MRR** | Mean reciprocal rank of first relevant result | >= 0.80 |
| **Avg Score** | Mean judge score across all questions | >= 7.5 |
| **Confidence Calibration** | Correlation between brain confidence and judge score | >= 0.6 |
| **p50 Latency** | Median search time | < 500ms |

## Deliverables

1. **`benchmark-runner.sh`** — Main orchestration script
2. **`splitters/`** — One Python script per splitting strategy
3. **`results/`** — CSV files with per-question scores per experiment
4. **`REPORT.md`** — Final comparison matrix with recommended KB strategy
5. **`optimal-template/`** — The winning KB structure as a reusable template

## Acceptance Criteria

- [ ] At least 6 splitting strategies tested
- [ ] At least 3 retrieval strategies tested on top splits
- [ ] LLM judge scores all results (no string-matching shortcuts)
- [ ] Final report includes clear recommendation with evidence
- [ ] Optimal strategy achieves Hit Rate >= 85%
- [ ] Template directory ready for reuse on other domains

## Data Location

```
brain-benchmark-improvement-loop/
  questions.csv    # 1,449 questions with expected answers (DO NOT use for matching)
  kb.md            # 1.5MB source knowledge base
```

## Timeline

Single autonomous session. Phased execution with early stopping if a strategy clearly dominates.
