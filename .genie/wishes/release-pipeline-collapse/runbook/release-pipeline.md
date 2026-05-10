# Release pipeline runbook

## Symptoms

A `v*` tag exists on origin but no Release object appears for that tag. Operators see a report or the orphan alert workflow files an issue.

## Diagnosis

Check the orchestrator run for the failed job. The orchestrator sequences build, sign-attest, and publish in one run. Read the failed job logs.

```bash
TAG="v4.260510.6"
gh run list --workflow=release.yml --branch "$TAG"
RUN_ID=12345          # paste the failing run id from the list above
gh run view --log "$RUN_ID"
```

## Recovery

If build succeeded but sign-attest failed, dispatch the per-file escape hatch.

```bash
RUN_ID=12345          # paste the build-tarballs run id
gh workflow run sign-attest.yml \
  --field version=4.260510.6 \
  --field run_id="$RUN_ID"
```

After sign-attest succeeds, dispatch publish with its run id.

```bash
SIGN_RUN=12345        # paste the sign-attest run id
gh workflow run release-publish.yml \
  --field version=4.260510.6 \
  --field run_id="$SIGN_RUN" \
  --field channel=stable \
  --field draft=false
```

If the orchestrator never fires, check that `version.yml` dispatched it.
