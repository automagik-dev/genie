import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CORE_SKILLS,
  SkillCardError,
  checkSkillCards,
  docsCardPath,
  docsSkillNames,
  main,
  readSkillCardText,
  readmeCardPath,
  renderSkillCard,
  wrapLine,
  writeSkillCards,
} from './skill-card-images';

// Every test here runs over a temporary repository root. None writes into the real tree or the docs
// submodule, and none calls `main` without a root, whose default is the real repository.

const REPO = join(import.meta.dir, '..');
const SANS_STACK = "Geist, system-ui, -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif";
const MONO_STACK = "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

let roots: string[] = [];
let stdout: string[] = [];
let stderr: string[] = [];
let restoreConsole: () => void = () => {};

beforeEach(() => {
  stdout = [];
  stderr = [];
  const log = spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    stdout.push(args.join(' '));
  });
  const error = spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    stderr.push(args.join(' '));
  });
  restoreConsole = () => {
    log.mockRestore();
    error.mockRestore();
  };
});

afterEach(() => {
  restoreConsole();
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots = [];
});

/** A fresh root holding only what the generator reads: each skill's YAML and SKILL.md, and the card assets. */
function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'skill-card-images-'));
  roots.push(root);
  for (const name of readdirSync(join(REPO, 'skills'))) {
    const yaml = join(REPO, 'skills', name, 'agents', 'openai.yaml');
    if (!existsSync(yaml)) continue;
    mkdirSync(join(root, 'skills', name, 'agents'), { recursive: true });
    cpSync(yaml, join(root, 'skills', name, 'agents', 'openai.yaml'));
    const skill = join(REPO, 'skills', name, 'SKILL.md');
    if (existsSync(skill)) cpSync(skill, join(root, 'skills', name, 'SKILL.md'));
  }
  cpSync(join(REPO, 'scripts', 'skill-card-images'), join(root, 'scripts', 'skill-card-images'), { recursive: true });
  return root;
}

/** Every entry under the root with its content hash (files) or link target, to prove a call wrote nothing. */
function snapshot(root: string): Record<string, string> {
  const entries: Record<string, string> = {};
  for (const path of readdirSync(root, { recursive: true }) as string[]) {
    const full = join(root, path);
    const stat = lstatSync(full);
    if (stat.isSymbolicLink()) entries[path] = `link:${readlinkSync(full)}`;
    else if (stat.isDirectory()) entries[path] = 'dir';
    else entries[path] = createHash('sha256').update(readFileSync(full)).digest('hex');
  }
  return entries;
}

function readInterface(root: string, name: string): Record<string, string> {
  const yaml = readFileSync(join(root, 'skills', name, 'agents', 'openai.yaml'), 'utf8');
  return (Bun.YAML.parse(yaml) as { interface: Record<string, string> }).interface;
}

/** Rewrites a skill's YAML with some interface fields changed; JSON strings are valid YAML scalars. */
function setInterface(root: string, name: string, change: Record<string, string>): void {
  const fields = { ...readInterface(root, name), ...change };
  const body = Object.entries(fields).map(([key, value]) => `  ${key}: ${JSON.stringify(value)}`);
  writeFileSync(join(root, 'skills', name, 'agents', 'openai.yaml'), `interface:\n${body.join('\n')}\n`);
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/** The card's `<text>` nodes in document order, with their attributes and unescaped content. */
function textNodes(svg: string): { attrs: Record<string, string>; text: string }[] {
  return [...svg.matchAll(/<text\b([^>]*)>([^<]*)<\/text>/g)].map((match) => ({
    attrs: Object.fromEntries([...match[1].matchAll(/([\w-]+)="([^"]*)"/g)].map((attr) => [attr[1], attr[2]])),
    text: match[2].replace(/&(amp|lt|gt|quot|apos);/g, (_, entity: string) => ENTITIES[entity]),
  }));
}

function danglingDocs(root: string): void {
  symlinkSync(join(root, '.docs-vendor', 'genie'), join(root, 'docs'));
}

describe('wrapLine', () => {
  test('keeps a line of up to 34 characters whole', () => {
    expect(wrapLine('Settle an idea')).toEqual(['Settle an idea']);
    const full = `${'a'.repeat(16)} ${'b'.repeat(17)}`;
    expect(full.length).toBe(34);
    expect(wrapLine(full)).toEqual([full]);
  });

  test('splits at the space that makes the longer line shortest, so no card ends on one word', () => {
    expect(wrapLine('Settle an idea into a reviewed design')).toEqual(['Settle an idea into', 'a reviewed design']);
    expect(wrapLine('Execute approved wishes with evidence')).toEqual(['Execute approved', 'wishes with evidence']);
    expect(wrapLine('Repair review gaps with bounded retries')).toEqual(['Repair review gaps', 'with bounded retries']);
  });

  test('a tie goes to the earlier space', () => {
    const left = 'a'.repeat(17);
    const right = 'c'.repeat(17);
    expect(wrapLine(`${left} b ${right}`)).toEqual([left, `b ${right}`]);
  });

  test('wraps 68 characters into two lines and refuses 69, even when 69 would split', () => {
    const fits = `${'a'.repeat(34)} ${'b'.repeat(33)}`;
    expect(fits.length).toBe(68);
    expect(wrapLine(fits)).toEqual(['a'.repeat(34), 'b'.repeat(33)]);
    expect(() => wrapLine(`${fits}b`)).toThrow(SkillCardError);
    expect(() => wrapLine(`${fits}b`)).toThrow('line is 69 characters; a card holds at most 68');
  });

  test('refuses a line that would need three lines', () => {
    const three = `${'a'.repeat(20)} ${'b'.repeat(30)} ${'c'.repeat(12)}`;
    expect(three.length).toBeLessThanOrEqual(68);
    expect(() => wrapLine(three)).toThrow(SkillCardError);
    expect(() => wrapLine(three)).toThrow('does not wrap at a space into at most two lines of 34 characters');
    expect(() => wrapLine('x'.repeat(35))).toThrow(SkillCardError);
  });
});

describe('renderSkillCard', () => {
  test("the six core cards carry each skill's title, line, /name and $name as text nodes", () => {
    const root = tempRoot();
    for (const name of CORE_SKILLS) {
      const fields = readInterface(root, name);
      const texts = textNodes(renderSkillCard(root, name)).map((node) => node.text);
      const lines = texts.slice(1, -2);
      expect(texts[0]).toBe(fields.display_name);
      expect(lines.join(' ')).toBe(fields.short_description);
      expect(lines.length).toBeGreaterThanOrEqual(1);
      expect(lines.length).toBeLessThanOrEqual(2);
      for (const line of lines) expect(line.length).toBeLessThanOrEqual(34);
      expect(texts.slice(-2)).toEqual([`/${name}`, `$${name}`]);
      expect(readSkillCardText(root, name)).toEqual({
        name,
        title: fields.display_name,
        lines,
        slash: `/${name}`,
        dollar: `$${name}`,
      });
    }
  });

  test('is an 800x400 canvas, byte-stable across renders and roots, ending in one newline', () => {
    const root = tempRoot();
    const svg = renderSkillCard(root, 'brainstorm');
    expect(
      svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg" width="800" height="400" viewBox="0 0 800 400">'),
    ).toBe(true);
    expect(renderSkillCard(root, 'brainstorm')).toBe(svg);
    expect(renderSkillCard(tempRoot(), 'brainstorm')).toBe(svg);
    expect(svg.endsWith('</svg>\n')).toBe(true);
    expect(svg.endsWith('\n\n')).toBe(false);
    expect(svg).not.toContain(root);
  });

  test('every text node names the design B face first and a generic family last', () => {
    const root = tempRoot();
    for (const name of CORE_SKILLS) {
      const nodes = textNodes(renderSkillCard(root, name));
      nodes.forEach((node, index) => {
        const command = index >= nodes.length - 2;
        const family = node.attrs['font-family'];
        expect(family).toBe(command ? MONO_STACK : SANS_STACK);
        const faces = family.split(',').map((face) => face.trim().replace(/^'(.*)'$/, '$1'));
        expect(faces[0]).toBe(command ? 'JetBrains Mono' : 'Geist');
        expect(faces[faces.length - 1]).toBe(command ? 'monospace' : 'sans-serif');
      });
    }
  });

  test('draws the design B tokens and puts the glow on the two accent commands only', () => {
    const svg = renderSkillCard(tempRoot(), 'brainstorm');
    expect(svg).toContain('fill="#0B0B12" stroke="#2A2438"');
    expect(svg).toContain('<feGaussianBlur');
    const nodes = textNodes(svg);
    const commands = nodes.slice(-2);
    expect(commands.map((node) => node.attrs.fill)).toEqual(['#FF3FF5', '#5EF2FF']);
    expect(commands.map((node) => node.attrs.filter)).toEqual(['url(#glow)', 'url(#glow)']);
    for (const node of nodes.slice(0, -2)) {
      expect(node.attrs.fill).toBe('#E8E6F0');
      expect(node.attrs.filter).toBeUndefined();
    }
    expect(svg.match(/filter="url\(#glow\)"/g)?.length).toBe(2);
  });

  test('is self-contained: data: URIs only, no @import, no URL but the SVG namespace', () => {
    const root = tempRoot();
    const svg = renderSkillCard(root, 'brainstorm');
    const asset = (file: string) => readFileSync(join(root, 'scripts', 'skill-card-images', file)).toString('base64');
    expect(svg).not.toContain('@import');
    const hrefs = [...svg.matchAll(/\bhref="([^"]*)"/g)].map((match) => match[1]);
    expect(hrefs).toEqual([`data:image/png;base64,${asset('genie-logo.png')}`]);
    const urls = [...svg.matchAll(/url\(([^)]*)\)/g)].map((match) => match[1]).filter((url) => url !== '#glow');
    expect(urls).toEqual([
      `data:font/woff2;base64,${asset('fonts/geist-latin.woff2')}`,
      `data:font/woff2;base64,${asset('fonts/jetbrains-mono-latin.woff2')}`,
    ]);
    expect([...svg.matchAll(/https?:\/\/[^\s"')]*/g)].map((match) => match[0])).toEqual(['http://www.w3.org/2000/svg']);
  });

  test('XML-escapes every YAML value', () => {
    const root = tempRoot();
    const title = `A & <B> "C" 'D'`;
    const line = `Fish & chips <now>, "quoted" and 'single' too`;
    setInterface(root, 'brainstorm', { display_name: title, short_description: line });
    const svg = renderSkillCard(root, 'brainstorm');
    expect(svg).toContain('>A &amp; &lt;B&gt; &quot;C&quot; &apos;D&apos;</text>');
    expect(svg).not.toContain('<B>');
    expect(svg).not.toContain('<now>');
    const texts = textNodes(svg).map((node) => node.text);
    expect(texts[0]).toBe(title);
    expect(texts.slice(1, -2).join(' ')).toBe(line);
  });

  test('refuses a title over 24 characters and accepts 24', () => {
    const root = tempRoot();
    setInterface(root, 'wish', { display_name: 'x'.repeat(24) });
    expect(readSkillCardText(root, 'wish').title).toBe('x'.repeat(24));
    setInterface(root, 'wish', { display_name: 'x'.repeat(25) });
    expect(() => renderSkillCard(root, 'wish')).toThrow(SkillCardError);
    expect(() => renderSkillCard(root, 'wish')).toThrow(
      'skills/wish/agents/openai.yaml: interface.display_name is 25 characters; a card title holds at most 24',
    );
  });

  test('refuses a missing file, an empty or multi-line value, and a name the command row cannot hold', () => {
    const root = tempRoot();
    expect(() => readSkillCardText(root, 'missing')).toThrow('cannot read skills/missing/agents/openai.yaml');
    expect(() => readSkillCardText(root, '../fix')).toThrow('is not a skill name');
    expect(() => readSkillCardText(root, 'abcdefghijklm')).toThrow('is 13 characters');
    setInterface(root, 'fix', { short_description: '  ' });
    expect(() => readSkillCardText(root, 'fix')).toThrow('interface.short_description is missing or empty');
    setInterface(root, 'work', { display_name: 'Work\nNow' });
    expect(() => readSkillCardText(root, 'work')).toThrow('interface.display_name holds a control character');
  });
});

describe('writeSkillCards and checkSkillCards', () => {
  test('writes the six README cards and nothing else, byte-identical on a second run', () => {
    const root = tempRoot();
    const before = snapshot(root);
    const written = writeSkillCards(root);
    expect(written).toEqual(CORE_SKILLS.map((name) => readmeCardPath(root, name)));
    expect(readmeCardPath(root, 'wish')).toBe(join(root, '.github', 'assets', 'skill-wish.svg'));
    const after = snapshot(root);
    const added = Object.keys(after).filter((path) => !(path in before));
    expect(added.sort()).toEqual(
      [
        join('.github'),
        join('.github', 'assets'),
        ...CORE_SKILLS.map((name) => join('.github', 'assets', `skill-${name}.svg`)),
      ].sort(),
    );
    for (const name of CORE_SKILLS) {
      expect(readFileSync(readmeCardPath(root, name), 'utf8')).toBe(renderSkillCard(root, name));
    }
    writeSkillCards(root);
    expect(snapshot(root)).toEqual(after);
  });

  test('check names every missing card, passes once the cards are written, and writes nothing', () => {
    const root = tempRoot();
    const before = snapshot(root);
    expect(checkSkillCards(root)).toEqual({
      ok: false,
      differing: CORE_SKILLS.map((name) => readmeCardPath(root, name)),
    });
    expect(snapshot(root)).toEqual(before);
    writeSkillCards(root);
    expect(checkSkillCards(root)).toEqual({ ok: true, differing: [] });
  });

  test('check fails without writing after a short_description or a display_name changes', () => {
    const root = tempRoot();
    writeSkillCards(root);
    setInterface(root, 'brainstorm', { short_description: 'Settle an idea into a design' });
    setInterface(root, 'council', { display_name: 'The Council' });
    const before = snapshot(root);
    expect(checkSkillCards(root)).toEqual({
      ok: false,
      differing: [readmeCardPath(root, 'brainstorm'), readmeCardPath(root, 'council')],
    });
    expect(snapshot(root)).toEqual(before);
  });

  test('a refusal writes nothing, even when only the last card is refused', () => {
    const refusals = [
      { short_description: `${'a'.repeat(34)} ${'b'.repeat(34)}` },
      { short_description: `${'a'.repeat(20)} ${'b'.repeat(30)} ${'c'.repeat(12)}` },
      { display_name: 'x'.repeat(25) },
    ];
    for (const change of refusals) {
      const root = tempRoot();
      setInterface(root, CORE_SKILLS[CORE_SKILLS.length - 1], change);
      const before = snapshot(root);
      expect(() => writeSkillCards(root)).toThrow(SkillCardError);
      expect(snapshot(root)).toEqual(before);
    }
  });

  test('docs mode writes one card per skill holding a SKILL.md, through the docs link', () => {
    const root = tempRoot();
    mkdirSync(join(root, 'skills', 'draft', 'agents'), { recursive: true });
    cpSync(
      join(root, 'skills', 'wish', 'agents', 'openai.yaml'),
      join(root, 'skills', 'draft', 'agents', 'openai.yaml'),
    );
    mkdirSync(join(root, 'docs-checkout'));
    symlinkSync('docs-checkout', join(root, 'docs'));
    const shipped = readdirSync(join(REPO, 'skills'))
      .filter((name) => existsSync(join(REPO, 'skills', name, 'SKILL.md')))
      .sort();
    const names = docsSkillNames(root);
    expect(names).toEqual(shipped);
    expect(names).not.toContain('draft');
    for (const name of CORE_SKILLS) expect(names).toContain(name);
    expect(docsCardPath(root, 'wish')).toBe(join(root, 'docs', 'images', 'skills', 'wish.svg'));
    expect(writeSkillCards(root, { docs: true })).toEqual(names.map((name) => docsCardPath(root, name)));
    const files = names.map((name) => `${name}.svg`).sort();
    expect(readdirSync(join(root, 'docs-checkout', 'images', 'skills')).sort()).toEqual(files);
    expect(existsSync(join(root, '.github'))).toBe(false);
    expect(checkSkillCards(root, { docs: true })).toEqual({ ok: true, differing: [] });
  });

  test('docs mode refuses and creates nothing when the docs link dangles', () => {
    const root = tempRoot();
    danglingDocs(root);
    const before = snapshot(root);
    expect(() => writeSkillCards(root, { docs: true })).toThrow(SkillCardError);
    expect(() => writeSkillCards(root, { docs: true })).toThrow('docs/ does not resolve to a directory');
    expect(() => checkSkillCards(root, { docs: true })).toThrow(SkillCardError);
    expect(snapshot(root)).toEqual(before);
    expect(lstatSync(join(root, 'docs')).isSymbolicLink()).toBe(true);
    expect(existsSync(join(root, '.docs-vendor'))).toBe(false);
  });
});

describe('main', () => {
  test('no flag writes the six README cards and exits 0', async () => {
    const root = tempRoot();
    expect(await main([], root)).toBe(0);
    expect(stdout).toEqual(CORE_SKILLS.map((name) => `wrote ${join('.github', 'assets', `skill-${name}.svg`)}`));
    expect(stderr).toEqual([]);
  });

  test('--check exits 1 naming each differing card, 0 once they match, and 1 again after a YAML change', async () => {
    const root = tempRoot();
    expect(await main(['--check'], root)).toBe(1);
    for (const name of CORE_SKILLS) {
      expect(stderr).toContain(`skill-card-images: differs: ${join('.github', 'assets', `skill-${name}.svg`)}`);
    }
    expect(existsSync(join(root, '.github'))).toBe(false);
    expect(await main([], root)).toBe(0);
    expect(await main(['--check'], root)).toBe(0);
    setInterface(root, 'review', { short_description: 'Assess plans, code and PRs' });
    stderr = [];
    const before = snapshot(root);
    expect(await main(['--check'], root)).toBe(1);
    expect(stderr.filter((line) => line.includes('differs'))).toEqual([
      `skill-card-images: differs: ${join('.github', 'assets', 'skill-review.svg')}`,
    ]);
    expect(snapshot(root)).toEqual(before);
  });

  test('a refusal exits 1, names the YAML field and writes nothing', async () => {
    const root = tempRoot();
    setInterface(root, 'work', { short_description: 'x'.repeat(69) });
    const before = snapshot(root);
    expect(await main([], root)).toBe(1);
    expect(stderr).toEqual([
      'skill-card-images: skills/work/agents/openai.yaml: interface.short_description: line is 69 characters; a card holds at most 68',
    ]);
    expect(snapshot(root)).toEqual(before);
  });

  test('--docs and --docs --check exit 1 on a dangling docs link and create nothing', async () => {
    const root = tempRoot();
    danglingDocs(root);
    const before = snapshot(root);
    expect(await main(['--docs'], root)).toBe(1);
    expect(await main(['--docs', '--check'], root)).toBe(1);
    expect(stderr.length).toBe(2);
    for (const line of stderr) expect(line).toContain('docs/ does not resolve to a directory');
    expect(snapshot(root)).toEqual(before);
  });

  test('an unknown flag or an argument exits 2 and writes nothing; --help exits 0', async () => {
    const root = tempRoot();
    const before = snapshot(root);
    expect(await main(['--doc'], root)).toBe(2);
    expect(stderr[0]).toContain('unknown argument --doc');
    expect(stderr[0]).toContain('usage: bun scripts/skill-card-images.ts [--docs] [--check]');
    expect(await main(['--check', 'brainstorm'], root)).toBe(2);
    expect(await main(['--help'], root)).toBe(0);
    expect(stdout[0]).toContain('usage: bun scripts/skill-card-images.ts');
    expect(snapshot(root)).toEqual(before);
  });
});

describe('tracked inputs', () => {
  test('the fonts and the logo are byte-equal to their pinned sources, and OFL.txt names both fonts', () => {
    const dir = join(REPO, 'scripts', 'skill-card-images');
    const sha256 = (file: string) =>
      createHash('sha256')
        .update(readFileSync(join(dir, file)))
        .digest('hex');
    expect(sha256('fonts/geist-latin.woff2')).toBe('19f9c92546aa300c312235e3125af1b81394d8db9a4bc4a425cd5b641d2d54e1');
    expect(sha256('fonts/jetbrains-mono-latin.woff2')).toBe(
      '83c005d49d8a6a50474c73a5a36ac0468076e9c4a29da7bdb14995d80560a5be',
    );
    expect(sha256('genie-logo.png')).toBe('5aa731cfe324401368bb5c8bd79efeec52fb880eb7116fe543f3a26f20106507');
    const license = readFileSync(join(dir, 'fonts', 'OFL.txt'), 'utf8');
    expect(license).toMatch(/^Copyright.*(Geist|Vercel)/m);
    expect(license).toMatch(/^Copyright.*JetBrains/m);
    expect(license).toContain('SIL OPEN FONT LICENSE Version 1.1');
  });
});
