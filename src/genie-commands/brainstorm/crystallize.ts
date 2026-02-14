import { readFile } from 'fs/promises';
import { basename, dirname, join, resolve } from 'path';
import { crystallizeBrainstormAndUpsertBeads } from '../../term-commands/brainstorm-beads.js';

export interface BrainstormCrystallizeOptions {
  slug: string;
  file?: string;
  repo?: string;
  title?: string;
  dependsOn?: string;
  status?: 'open' | 'closed';
}

function slugFromPath(p: string): string | null {
  // .genie/brainstorms/<slug>/draft.md
  const m = p.replace(/\\/g, '/').match(/\.genie\/brainstorms\/([^/]+)\//);
  return m?.[1] ?? null;
}

export async function brainstormCrystallizeCommand(options: BrainstormCrystallizeOptions): Promise<void> {
  const repoPath = resolve(options.repo || process.cwd());

  const slug = options.slug;
  if (!slug) {
    console.error('❌ Missing required: --slug <slug>');
    process.exit(1);
  }

  const defaultDraft = join(repoPath, '.genie', 'brainstorms', slug, 'draft.md');
  const draftPath = resolve(repoPath, options.file ?? defaultDraft);

  let draft: string;
  try {
    draft = await readFile(draftPath, 'utf-8');
  } catch {
    console.error(`❌ Could not read draft file: ${draftPath}`);
    process.exit(1);
  }

  const title = options.title || slug;
  const dependsOn = options.dependsOn
    ? options.dependsOn.split(',').map(s => s.trim()).filter(Boolean)
    : undefined;

  const { designPath, beadsPath } = await crystallizeBrainstormAndUpsertBeads({
    repoPath,
    slug,
    title,
    designMarkdown: draft,
    status: options.status,
    dependsOn,
  });

  // Basic guardrails / helpful output
  if (basename(draftPath) !== 'draft.md' && !options.title) {
    const inferred = slugFromPath(draftPath);
    if (inferred && inferred !== slug) {
      console.error(`ℹ️  Note: slug inferred from file path would be "${inferred}" (you passed --slug ${slug})`);
    }
  }

  console.log(designPath);
  console.log(beadsPath);
}
