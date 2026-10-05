# DRAFT — Prime 0.8.1 reconciliation

Date: 2026-08-31
Status: VALIDATION-READY — NOT REVIEWED

WRS: ██████████ 100/100

- Problem ✅ — this is an evidence/reconciliation wish, not a hidden parity project. A valid outcome may be `PRIME_SDK_INELIGIBLE` or `CAMPAIGN_NO_GO`, with Mikro remaining default.
- Roles ✅ — Mikro is incumbent/effective default; `prime-sdk` is the sole eligibility candidate; opaque subprocess `prime` is observational comparator/explicit fallback only.
- Capability truth ✅ — exactly 35 rows distinguish positive `SUPPORTED`, field-oriented `CURRENT_REJECT`, accepted/ignored `SILENT_GAP`, `GAP`, `N/A`, and `UNVERIFIED` current observations from the required eligibility oracle. A field error without the capability ID does not satisfy required `LOUD-REJECT`; mandatory unavailable parity never becomes `PASS`.
- Dictionary context ✅ — `CAP-09` truthfully records `prime-sdk` as `SILENT_GAP`: production loaders return dictionary JSON as a serialized string, while the adapter enumerates that string into character-indexed, one-character snapshots. Its deterministic v2 fixture creates a real JSON file, calls both `loadContextFromFile()` and `loadContext()`, and passes each exact returned `LoadedContext` unchanged to the adapter; no cast or reconstructed object shape is admissible, and this child does not implement the future dict fix.
- Recursion ✅ — `CAP-19`, `CAP-31`, and `CAP-32` require capability-ID `LOUD-REJECT` while child identity and usage/cost cannot be proven. Subprocess `prime` currently rejects only `budget.max_depth`; Mikro and `prime-sdk` accept recursion without the required receipts, so all fail closed.
- Gemini ✅ — `CAP-29` contains the supported Gemini set: both Prime adapters apply thinking level and take the row's allowed named-rejection path for the other fields. `CAP-30` contains future `computerUse`, `mapsGrounding`, and `fileSearch`: Mikro silently gaps while both Prime adapters field-reject, which still falls short of the required capability-ID oracle.
- Spec tools and validation ✅ — subprocess `prime` silently gaps `agent.spec.tools[]` and `VALIDATE.md`; `prime-sdk` supports spec tools but silently gaps `VALIDATE.md`. These are not mislabeled as current rejection.
- Campaign ✅ — exact-control comparison is Mikro versus `prime-sdk` only: `2 runtimes × 2 models × 6 tasks × 5 = 120` scored calls plus `2 × 2 = 4` probes, exactly **124 calls**.
- Executability ✅ — committed 124-row call map, six task fixtures, strict call/control schemas, Cartesian set-equality validator, 35-row capability validator, and joined evidence validator are required before network use.
- Fail-closed controls ✅ — each campaign call needs harness, captured final outbound request, and raw provider usage/cost receipts. Any untransmittable or unobservable control/receipt ends the campaign before scoring; no defaults, estimates, or zero-fill.
- `prime` boundary ✅ — at most two separately authorized live observations plus deterministic fallback probes; they are excluded from the 124 calls and all eligibility/quality/cost/latency verdicts.
- Legacy benchmark boundary ✅ — the removed four-file benchmark v1 and its three-arm/186-call design are superseded and OUT. They are not recreated, merged into v2, or accepted as evidence for the 35-row capability matrix, 124-call campaign, gates, or owner decisions.
- Future work ✅ — missing snapshots, cancellation, budgets, protocol, receipts, recursion, or provider features require separately scoped and approved future wishes. This child records gaps instead of implementing them.
- Authorization ✅ — Felipe first authorizes one non-effective mutation candidate, then separately makes a final selection bound to its isolated post-mutation identity and evidence.
- Deployment order ✅ — post-mutation reruns occur only in an ephemeral non-effective local sandbox. Remote dev follows Felipe's final selection and independent immutable review; this design grants no separate dev-only authorization.
- Rollback ✅ — live bounded MCP history, eight-turn cap, expected restart loss, no conversion, and restored omitted/default Mikro semantics remain exact.
- Safety ✅ — every missing, failed, stale, ineligible, or incomplete state retains Mikro. Automatic fallback and all backend deletion remain OUT.

Simplest complete design: reconcile current truth, run only provable in-process comparisons, allow an honest no-go, and require two owner decisions before any separately reviewed remote delivery.

Next Step: local DRAFT validation only. Do not review, benchmark, use network/provider calls, mutate runtime state, invoke owner gates, or touch remote dev in this step.
