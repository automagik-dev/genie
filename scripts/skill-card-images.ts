/**
 * Skill card images: one SVG card per skill, built from `skills/<name>/agents/openai.yaml`.
 *
 * A development tool run by hand (design: `.genie/brainstorms/skill-cards/DESIGN.md`). Nothing in
 * genie's runtime, the release workflows or CI renders a card; `scripts/skill-card-images.test.ts`
 * reads the cards as text.
 *
 *   bun scripts/skill-card-images.ts                   the six README cards, .github/assets/skill-<name>.svg
 *   bun scripts/skill-card-images.ts --docs            every shipped skill's card, docs/images/skills/<name>.svg
 *   bun scripts/skill-card-images.ts [--docs] --check  compare in memory with the files on disk, write nothing
 *
 * Exit codes: 0 ok, 1 a refusal or a card that differs, 2 usage.
 *
 * A card is self-contained. The fonts and the logo ride inside it as `data:` URIs, because GitHub and
 * Mintlify show an SVG through `<img>`, which fetches nothing external. The title, the line and the two
 * commands stay `<text>` nodes, never outlines, and every YAML value is XML-escaped before it enters
 * the SVG. The script measures no glyphs, so it counts characters and refuses what may not fit.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

export const CORE_SKILLS = ['brainstorm', 'wish', 'work', 'review', 'council', 'fix'] as const;

/** A refusal: a value the card cannot hold, or a target the write cannot use. The CLI exits 1. */
export class SkillCardError extends Error {}

export interface SkillCardText {
  name: string;
  title: string;
  lines: string[];
  slash: string;
  dollar: string;
}

const TITLE_MAX = 24;
const LINE_MAX = 34;
const DESCRIPTION_MAX = 68;
const SKILL_NAME = /^[a-z0-9][a-z0-9-]*$/;
// `/name` and `$name` share one row at 18 px a character (30 px JetBrains Mono): a 12-character name ends
// the row at x 560, clear of the logo's drawn mark at about x 583. A longer name would run into it.
const NAME_MAX = 12;

// Design B ("balanced neon") tokens, copied from GENIE-DESIGN-TOKENS.md. That file is gitignored beside
// the genie-launch design (.genie/brainstorms/genie-launch/), so a fresh clone does not have it.
const SURFACE = '#0B0B12';
const BORDER = '#2A2438';
const TEXT = '#E8E6F0';
const MAGENTA = '#FF3FF5';
const CYAN = '#5EF2FF';

// The design B face first, then named system faces, then the generic family: a platform that does not
// draw the embedded fonts still draws the text, in a system face (design Decision 20).
const SANS_STACK = "Geist, system-ui, -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif";
const MONO_STACK = "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

// Layout on the 800x400 canvas: a 56 px margin, the title and the line top left, the two commands
// bottom left, the logo as a small mark bottom right. Baselines in px.
const WIDTH = 800;
const HEIGHT = 400;
const MARGIN = 56;
const TITLE_Y = 120;
const LINE_Y = 184;
const LINE_STEP = 42;
const COMMAND_Y = 336;
// JetBrains Mono advances 0.6 em per character; `$name` starts two advances after `/name` ends.
const MONO_ADVANCE = 0.6;
const COMMAND_GAP = 2;
// The logo PNG is 1000x500 with transparent padding; at 200x100 its drawn mark spans about 170x50.
const LOGO = { x: 572, y: 276, width: 200, height: 100 };

interface TextStyle {
  fill: string;
  family: string;
  size: number;
  weight: number;
  glow: boolean;
}

const TITLE_STYLE: TextStyle = { fill: TEXT, family: SANS_STACK, size: 52, weight: 800, glow: false };
const LINE_STYLE: TextStyle = { fill: TEXT, family: SANS_STACK, size: 30, weight: 400, glow: false };
// The glow sits on the two accent commands only (design B: glow on accents only).
const SLASH_STYLE: TextStyle = { fill: MAGENTA, family: MONO_STACK, size: 30, weight: 600, glow: true };
const DOLLAR_STYLE: TextStyle = { fill: CYAN, family: MONO_STACK, size: 30, weight: 600, glow: true };

const ASSET_DIR = join('scripts', 'skill-card-images');
const USAGE = [
  'usage: bun scripts/skill-card-images.ts [--docs] [--check]',
  '  (no flag)  write the six README cards to .github/assets/skill-<name>.svg',
  "  --docs     write every shipped skill's card to docs/images/skills/<name>.svg",
  '  --check    compare the cards in memory with the files on disk; write nothing',
].join('\n');

const XML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };

function escapeXml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => XML_ESCAPES[char] ?? char);
}

/**
 * One line, or two split at the space that makes the longer line shortest (a tie goes to the earlier
 * space). Greedy wrapping would leave one word alone on the second line of most cards.
 */
export function wrapLine(text: string): string[] {
  if (text.length > DESCRIPTION_MAX) {
    throw new SkillCardError(`line is ${text.length} characters; a card holds at most ${DESCRIPTION_MAX}`);
  }
  if (text.length <= LINE_MAX) return [text];
  let best: string[] | undefined;
  for (let at = text.indexOf(' '); at !== -1; at = text.indexOf(' ', at + 1)) {
    const first = text.slice(0, at);
    const second = text.slice(at + 1);
    const longer = Math.max(first.length, second.length);
    if (first === '' || second === '' || longer > LINE_MAX) continue;
    if (best === undefined || longer < Math.max(best[0].length, best[1].length)) best = [first, second];
  }
  if (best === undefined) {
    throw new SkillCardError(`line does not wrap at a space into at most two lines of ${LINE_MAX} characters`);
  }
  return best;
}

function cardValue(source: string, field: string, value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new SkillCardError(`${source}: interface.${field} is missing or empty`);
  }
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code < 0x20 || code === 0x7f) {
      throw new SkillCardError(`${source}: interface.${field} holds a control character; a card value is one line`);
    }
  }
  return value;
}

export function readSkillCardText(root: string, name: string): SkillCardText {
  if (!SKILL_NAME.test(name)) {
    throw new SkillCardError(`"${name}" is not a skill name (lowercase letters, digits and hyphens)`);
  }
  if (name.length > NAME_MAX) {
    throw new SkillCardError(
      `skill name "${name}" is ${name.length} characters; a card's command row holds ${NAME_MAX}`,
    );
  }
  const source = `skills/${name}/agents/openai.yaml`;
  let parsed: unknown;
  try {
    parsed = Bun.YAML.parse(readFileSync(join(root, source), 'utf8'));
  } catch (error) {
    throw new SkillCardError(`cannot read ${source}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const fields = (parsed as { interface?: Record<string, unknown> } | null)?.interface;
  const title = cardValue(source, 'display_name', fields?.display_name);
  const line = cardValue(source, 'short_description', fields?.short_description);
  if (title.length > TITLE_MAX) {
    throw new SkillCardError(
      `${source}: interface.display_name is ${title.length} characters; a card title holds at most ${TITLE_MAX}`,
    );
  }
  let lines: string[];
  try {
    lines = wrapLine(line);
  } catch (error) {
    throw new SkillCardError(`${source}: interface.short_description: ${(error as Error).message}`);
  }
  return { name, title, lines, slash: `/${name}`, dollar: `$${name}` };
}

function assetDataUri(root: string, file: string, mime: string): string {
  const path = join(ASSET_DIR, file);
  try {
    return `data:${mime};base64,${readFileSync(join(root, path)).toString('base64')}`;
  } catch {
    throw new SkillCardError(`cannot read ${path}`);
  }
}

function textNode(x: number, y: number, style: TextStyle, text: string): string {
  const glow = style.glow ? ' filter="url(#glow)"' : '';
  return `  <text x="${x}" y="${y}" fill="${style.fill}" font-family="${style.family}" font-size="${style.size}" font-weight="${style.weight}"${glow}>${escapeXml(text)}</text>`;
}

/** The card's full SVG text: pure over the tree it reads, byte-stable, one trailing newline. */
export function renderSkillCard(root: string, name: string): string {
  const card = readSkillCardText(root, name);
  const geist = assetDataUri(root, 'fonts/geist-latin.woff2', 'font/woff2');
  const mono = assetDataUri(root, 'fonts/jetbrains-mono-latin.woff2', 'font/woff2');
  const logo = assetDataUri(root, 'genie-logo.png', 'image/png');
  const dollarX = MARGIN + Math.round((card.slash.length + COMMAND_GAP) * DOLLAR_STYLE.size * MONO_ADVANCE);
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">`,
    '  <defs>',
    '    <style>',
    `      @font-face{font-family:'Geist';font-style:normal;font-weight:100 900;src:url(${geist}) format('woff2')}`,
    `      @font-face{font-family:'JetBrains Mono';font-style:normal;font-weight:100 800;src:url(${mono}) format('woff2')}`,
    '    </style>',
    // The design B bloom, scaled to the card: a wide blur, a tight blur, then the crisp text on top.
    `    <filter id="glow" filterUnits="userSpaceOnUse" x="0" y="0" width="${WIDTH}" height="${HEIGHT}">`,
    '      <feGaussianBlur in="SourceGraphic" stdDeviation="7" result="wide"/>',
    '      <feGaussianBlur in="SourceGraphic" stdDeviation="2" result="tight"/>',
    '      <feMerge>',
    '        <feMergeNode in="wide"/>',
    '        <feMergeNode in="tight"/>',
    '        <feMergeNode in="SourceGraphic"/>',
    '      </feMerge>',
    '    </filter>',
    '  </defs>',
    `  <rect x="1" y="1" width="${WIDTH - 2}" height="${HEIGHT - 2}" rx="24" fill="${SURFACE}" stroke="${BORDER}" stroke-width="2"/>`,
    textNode(MARGIN, TITLE_Y, TITLE_STYLE, card.title),
    ...card.lines.map((line, index) => textNode(MARGIN, LINE_Y + index * LINE_STEP, LINE_STYLE, line)),
    textNode(MARGIN, COMMAND_Y, SLASH_STYLE, card.slash),
    textNode(dollarX, COMMAND_Y, DOLLAR_STYLE, card.dollar),
    `  <image x="${LOGO.x}" y="${LOGO.y}" width="${LOGO.width}" height="${LOGO.height}" href="${logo}"/>`,
    '</svg>',
    '',
  ].join('\n');
}

export function readmeCardPath(root: string, name: string): string {
  return join(root, '.github', 'assets', `skill-${name}.svg`);
}

export function docsCardPath(root: string, name: string): string {
  return join(root, 'docs', 'images', 'skills', `${name}.svg`);
}

/** Every `skills/*\/` directory holding a `SKILL.md`, sorted: the shipped skills. */
export function docsSkillNames(root: string): string[] {
  const skillsDir = join(root, 'skills');
  if (!existsSync(skillsDir)) throw new SkillCardError(`cannot list skills/ under ${root}`);
  return readdirSync(skillsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(skillsDir, entry.name, 'SKILL.md')))
    .map((entry) => entry.name)
    .sort();
}

function requireDocsDir(root: string): void {
  let isDirectory = false;
  try {
    isDirectory = statSync(join(root, 'docs')).isDirectory();
  } catch {
    isDirectory = false;
  }
  if (!isDirectory) {
    throw new SkillCardError(
      'docs/ does not resolve to a directory (is the .docs-vendor submodule initialized? ' +
        'git submodule update --init .docs-vendor); nothing was written',
    );
  }
}

function renderCards(root: string, docs: boolean): { path: string; svg: string }[] {
  if (docs) requireDocsDir(root);
  const names: readonly string[] = docs ? docsSkillNames(root) : CORE_SKILLS;
  const cardPath = docs ? docsCardPath : readmeCardPath;
  return names.map((name) => ({ path: cardPath(root, name), svg: renderSkillCard(root, name) }));
}

/** Renders every card first and writes only when all rendered. Returns the written paths. */
export function writeSkillCards(root: string, opts: { docs?: boolean } = {}): string[] {
  const cards = renderCards(root, opts.docs === true);
  for (const card of cards) {
    mkdirSync(dirname(card.path), { recursive: true });
    writeFileSync(card.path, card.svg);
  }
  return cards.map((card) => card.path);
}

function sameBytes(path: string, svg: string): boolean {
  try {
    return readFileSync(path).equals(Buffer.from(svg, 'utf8'));
  } catch {
    return false;
  }
}

/** Compares what the same flags would write with the files on disk. Writes nothing. */
export function checkSkillCards(root: string, opts: { docs?: boolean } = {}): { ok: boolean; differing: string[] } {
  const differing = renderCards(root, opts.docs === true)
    .filter((card) => !sameBytes(card.path, card.svg))
    .map((card) => card.path);
  return { ok: differing.length === 0, differing };
}

export async function main(argv: string[], root: string = resolve(import.meta.dir, '..')): Promise<number> {
  let docs = false;
  let check = false;
  for (const arg of argv) {
    if (arg === '--docs') docs = true;
    else if (arg === '--check') check = true;
    else if (arg === '--help' || arg === '-h') {
      console.log(USAGE);
      return 0;
    } else {
      console.error(`skill-card-images: unknown argument ${arg}\n${USAGE}`);
      return 2;
    }
  }
  try {
    if (check) {
      const { ok, differing } = checkSkillCards(root, { docs });
      if (ok) {
        console.log('skill-card-images: every card matches its skill');
        return 0;
      }
      for (const path of differing) console.error(`skill-card-images: differs: ${relative(root, path)}`);
      console.error(`skill-card-images: regenerate with bun scripts/skill-card-images.ts${docs ? ' --docs' : ''}`);
      return 1;
    }
    for (const path of writeSkillCards(root, { docs })) console.log(`wrote ${relative(root, path)}`);
    return 0;
  } catch (error) {
    if (!(error instanceof SkillCardError)) throw error;
    console.error(`skill-card-images: ${error.message}`);
    return 1;
  }
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
