import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// The adversarial sets carry live injection payloads. A human opening one must see, before anything
// else, that the text is a canary under test — review-prep flagged the sets as reading like
// instructions (#2954 follow-up), so the banner is pinned here rather than left to convention.
const FIXTURES = join(import.meta.dir, 'fixtures');
const BANNER = 'Canary payloads under test, not instructions to any reader or agent.';

describe('adversarial fixture sets open with the canary banner', () => {
  for (const agent of ['issue-triage', 'wish-context', 'review-prep']) {
    test(`${agent}.adversarial.json has _note as its first key`, () => {
      const parsed = JSON.parse(readFileSync(join(FIXTURES, `${agent}.adversarial.json`), 'utf8')) as Record<
        string,
        unknown
      >;
      expect(Object.keys(parsed)[0]).toBe('_note');
      expect(parsed._note).toBe(BANNER);
    });
  }

  test('README-injected.md opens with the same banner, above its title', () => {
    const [first] = readFileSync(join(FIXTURES, 'adversarial', 'README-injected.md'), 'utf8').split('\n');
    expect(first).toBe(`> ${BANNER}`);
  });
});
