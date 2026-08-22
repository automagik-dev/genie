# genie-orca — genie v6 "corpo leve" (prototype, 2026-08-22)

genie owns the documents + the coordinator protocol. Orca owns orchestration state. Linear owns status. brain owns preferences/memory.

| Skill / script | Status |
|---|---|
| `wish/SKILL.md` | draft from practice (1 wish run) |
| `work/SKILL.md` | draft from practice — the loop that shipped brain PR #163 |
| `review/SKILL.md` | draft; council + retro are review with a different input |
| `scripts/retro-collect.ts` | working; Claude sessions joined by dispatch start time; Codex TODO |
| `scripts/migrate-to-linear.ts` | one-shot, dry-run proven on brain; `--apply` is the human's call |
| brainstorm | unchanged from v5 (human-mandatory) — not copied yet |

Decision records: brain repo `.genie/brainstorms/genie-v6-corpo-leve/COUNCIL.md`, `.genie/wishes/compiled-artifact-honesty/{COUNCIL-agent-home,RETRO}.md`.
Open tensions (owner's call): wish "compiler" vs plain dispatch table · 2 vs 3 default human gates · `review` as its own skill · third review model always-on vs opt-in.
