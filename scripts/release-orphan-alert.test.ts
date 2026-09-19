import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Contract tests for `.github/workflows/release-orphan-alert.yml`.
 *
 * The workflow is a scheduled bash step: it cannot be unit-tested by calling
 * it, so the file itself is the artifact under test. Each assertion below
 * pins one behaviour that has already cost the repo an incident:
 *
 *  - the auto-close pass (an incident filed for a tag whose Release later
 *    landed stayed open forever, so the `release-incident` label stopped
 *    meaning "still broken"),
 *  - the promotion-tag skip (a main promotion tag has no Release until a
 *    human dispatches stable — alarming on it alarms on the designed gate),
 *  - the exact-title dedup and its fail-closed grep status (issues
 *    #2211–#2410: 664 open false positives).
 */

const ROOT = join(import.meta.dir, '..');
const WORKFLOW_PATH = join(ROOT, '.github/workflows/release-orphan-alert.yml');
const workflow = readFileSync(WORKFLOW_PATH, 'utf8');

describe('release-orphan-alert workflow', () => {
  test('parses as YAML', () => {
    const parsed = Bun.YAML.parse(workflow) as Record<string, unknown>;
    expect(parsed).toBeTruthy();
    expect((parsed as { name?: string }).name).toBe('Release Orphan Alert');
  });

  describe('auto-closes healed incidents', () => {
    test('lists only OPEN issues carrying the release-incident label', () => {
      expect(workflow).toContain(
        'gh issue list --repo "$REPO" \\\n            --label release-incident --state open --limit 1000',
      );
    });

    test('closes each healed incident', () => {
      expect(workflow).toContain('gh issue close "$INCIDENT_NUMBER" --repo "$REPO"');
    });

    test('comments the Release URL before closing', () => {
      const commentIndex = workflow.indexOf('gh issue comment "$INCIDENT_NUMBER"');
      const closeIndex = workflow.indexOf('gh issue close "$INCIDENT_NUMBER"');
      expect(commentIndex).toBeGreaterThan(-1);
      expect(closeIndex).toBeGreaterThan(commentIndex);
      const commentBody = workflow.slice(commentIndex, closeIndex);
      expect(commentBody).toContain('${RELEASE_URL}');
    });

    test('resolves the Release URL from a releases query that yields tag AND html_url', () => {
      expect(workflow).toContain("[.tag_name, .html_url] | @tsv'");
      expect(workflow).toContain('-v tag="$INCIDENT_TAG"');
    });

    test('the Release-URL lookup is a herestring, never a pipeline into an exiting awk', () => {
      // `printf … | awk '… exit'` dies with 141 under `pipefail` as soon as
      // the releases TSV outgrows one 64 KiB pipe buffer, which would take
      // the whole step — close pass AND orphan loop — down on every fire.
      expect(workflow).toContain(
        'RELEASE_URL=$(awk -F\'\\t\' -v tag="$INCIDENT_TAG" \'$1 == tag { print $2; exit }\' <<<"$RELEASES_TSV")',
      );
      for (const line of workflow.split('\n')) {
        if (/^\s*#/.test(line)) continue;
        if (!line.includes('awk') && !line.includes('cut -f1')) continue;
        expect(line).not.toMatch(/\|\s*(awk|cut)/);
        expect(line).not.toMatch(/printf[^|]*\|/);
      }
    });

    test('drafts are not Releases — neither for closing nor for the has-release check', () => {
      // release-publish.yml creates every release as a draft and admits the
      // interrupted-publish case where only a draft exists; a draft must not
      // heal an incident, because the --state all dedup never refiles it.
      expect(workflow).toContain('select(.draft == false)');
      const jqLine = workflow.split('\n').find((line) => line.includes('[.tag_name, .html_url] | @tsv'));
      expect(jqLine).toContain('select(.draft == false)');
      // RELEASE_TAGS (the orphan loop's has-release set) is derived from the
      // same draft-filtered rows, so both directions agree.
      expect(workflow).toContain('RELEASE_TAGS=$(cut -f1 <<<"$RELEASES_TSV"');
    });

    test('the jq program actually drops a draft release', () => {
      const jq = Bun.which('jq');
      if (!jq) return; // jq is present in CI and in every workflow runner.
      const program = workflow
        .split('\n')
        .find((line) => line.includes('[.tag_name, .html_url] | @tsv'))
        ?.trim()
        .replace(/^--jq '/, '')
        .replace(/'\)$/, '');
      expect(program).toBeTruthy();
      const releases = JSON.stringify([
        { tag_name: 'v5.260919.1', html_url: 'https://example.com/published', draft: false },
        { tag_name: 'v5.260919.2', html_url: 'https://example.com/draft', draft: true },
      ]);
      const result = Bun.spawnSync(['jq', '-r', program as string], { stdin: Buffer.from(releases) });
      expect(result.exitCode).toBe(0);
      const rows = new TextDecoder().decode(result.stdout).trim().split('\n');
      expect(rows).toEqual(['v5.260919.1\thttps://example.com/published']);
    });

    test('auto-closes an issue at most once, so a deliberate reopen stands', () => {
      // The receipt is a LABEL, read from the listing already fetched.
      expect(workflow).toContain('RESOLVED_LABEL=release-auto-resolved');
      expect(workflow).toContain('gh label create "$RESOLVED_LABEL" --repo "$REPO" --force');
      expect(workflow).toContain('--json number,title,labels');
      expect(workflow).toContain('[.number, .title, ([.labels[].name] | join(","))] | @tsv\'');
      expect(workflow).toContain('read -r INCIDENT_NUMBER INCIDENT_TITLE INCIDENT_LABELS');
      const guardIndex = workflow.indexOf('if [[ ",${INCIDENT_LABELS}," == *",${RESOLVED_LABEL},"* ]]; then');
      const commentIndex = workflow.indexOf('gh issue comment "$INCIDENT_NUMBER"');
      expect(guardIndex).toBeGreaterThan(-1);
      expect(commentIndex).toBeGreaterThan(guardIndex);
      expect(workflow.slice(guardIndex, commentIndex)).toContain('continue');
      // No per-incident lookup, and no comment-derived receipt.
      expect(workflow).not.toContain('gh issue view');
      expect(workflow).not.toContain('RESOLUTION_PREFIX');
    });

    test('the receipt label is written AFTER the close, so a failed close strands nothing', () => {
      // Comment (evidence) → close (the outcome) → label (the receipt). A
      // close that fails after the comment landed must leave NO receipt, so
      // the next fire retries instead of reading its own comment as "already
      // auto-resolved" and skipping the issue forever.
      const commentIndex = workflow.indexOf('gh issue comment "$INCIDENT_NUMBER"');
      const closeIndex = workflow.indexOf('gh issue close "$INCIDENT_NUMBER"');
      const labelIndex = workflow.indexOf(
        'gh issue edit "$INCIDENT_NUMBER" --repo "$REPO" --add-label "$RESOLVED_LABEL"',
      );
      expect(commentIndex).toBeGreaterThan(-1);
      expect(closeIndex).toBeGreaterThan(commentIndex);
      expect(labelIndex).toBeGreaterThan(closeIndex);
    });

    test('the close pass is bounded per fire so a backlog drain cannot burn the write budget', () => {
      const incrementIndex = workflow.indexOf('CLOSED_COUNT=$((CLOSED_COUNT + 1))');
      const breakGuardIndex = workflow.indexOf('if [[ "$CLOSED_COUNT" -ge 50 ]]; then');
      expect(incrementIndex).toBeGreaterThan(-1);
      expect(breakGuardIndex).toBeGreaterThan(incrementIndex);
      const loopEnd = workflow.indexOf('done <<<"$OPEN_INCIDENTS"');
      expect(loopEnd).toBeGreaterThan(breakGuardIndex);
      expect(workflow.slice(breakGuardIndex, loopEnd)).toContain('break');
    });

    test('the open-incident listing is not truncated at 100', () => {
      // 664 release-incident issues were open at once in the #2211–#2410 era.
      expect(workflow).toContain('--label release-incident --state open --limit 1000');
    });

    test('every gh call inside the read loop is detached from the loop stdin', () => {
      const loopStart = workflow.indexOf("while IFS=$'\\t' read -r INCIDENT_NUMBER");
      const loopEnd = workflow.indexOf('done <<<"$OPEN_INCIDENTS"');
      expect(loopStart).toBeGreaterThan(-1);
      expect(loopEnd).toBeGreaterThan(loopStart);
      const body = workflow.slice(loopStart, loopEnd);
      // Join backslash continuations so each gh call is one logical line.
      const logicalLines = body.replace(/\\\n\s*/g, ' ').split('\n');
      const ghInvocations = logicalLines.filter((line) => !/^\s*#/.test(line) && /(^|\s|\()gh /.test(line));
      expect(ghInvocations.length).toBe(3);
      for (const invocation of ghInvocations) {
        expect(invocation).toContain('</dev/null');
      }
    });

    test('runs before the orphan loop short-circuits on zero orphans', () => {
      const closeIndex = workflow.indexOf('gh issue close "$INCIDENT_NUMBER"');
      const earlyExitIndex = workflow.indexOf('no orphan tags detected');
      expect(closeIndex).toBeGreaterThan(-1);
      expect(earlyExitIndex).toBeGreaterThan(closeIndex);
    });

    test('the new listing fails loud — no swallowed API error', () => {
      expect(workflow).toContain('set -euo pipefail');
      const listingIndex = workflow.indexOf('OPEN_INCIDENTS=$(gh issue list');
      expect(listingIndex).toBeGreaterThan(-1);
      const listing = workflow.slice(listingIndex, workflow.indexOf('CLOSED_COUNT=0'));
      expect(listing).not.toContain('|| true');
      expect(listing).not.toContain('|| echo');
      expect(listing).not.toContain('2>/dev/null');
      // No `gh` call anywhere in the workflow suppresses its own failure.
      for (const line of workflow.split('\n')) {
        if (/^\s*#/.test(line) || !line.includes('gh ')) continue;
        expect(line).not.toContain('|| true');
      }
    });
  });

  describe('promotion tags never become incidents', () => {
    test('skips a tag whose commit is not the [auto-version] version child', () => {
      expect(workflow).toContain('TAG_SUBJECT=$(git log -1 --format=%s "$TAG"');
      expect(workflow).toContain('[[ "$TAG_SUBJECT" != "chore(version): bump to ${TAG#v} [auto-version]" ]]');
    });

    test('the predicate guards gh issue create (the skip precedes it and continues)', () => {
      const predicateIndex = workflow.indexOf('TAG_SUBJECT=$(git log -1');
      const createIndex = workflow.indexOf('gh issue create');
      expect(predicateIndex).toBeGreaterThan(-1);
      expect(createIndex).toBeGreaterThan(predicateIndex);
      const guard = workflow.slice(predicateIndex, workflow.indexOf('ORPHANS+=("$TAG")'));
      expect(guard).toContain('continue');
    });

    test('the skip is an annotation, and an unreadable subject is a warning, not a skip verdict', () => {
      expect(workflow).toContain(
        'echo "::notice::skipping promotion tag ${TAG} (awaits a human stable dispatch, not an orphan)"',
      );
      const emptyGuardIndex = workflow.indexOf('if [[ -z "$TAG_SUBJECT" ]]; then');
      const predicateIndex = workflow.indexOf('[[ "$TAG_SUBJECT" != "chore(version)');
      expect(emptyGuardIndex).toBeGreaterThan(-1);
      expect(predicateIndex).toBeGreaterThan(emptyGuardIndex);
      const emptyGuard = workflow.slice(emptyGuardIndex, predicateIndex);
      expect(emptyGuard).toContain('::warning::could not read the commit subject');
      expect(emptyGuard).toContain('continue');
    });

    test('a comment adjacent to the predicate names both of version.yml mint paths', () => {
      const predicateIndex = workflow.indexOf('TAG_SUBJECT=$(git log -1');
      const context = workflow.slice(Math.max(0, predicateIndex - 2000), predicateIndex);
      expect(context).toContain('version.yml mints');
      expect(context).toContain('[auto-version]');
      expect(context).toContain('push --atomic');
      expect(context).toContain('channel=stable');
      expect(context).toContain('release_ready=false');
    });
  });

  describe('pre-existing guarantees stay intact', () => {
    test('exact-title dedup across ALL states', () => {
      expect(workflow).toContain(
        'gh issue list --repo "$REPO" --state all --limit 100 \\\n              --search "\\"$TITLE\\" in:title" --json title --jq \'.[].title\'',
      );
      expect(workflow).toContain('grep -Fxq "$TITLE" <<<"$KNOWN_TITLES" || MATCH_STATUS=$?');
    });

    test('only grep status 1 means not-found; anything else aborts', () => {
      expect(workflow).toContain('elif [[ "$MATCH_STATUS" -ne 1 ]]; then');
      expect(workflow).toContain('exit "$MATCH_STATUS"');
    });

    test('the [30min, 24h] age window constants are unchanged', () => {
      expect(workflow).toContain('AGE_MIN_S=$((30 * 60))          # grace period: alert only after 30 min');
      expect(workflow).toContain('AGE_MAX_S=$((24 * 60 * 60))     # lookback window: ignore tags older than 24h');
    });

    test('permissions stay contents: read + issues: write, with no release or tag mutation', () => {
      const parsed = Bun.YAML.parse(workflow) as { permissions?: Record<string, string> };
      expect(parsed.permissions).toEqual({ contents: 'read', issues: 'write' });
      // Comment lines are prose about other workflows (version.yml pushes
      // tags; this one must not), so only executable lines are searched.
      const executable = workflow
        .split('\n')
        .filter((line) => !/^\s*#/.test(line))
        .join('\n');
      // `git tag --list` is a read and stays; only the mutating forms are banned.
      for (const verb of [
        'gh release create',
        'gh release edit',
        'gh release delete',
        'git push',
        'git tag -d',
        'git tag -f',
        'git tag "',
      ]) {
        expect(executable).not.toContain(verb);
      }
    });

    test('every action is SHA-pinned with a version comment', () => {
      const uses = [...workflow.matchAll(/uses: (\S+)(.*)$/gm)];
      expect(uses.length).toBeGreaterThan(0);
      for (const [, ref, trailer] of uses) {
        expect(ref).toMatch(/@[0-9a-f]{40}$/);
        expect(trailer).toMatch(/#\s*v\d/);
      }
    });
  });
});
