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
        'gh issue list --repo "$REPO" \\\n            --label release-incident --state open --limit 100',
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
      expect(workflow).toContain("--jq '.[] | [.tag_name, .html_url] | @tsv'");
      expect(workflow).toContain('-v tag="$INCIDENT_TAG"');
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
