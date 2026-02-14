/**
 * Brainstorm completion helpers
 *
 * When /brainstorm reaches WRS=100 and writes:
 *   .genie/brainstorms/<slug>/design.md
 * we also upsert a Beads issue record into:
 *   <repo>/.beads/issues.jsonl
 */

import { dirname, join, resolve } from 'path';
import { mkdir, writeFile } from 'fs/promises';
import {
  ensureBeadsIssuesPath,
  getSourceRepo,
  upsertBeadsIssueJsonl,
  type BeadsIssueRecord,
} from '../lib/beads-issues-jsonl.js';

export interface CrystallizeBrainstormOptions {
  repoPath: string;
  slug: string; // kebab-case
  title: string;
  designMarkdown: string;
  status?: 'open' | 'closed';
  dependsOn?: string[];
}

export async function crystallizeBrainstormAndUpsertBeads(
  opts: CrystallizeBrainstormOptions
): Promise<{ designPath: string; beadsPath: string; record: BeadsIssueRecord }> {
  const repoPath = resolve(opts.repoPath);
  const slug = opts.slug;
  const title = opts.title;
  const status = opts.status ?? 'open';

  const depends_on = (opts.dependsOn && opts.dependsOn.length > 0)
    ? opts.dependsOn
    : ['hq-roadmap'];

  const designPath = join(repoPath, '.genie', 'brainstorms', slug, 'design.md');
  await mkdir(dirname(designPath), { recursive: true });
  await writeFile(designPath, opts.designMarkdown, 'utf-8');

  const issuesPath = await ensureBeadsIssuesPath(repoPath);
  const source_repo = await getSourceRepo(repoPath);

  const record = await upsertBeadsIssueJsonl(issuesPath, {
    id: slug,
    title,
    status,
    source_repo,
    wish_slug: slug,
    depends_on,
  });

  return {
    designPath,
    beadsPath: issuesPath,
    record,
  };
}
