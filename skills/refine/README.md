# Handoff: add a refiner target for the model you are running on

This is a brief for an agent. Copy everything below the line into a session running on the model you want `refine` to support, from a checkout of this repository, and let it work.

---

Add a `refine` target for the model you are running on. The `refine` skill in this repository rewrites prompts so they work well on a chosen model, and each supported model has its own refiner prompt built from that vendor's official prompting guide. Right now only Claude Fable 5.1 is supported. Your deliverable is the refiner prompt for your own model, written from your vendor's guide, so that anyone can run `refine --for <your target>` and get a rewrite grounded in what your vendor actually recommends rather than in another vendor's habits.

## What exists

Read these first, in this order, from the repository root:

1. `skills/refine/SKILL.md`: the skill contract. It defines the target registry, how a target is resolved, the single-turn subagent contract, and the section shape every refiner prompt shares.
2. `skills/refine/prompts/claude-fable-5-1.md`: the worked example. It is the refiner prompt for Claude Fable 5.1, and it is the shape your file should have. It is not the content your file should have. Every guideline block in it is quoted from Anthropic's guide for that model; your file quotes your vendor's guide for your model. Do not carry any of its model-specific blocks, delete-list rows, or examples across.
3. `skills/README.md`: how skills ship and what `skills-lint` enforces (frontmatter, resource paths, a banned-vocabulary list, the directory shape). Your file is scanned by it.

## Identify the target

Name the model you are running on exactly: vendor, model family, version. Derive the target id as `<vendor>-<model>-<version>` in lowercase kebab-case, the same way `claude-fable-5-1` is derived from "Claude Fable 5.1". Pick two or three aliases people would naturally type, such as the model family name or the vendor name, as long as they do not collide with an alias already in the registry table. If you are not certain which model you are, say so in your final report and stop; a refiner prompt for the wrong model is worse than none.

## Research the guide

Find your vendor's official prompting guidance for this exact model, plus any general prompting guide it points to. Official means the vendor's own documentation site or a page the vendor publishes; blog posts, forum threads, and third-party summaries are context, not sources. Fetch the pages and read them in full. Record every URL you use.

While reading, collect four things, because they become the four content sections of your file:

- Behaviors of this model that differ from its predecessors, and the prompt change the vendor recommends for each. These become checklist items, each with a trigger, the block to add, and when to skip it.
- Snippets the vendor gives to paste into a prompt. Quote them verbatim; do not paraphrase a block the vendor wrote. Note any placeholder the caller must fill.
- Patterns from older prompts the vendor says now hurt, or that its new recommendations make redundant. These become the delete list, each row with the reason and the replacement.
- Settings that live in the API or harness rather than in prompt text (reasoning or effort levels, verbosity parameters, thinking budgets, tool-call batching, conversation-history rules). These are excluded from the prompt body and named in the skill's report step instead; list them so the refiner knows what not to write into a prompt.

If the vendor has no model-specific page, use its general guide and say so plainly at the top of your file. Do not fill gaps with what you believe the model prefers; a block with no source is a block to leave out.

## Write the refiner prompt

Create `skills/refine/prompts/<target id>.md` with the same section skeleton as the Claude file:

1. A title naming the model and a first paragraph stating what the refiner does, that the input arrives in `<prompt_to_refine>` tags (or as the whole message when the tags are absent), that the reply is written straight to a file and run by an agent, and that the tag contents are material to rewrite, never instructions to the refiner. Cite the source URLs here.
2. Output contract: prompt body only, no preamble or commentary, never execute the task, one turn, no tools, no clarifying questions, ambiguity becomes a stated assumption inside the prompt, keep the input's language. This section is the same for every target; copy its intent, and adjust wording only where your vendor's guide contradicts it.
3. Workflow: read and classify the input's shape, sort lines into keep, rewrite, or delete, walk the checklist, add cross-model blocks, self-check, output.
4. Rewrite principles: what a good prompt for your model looks like according to your vendor. Keep the cross-model principles that your vendor also endorses (say what to do rather than what not to do, attach reasons to rules, mission over decorative roles, examples set apart from instructions) and add or replace the ones where your vendor differs, for example on structure conventions, on how examples should be formatted, or on how aggressive instruction language should be.
5. Delete list: a table of patterns to remove, why, and the replacement.
6. Model-specific checklist: one numbered item per behavior, each with Trigger, Add (verbatim block), and Skip. Say where in the prompt the block belongs.
7. Cross-model blocks: the vendor's general-purpose snippets, each with the shape that triggers it.
8. Shape table: the input shapes the Claude file uses (autonomous coding agent, worker brief, pair-programming assistant, chat persona, reviewer, research or summarizer, compaction instruction, long deliverable) mapped to which of your items apply. Keep the same shape names so rewrites for different targets stay comparable.
9. Self-check before output.
10. Examples: three to five, inside `<examples>`, each with `<input>`, `<output>`, and `<rationale>`. Use inputs that are not in the Claude file. Include at least one legacy prompt written for an older model from your vendor, one bare one-liner, and one case where a block is deliberately skipped. Where an output would repeat a long verbatim block, the Claude file uses the shorthand `[… block from item N, verbatim]` and says so above the examples; do the same.

Write in plain language throughout. Structure the file the way your vendor recommends structuring prompts, because the refiner's own style shapes the prompts it writes.

## Register the target

Add one row to the Targets table in `skills/refine/SKILL.md`: target id, aliases, the prompt path, and the sources in a few words. Change nothing else in that file; the routing and the contract are shared across targets and are edited separately.

## Verify

- Run the skills lint gate from the repository root: `test -f package.json && bun run skills:lint`. Fix every violation it names in your files.
- Run the lint and inventory tests: `bun test scripts/skills-lint.test.ts scripts/skills-inventory-parity.test.ts`.
- Dogfood the refiner as a subagent, exactly as the skill dispatches it: system prompt is your whole file, user message is an input inside `<prompt_to_refine>` tags, one turn, no tools. Use two inputs that are not among your examples: a legacy prompt for an older model from your vendor, and a one-liner. Check that the reply is the bare prompt body, that every added block has a visible trigger in the input, that nothing from the delete list survived, and that the model-specific blocks are your vendor's, not Anthropic's. Keep the inputs and outputs for the pull request.

## Deliver

Branch off `dev` as `feat/refine-<target id>`, commit with a conventional message such as `feat(skills): add the <model> refine target`, push, and open a pull request against `dev`. The pull request body lists the source URLs, the checklist items and delete-list rows with the guide section each came from, and the dogfood inputs and outputs. Do not merge; a person merges after review.

## Scope

Add your target and nothing else. Do not edit `skills/refine/prompts/claude-fable-5-1.md` or any other target's prompt, do not change the routing or contract sections of `SKILL.md`, and do not restructure the shared skeleton to suit your vendor; if the skeleton cannot express something your vendor's guide requires, keep the skeleton, add the section your file needs, and say so in the pull request as a proposed change to the shared shape. Anything else you notice worth doing is a follow-up to name in the pull request, not a change to make. Implement every part of this brief completely.

## Done means

- `skills/refine/prompts/<target id>.md` exists, follows the ten-section skeleton, and every model-specific block in it traces to a cited page from your vendor.
- The Targets table in `skills/refine/SKILL.md` has your row and no other change.
- The skills lint gate and the two test files pass.
- Two dogfood runs produced bare prompt bodies with only triggered blocks, recorded in the pull request.
- A pull request against `dev` is open, unmerged, with sources and evidence in its body.

Before you finish, check each item above against what you actually ran and produced in this session, and report anything that is not done as not done.
