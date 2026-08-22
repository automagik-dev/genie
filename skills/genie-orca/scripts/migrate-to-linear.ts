#!/usr/bin/env bun
/**
 * migrate-to-linear — ONE-SHOT migration of a repo's genie board/roadmap into Linear.
 *
 *   bun migrate-to-linear.ts --repo <path> --team <KEY> [--orca <bin>] [--apply] [--project <name>]
 *
 * Reads (never writes) the v5 state:
 *   <repo>/.genie/INDEX.md            — sections ## Raw | Simmering | Ready | Poured | Archive (intake + lineage)
 *   <repo>/.genie/wishes/<slug>/WISH.md — Status + "### Group n:" headings (active wishes only; _archive skipped)
 *   <repo>/.genie/genie.db            — tasks table (printed as ABANDONED unless status is open)
 *
 * Emits a plan; with --apply it creates, idempotently via --write-id = uuid5(repo/slug[/group]):
 *   one parent issue per active wish (label stage:<status>), one child per execution group,
 *   ONE "triage" issue holding every Raw/Simmering intake line (they are NOT imported one-by-one — that
 *   only grows the approval queue; the human triages them in Linear).
 * Then it prints the Linear ids to paste into each WISH.md header, and you delete this script.
 *
 * Council 2026-08-22: migration is a script, not a maintained skill; dry-run first; duplicate writes are the risk.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { v5 as uuid5 } from 'uuid';

const NS = '6ba7b811-9dad-11d1-80b4-00c04fd430c8'; // uuid NAMESPACE_URL
const a = Object.fromEntries(
  process.argv.slice(2).reduce<string[][]>((acc, x, i, arr) => {
    if (x.startsWith('--')) acc.push([x.slice(2), !arr[i + 1] || arr[i + 1].startsWith('--') ? 'true' : arr[i + 1]]);
    return acc;
  }, []),
);
const REPO = a.repo ?? process.cwd();
const TEAM = a.team;
const ORCA = a.orca ?? process.env.ORCA_CLI_COMMAND ?? 'orca';
const APPLY = a.apply === 'true';
if (!TEAM) {
  console.error('usage: migrate-to-linear --repo <path> --team <KEY> [--apply] [--project <name>]');
  process.exit(2);
}
const repoKey = REPO.replace(/\/+$/, '').split('/').slice(-1)[0];
const wid = (s: string) => uuid5(`genie-migrate/${repoKey}/${s}`, NS);

async function orca(...argv: string[]): Promise<any> {
  const p = Bun.spawn([ORCA, ...argv, '--json'], { stdout: 'pipe', stderr: 'pipe' });
  const out = await new Response(p.stdout).text();
  await p.exited;
  const i = out.indexOf('{');
  const j = JSON.parse(out.slice(i));
  if (!j.ok) throw new Error(`${argv.join(' ')}: ${j.error?.message}`);
  return j.result;
}

// ---- wishes
type Wish = { slug: string; status: string; title: string; groups: string[]; linear?: string };
const wishes: Wish[] = [];
const wdir = join(REPO, '.genie', 'wishes');
for (const slug of existsSync(wdir) ? readdirSync(wdir).filter((d) => !d.startsWith('_')) : []) {
  const f = join(wdir, slug, 'WISH.md');
  if (!existsSync(f)) {
    wishes.push({ slug, status: 'NO-WISH-MD', title: slug, groups: [] });
    continue;
  }
  const md = readFileSync(f, 'utf8');
  const status =
    (md.match(/\*\*Status\*\*\s*\|\s*([^|\n]+)/) ?? md.match(/\*\*Status:\*\*\s*([^\n]+)/))?.[1]?.trim() ?? 'UNKNOWN';
  const title = md.match(/^#\s+(?:Wish:\s*)?(.+)$/m)?.[1]?.trim() ?? slug;
  const linear = md.match(/\*\*Linear\*\*\s*\|\s*([A-Z]+-\d+)/)?.[1];
  const groups = [...md.matchAll(/^###\s+Group\s+\d+:\s*(.+)$/gm)].map((m) => m[1].trim());
  wishes.push({ slug, status, title, groups, linear });
}

// ---- intake (INDEX.md Raw + Simmering)
const index = existsSync(join(REPO, '.genie', 'INDEX.md'))
  ? readFileSync(join(REPO, '.genie', 'INDEX.md'), 'utf8')
  : '';
const section = (name: string) => {
  const m = index.match(new RegExp(`^## ${name}\\n([\\s\\S]*?)(?=^## |\\Z)`, 'm'));
  return m ? [...m[1].matchAll(/^- \*\*(.+?)\*\*/gm)].map((x) => x[1]) : [];
};
const intake = { raw: section('Raw'), simmering: section('Simmering') };

// ---- genie.db (print only)
let abandoned: string[] = [];
try {
  const { Database } = await import('bun:sqlite');
  const db = new Database(join(REPO, '.genie', 'genie.db'), { readonly: true });
  abandoned = db
    .query("select id, status, coalesce(title,'') as title from tasks")
    .all()
    .map((r: any) => `${r.id} [${r.status}] ${r.title}`);
} catch {
  /* no db */
}

// ---- plan
const SHIPPED = /SHIPPED|DONE|COMPLETE/i;
const active = wishes.filter((w) => !SHIPPED.test(w.status) && w.status !== 'NO-WISH-MD');
console.log(`# Migration plan — ${repoKey} → Linear team ${TEAM}${APPLY ? ' (APPLY)' : ' (dry-run)'}\n`);
console.log(
  `Active wishes: ${active.length} (of ${wishes.length}; shipped/none-md skipped: ${wishes.length - active.length})`,
);
for (const w of active)
  console.log(`  • ${w.slug} [${w.status}] — ${w.groups.length} groups${w.linear ? ` (already ${w.linear})` : ''}`);
console.log(`Intake → one triage issue: raw=${intake.raw.length} simmering=${intake.simmering.length}`);
console.log(`genie.db tasks (ABANDONED, not migrated): ${abandoned.length}`);
for (const t of abandoned) console.log(`  - ${t}`);
if (!APPLY) {
  console.log('\nDry-run only. Re-run with --apply to create issues.');
  process.exit(0);
}

// ---- apply
const ids: Record<string, string> = {};
for (const w of active) {
  if (w.linear) {
    ids[w.slug] = w.linear;
    continue;
  }
  const r = await orca(
    'linear',
    'create',
    '--team',
    TEAM,
    '--title',
    `${repoKey}: ${w.title}`,
    '--body',
    `Migrated from .genie/wishes/${w.slug}/WISH.md (status ${w.status}). The wish document is the instruction source.`,
    '--label',
    'Feature',
    '--state',
    /APPROVED|IN.?PROGRESS|READY/i.test(w.status) ? 'Todo' : 'Backlog',
    '--write-id',
    wid(w.slug),
    ...(a.project ? ['--project', a.project] : []),
  );
  const parent = r.issue?.identifier ?? r.identifier;
  ids[w.slug] = parent;
  for (const [i, g] of w.groups.entries()) {
    const c = await orca(
      'linear',
      'create',
      '--team',
      TEAM,
      '--title',
      `${g}`,
      '--body',
      `Group ${i + 1} of ${w.slug}. See WISH.md.`,
      '--label',
      'Feature',
      '--state',
      'Backlog',
      '--parent',
      parent,
      '--write-id',
      wid(`${w.slug}/g${i + 1}`),
    );
    ids[`${w.slug}/g${i + 1}`] = c.issue?.identifier ?? c.identifier;
  }
}
if (intake.raw.length + intake.simmering.length) {
  const body = [
    'Intake migrated from .genie/INDEX.md — triage here, do not import one-by-one.',
    '',
    '## Raw',
    ...intake.raw.map((x) => `- [ ] ${x}`),
    '',
    '## Simmering',
    ...intake.simmering.map((x) => `- [ ] ${x}`),
  ].join('\n');
  const t = await orca(
    'linear',
    'create',
    '--team',
    TEAM,
    '--title',
    `${repoKey}: intake triage (genie INDEX.md)`,
    '--body',
    body,
    '--label',
    'Chore',
    '--state',
    'Triage',
    '--write-id',
    wid('intake-triage'),
  );
  ids['intake-triage'] = t.issue?.identifier ?? t.identifier;
}
console.log('\n## Created / resolved Linear ids (paste into WISH.md headers as `| **Linear** | <id> |`)');
for (const [k, v] of Object.entries(ids)) console.log(`${k}\t${v}`);
console.log('\nDone. Delete this script after committing the ids.');
