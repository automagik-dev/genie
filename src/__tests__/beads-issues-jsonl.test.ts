import { mkdtemp, writeFile, readFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, test, expect } from 'bun:test';

import { ensureBeadsIssuesPath, upsertBeadsIssueJsonl } from '../lib/beads-issues-jsonl.js';

describe('beads-issues-jsonl', () => {
  test('upsert is idempotent and preserves created_at', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'genie-cli-beads-'));
    const issuesPath = await ensureBeadsIssuesPath(dir);

    const r1 = await upsertBeadsIssueJsonl(issuesPath, {
      id: 'my-wish',
      title: 'My Wish',
      status: 'open',
      source_repo: 'git:file:/tmp/repo',
      wish_slug: 'my-wish',
      depends_on: ['hq-roadmap'],
    });

    // update title, ensure created_at preserved and only one line exists
    const r2 = await upsertBeadsIssueJsonl(issuesPath, {
      id: 'my-wish',
      title: 'My Wish (updated)',
      status: 'open',
      source_repo: 'git:file:/tmp/repo',
      wish_slug: 'my-wish',
      depends_on: ['hq-roadmap'],
    });

    expect(r2.created_at).toBe(r1.created_at);
    expect(r2.updated_at).not.toBe(r1.updated_at);

    const content = await readFile(issuesPath, 'utf-8');
    const lines = content.split('\n').filter(l => l.trim());
    expect(lines.length).toBe(1);

    const parsed = JSON.parse(lines[0]);
    expect(parsed.id).toBe('my-wish');
    expect(parsed.title).toBe('My Wish (updated)');
  });

  test('preserves malformed lines', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'genie-cli-beads-'));
    const issuesPath = await ensureBeadsIssuesPath(dir);

    await writeFile(issuesPath, '{not json}\n', 'utf-8');

    await upsertBeadsIssueJsonl(issuesPath, {
      id: 'a',
      title: 'A',
      status: 'open',
      source_repo: 'git:file:/tmp/repo',
      wish_slug: 'a',
      depends_on: ['hq-roadmap'],
    });

    const content = await readFile(issuesPath, 'utf-8');
    expect(content).toContain('{not json}');
    expect(content).toContain('"id":"a"');
  });
});
