# Design: <Title>

| Field | Value |
|-------|-------|
| **Slug** | <slug, in backticks> |
| **Date** | YYYY-MM-DD |
| **WRS** | <score>/100 |
| **Size** | <P, M or G> · <one wish, or how it splits> (<who set it, and in which round>) |

<!-- Source: a Settled id (R1-2), a council decision (P3), "reviewer HIGH-1" or "reviewer round-2 C4" for a recorded finding, or a backticked repository path that exists; other words in the cell are prose. -->

## Problem

<One-sentence problem statement, plus 1-2 sentences on why it matters.>

## Scope

### IN

| # | Deliverable | Files changed | Source |
|---|-------------|---------------|--------|
| 1 | <Concrete deliverable> | <each file it changes, in backticks, marked new when created> | <Settled id, council decision, reviewer finding or path> |

### OUT

- <Explicit exclusion — a boundary that prevents scope creep, with the trigger when it is deferred> (Source: <Settled id, council decision, reviewer finding or path>).

## Approach

<Chosen approach with rationale. Name the alternatives considered and why they lost.>

## Simplicity Case

- **Simplest complete design:** <smallest design that satisfies current user stories>
- **Added machinery:** <none, or each mechanism with the present requirement/measurement that justifies it>
- **Deferred until measured:** <plausible future complexity and the concrete trigger for reconsidering it>
- **Complexity removed:** <states, failure modes, options, or dependencies deliberately avoided>

## Decisions

| # | Decision | Rationale | Source |
|---|----------|-----------|--------|
| 1 | <decision> | <why this over the alternatives> | <Settled id, council decision, reviewer finding or path> |

## Risks & Assumptions

| # | Risk | Severity | Mitigation |
|---|------|----------|------------|
| 1 | <risk> | Low/Medium/High | <how we handle it> |

## Success Criteria

- [ ] <Testable criterion — how we know this worked> **Proof:** <the test, command or file that shows it>.
- [ ] <Testable criterion — what "done" looks like> **Proof:** <the test, command or file that shows it>.

## Next Step

After an independent design review returns SHIP, persist the evidence below and verify its content digest before running `wish`.

<!-- genie-design-review:start -->
## Design Review Evidence

- **Verdict:** PENDING
- **Reviewed content SHA-256:** PENDING
- **Reviewer:** PENDING
- **Reviewed at:** PENDING
<!-- genie-design-review:end -->
