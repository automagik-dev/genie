# Mikro engine-split evidence

## Current tree

This directory keeps thirteen byte-pinned manual experiment inputs and the complete
original 40-row correctness and 22-row quality source reviews. It no longer repeats
historical logs, failed attempts or nine full candidate inventories in the code diff.

- [Current cleaned-tree manifest](CURRENT-MANIFEST.json): complete byte/mode inventory,
  explicit deletions and two named future-metadata exclusions.
- [Cleanup verification](CLEANUP-VERIFICATION.json): fresh checks and independent
  cleanup-only review; not a regrade of the paid comparison or original source reviews.
- [Original correctness review](G9-SOURCE-ONLY-SHIPPED-ARCHIVE-TERMINAL-563-FINAL-CORRECTNESS.json) and
  [original quality review](G9-SOURCE-ONLY-SHIPPED-ARCHIVE-TERMINAL-563-FINAL-QUALITY.json): retained verbatim, still bound to
  candidate `7241a0a39d2a270093e6ae0d1af905f9603b3092eff373795146f493ff8e29e9`. Their historical internal evidence paths
  resolve in the archive below, not necessarily in the cleaned filesystem.

## Immutable archive

Archive commit: `1b58ca73a1b9e322597a41000cc4ebd897e86bdc`; it remains an ancestor of the cleanup commit.
Every removed tracked blob was matched against GitHub's complete, non-truncated
archive tree before removal. Nothing is rewritten, squashed, rescored or erased
from history. This reduces PR review scope, **not Git history or clone size**.

- [Complete engine-split evidence](https://github.com/automagik-dev/genie/tree/1b58ca73a1b9e322597a41000cc4ebd897e86bdc/.genie/wishes/mikro-engine-split/evidence)
- [Original publication WISH](https://github.com/automagik-dev/genie/blob/1b58ca73a1b9e322597a41000cc4ebd897e86bdc/.genie/wishes/mikro-engine-split/WISH.md)
- [Reviewed source manifest](https://github.com/automagik-dev/genie/blob/1b58ca73a1b9e322597a41000cc4ebd897e86bdc/.genie/wishes/mikro-engine-split/evidence/G9-SOURCE-ONLY-SHIPPED-ARCHIVE-TERMINAL-563-FINAL-CANDIDATE-MANIFEST.json)
- [Whole Genie gate](https://github.com/automagik-dev/genie/blob/1b58ca73a1b9e322597a41000cc4ebd897e86bdc/.genie/wishes/mikro-engine-split/evidence/G9-SOURCE-ONLY-SHIPPED-ARCHIVE-TERMINAL-563-WHOLE-GENIE-GATE.json)
- [Whole Mikro/install gate](https://github.com/automagik-dev/genie/blob/1b58ca73a1b9e322597a41000cc4ebd897e86bdc/.genie/wishes/mikro-engine-split/evidence/G9-SOURCE-ONLY-SHIPPED-ARCHIVE-TERMINAL-563-WHOLE-MIKRO-INSTALL-GATE.json)
- [Four release payloads](https://github.com/automagik-dev/genie/blob/1b58ca73a1b9e322597a41000cc4ebd897e86bdc/.genie/wishes/mikro-engine-split/evidence/G9-SOURCE-ONLY-SHIPPED-ARCHIVE-TERMINAL-563-FOUR-RELEASE-PAYLOADS.json)
- [Previous publication/remote receipt](https://github.com/automagik-dev/genie/pull/3139#issuecomment-6094918425)
- [Imported Mikro archive and retained-input index](../../../../mikro/.genie/INDEX.md)

For any original repository-relative path, its exact archived URL is
`https://github.com/automagik-dev/genie/blob/1b58ca73a1b9e322597a41000cc4ebd897e86bdc/<original-path>`.
For local inspection, use `git show 1b58ca73a1b9e322597a41000cc4ebd897e86bdc:<original-path>`.
Deleted paths are enumerated in the current manifest; their original bytes remain
at the same path in that commit. No redirect stubs or additional archive branch
are needed.

## Paid observations and limits

The original 108 engine and 18 native histories remain incomplete/confounded;
seven engine full-total gaps and three native accounting/provenance gaps remain.
No rerun, JEV, refreeze, resampling, regrading, canonical report append or routing
recommendation was performed. RLM remains the default; whole-wish acceptance is
still blocked. The existing pricing review thread is not resolved by cleanup.

- [Engine cohort](https://github.com/automagik-dev/genie/blob/1b58ca73a1b9e322597a41000cc4ebd897e86bdc/.genie/wishes/mikro-engine-split/evidence/G8-RECEIPT3-ENGINE-108-COMPLETE.json)
- [Native cohort](https://github.com/automagik-dev/genie/blob/1b58ca73a1b9e322597a41000cc4ebd897e86bdc/.genie/wishes/mikro-engine-split/evidence/G8-RECEIPT3-NATIVE-18-COMPLETE.json)
- [Failed paired report](https://github.com/automagik-dev/genie/blob/1b58ca73a1b9e322597a41000cc4ebd897e86bdc/.genie/wishes/mikro-engine-split/evidence/G8-RECEIPT3-FINAL-PAIRED-REPORT.json)
- [Historical cohort preservation](https://github.com/automagik-dev/genie/blob/1b58ca73a1b9e322597a41000cc4ebd897e86bdc/.genie/wishes/mikro-engine-split/evidence/G8-PRE-REPAIR-COHORT-PRESERVATION.json)

These links preserve tracked receipts, not every private paid-run byte. Existing
private cohorts, their seals and canonical reports remain untouched. The latest
post-publication local receipt was also preserved outside this checkout before
its tracked predecessor was removed. No credentials or private run data are
published by this cleanup.
