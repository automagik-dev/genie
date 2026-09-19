/**
 * The Claude Code workflow dialect, as a DSH body has to read it.
 *
 * A catalog file is a Claude Code Workflow script: a pure-literal
 * `export const meta = {...}` plus a body that uses the bare globals `agent`,
 * `parallel`, `pipeline`, `phase`, `log`, `workflow`, `budget` and `args`.
 * DSH's first-party engine takes that identity as a request field, not as code,
 * and rejects a deferred `agent()` option loudly.
 *
 * So this module owns exactly two transforms and two refusals:
 *   - `splitMeta`: lift the literal off the body (DSH rejects `export` at parse).
 *   - `stripDeferredOptions`: drop `effort` from `agent()` option objects, and
 *     ONLY from there. A schema field, identifier list or prompt word named
 *     `effort` is data the run depends on and is preserved byte-identically.
 *   - `scanUnsupported`: refuse a hook this engine does not implement, naming it.
 *   - A transform that cannot be proven returns undefined and the caller refuses
 *     the run, rather than handing the engine a script nobody has compiled.
 */

/** Options the engine accepts on `agent()`. Anything else is refused at the call. */
const SUPPORTED_AGENT_OPTIONS = ['label', 'phase', 'schema', 'provider', 'model'];

/** Options DSH defers: catalog files use them, the engine rejects them. */
const DEFERRED_AGENT_OPTIONS = ['effort'];

/** Hooks the catalog contract offers and this engine does not implement. */
const ABSENT_HOOKS = ['budget', 'workflow', 'isolation', 'agentType'];

export interface MetaBlock {
  name: string;
  description: string;
  whenToUse?: string;
  phases?: Array<{ title: string; detail?: string; provider?: string; model?: string }>;
  [key: string]: unknown;
}

export interface SplitResult {
  meta: MetaBlock;
  body: string;
}

export interface RemovedOption {
  line: number;
  option: string;
  snippet: string;
}

export interface StripResult {
  script: string;
  removed: RemovedOption[];
}

/** A refusal the operator can act on: what was found, where, and what it means. */
export class DialectError extends Error {
  constructor(
    message: string,
    readonly line?: number,
  ) {
    super(message);
    this.name = 'DialectError';
  }
}

// ── lexical scan ────────────────────────────────────────────────────────────
//
// A mask marks the bytes that are executable code; strings, templates, comments
// and regex literals are masked out. The mask errs toward masking: a span it
// cannot classify is treated as non-code, because missing an `effort` removal
// costs a loud engine error at the call, while removing text inside a prompt
// would silently corrupt the workflow.

function maskCode(text: string): Uint8Array {
  const mask = new Uint8Array(text.length).fill(1);
  let i = 0;
  let previous = '';
  const regexAllowed = () => previous === '' || '([{,;:=!&|?+-*%<>~^'.includes(previous);
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];
    if (ch === '/' && next === '/') {
      const end = text.indexOf('\n', i);
      const stop = end === -1 ? text.length : end;
      mask.fill(0, i, stop);
      i = stop;
      continue;
    }
    if (ch === '/' && next === '*') {
      const close = text.indexOf('*/', i + 2);
      const stop = close === -1 ? text.length : close + 2;
      mask.fill(0, i, stop);
      i = stop;
      continue;
    }
    if (ch === "'" || ch === '"') {
      const stop = scanQuoted(text, i, ch);
      mask.fill(0, i, stop);
      i = stop;
      previous = 'x';
      continue;
    }
    if (ch === '`') {
      const stop = scanTemplate(text, i);
      mask.fill(0, i, stop);
      i = stop;
      previous = 'x';
      continue;
    }
    if (ch === '/' && regexAllowed()) {
      const stop = scanRegex(text, i);
      if (stop > i + 1) {
        mask.fill(0, i, stop);
        i = stop;
        previous = 'x';
        continue;
      }
    }
    if (!/\s/.test(ch)) previous = ch;
    i++;
  }
  return mask;
}

/** End index (exclusive) of a string literal. */
function scanQuoted(text: string, start: number, quote: string): number {
  let i = start + 1;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === quote) return i + 1;
    if (ch === '\n') return i;
    i++;
  }
  return text.length;
}

/** End index (exclusive) of a template literal, including its `${}` interiors. */
function scanTemplate(text: string, start: number): number {
  let i = start + 1;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === '`') return i + 1;
    if (ch === '$' && text[i + 1] === '{') {
      let depth = 0;
      let j = i + 1;
      while (j < text.length) {
        const inner = text[j];
        if (inner === "'" || inner === '"') {
          j = scanQuoted(text, j, inner);
          continue;
        }
        if (inner === '`') {
          j = scanTemplate(text, j);
          continue;
        }
        if (inner === '{') depth++;
        else if (inner === '}') {
          depth--;
          if (depth === 0) {
            j++;
            break;
          }
        }
        j++;
      }
      i = j;
      continue;
    }
    i++;
  }
  return text.length;
}

/** End index (exclusive) of a regex literal, or start + 1 when this is not one. */
function scanRegex(text: string, start: number): number {
  let i = start + 1;
  let inClass = false;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === '\n') return start + 1;
    if (ch === '[') inClass = true;
    else if (ch === ']') inClass = false;
    else if (ch === '/' && !inClass) {
      let j = i + 1;
      while (j < text.length && /[a-z]/i.test(text[j])) j++;
      return j;
    }
    i++;
  }
  return start + 1;
}

/** Index of the bracket closing `open`, or -1. Brackets in masked spans do not count. */
function matchClose(text: string, mask: Uint8Array, open: number, openCh: string, closeCh: string): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (!mask[i]) continue;
    if (text[i] === openCh) depth++;
    else if (text[i] === closeCh) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function lineOf(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text[i] === '\n') line++;
  return line;
}

/** Top-level argument ranges of a parenthesised argument list. */
function splitArguments(text: string, mask: Uint8Array, from: number, to: number): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  let depth = 0;
  let start = from;
  for (let i = from; i < to; i++) {
    if (!mask[i]) continue;
    const ch = text[i];
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    else if (ch === ',' && depth === 0) {
      ranges.push([start, i]);
      start = i + 1;
    }
  }
  if (start < to) ranges.push([start, to]);
  return ranges;
}

function nextCodeIndex(text: string, mask: Uint8Array, from: number, to: number): number {
  for (let i = from; i < to; i++) if (mask[i] && !/\s/.test(text[i])) return i;
  return -1;
}

function previousCodeIndex(text: string, mask: Uint8Array, from: number): number {
  for (let i = from; i >= 0; i--) if (mask[i] && !/\s/.test(text[i])) return i;
  return -1;
}

// ── meta ────────────────────────────────────────────────────────────────────

/** Split the `export const meta` literal off the body, parsing it as data. */
export function splitMeta(text: string): SplitResult {
  const marker = /export\s+const\s+meta\s*=\s*/.exec(text);
  if (!marker) {
    throw new DialectError('no `export const meta = {...}` block: a catalog file must declare its identity');
  }
  const mask = maskCode(text);
  const open = text.indexOf('{', marker.index + marker[0].length);
  if (open === -1) throw new DialectError('malformed meta: no opening brace');
  const close = matchClose(text, mask, open, '{', '}');
  if (close === -1) throw new DialectError('malformed meta: unbalanced braces');
  const meta = parseLiteral(text.slice(open, close + 1)) as MetaBlock;
  if (typeof meta?.name !== 'string' || typeof meta?.description !== 'string') {
    throw new DialectError('meta must carry a string `name` and `description`');
  }
  return { meta, body: text.slice(0, marker.index) + text.slice(close + 1) };
}

/**
 * Parse a meta object literal as data. The catalog contract requires a pure
 * literal — no variables, calls, spreads or interpolation — so this never
 * evaluates anything, and anything else is refused by name.
 */
export function parseLiteral(source: string): unknown {
  let i = 0;
  const skip = () => {
    for (;;) {
      while (i < source.length && /\s/.test(source[i])) i++;
      if (source[i] === '/' && source[i + 1] === '/') {
        const end = source.indexOf('\n', i);
        i = end === -1 ? source.length : end;
        continue;
      }
      if (source[i] === '/' && source[i + 1] === '*') {
        const end = source.indexOf('*/', i + 2);
        i = end === -1 ? source.length : end + 2;
        continue;
      }
      return;
    }
  };
  const readString = (): string => {
    const quote = source[i];
    i++;
    let out = '';
    while (i < source.length) {
      const ch = source[i];
      if (ch === '\\') {
        out += source[i + 1] ?? '';
        i += 2;
        continue;
      }
      if (ch === quote) {
        i++;
        return out;
      }
      out += ch;
      i++;
    }
    throw new DialectError('unterminated string in meta');
  };
  const readIdentifier = (): string => {
    const start = i;
    while (i < source.length && /[\w$-]/.test(source[i])) i++;
    return source.slice(start, i);
  };
  const value = (): unknown => {
    skip();
    const ch = source[i];
    if (ch === '{') {
      i++;
      const out: Record<string, unknown> = {};
      for (;;) {
        skip();
        if (source[i] === '}') {
          i++;
          return out;
        }
        if (i >= source.length) throw new DialectError('unterminated object in meta');
        const key = source[i] === "'" || source[i] === '"' ? readString() : readIdentifier();
        if (!key) throw new DialectError(`meta must be a pure literal; found \`${source.slice(i, i + 20)}\``);
        skip();
        if (source[i] !== ':') throw new DialectError(`expected ':' after key \`${key}\` in meta`);
        i++;
        out[key] = value();
        skip();
        if (source[i] === ',') i++;
      }
    }
    if (ch === '[') {
      i++;
      const out: unknown[] = [];
      for (;;) {
        skip();
        if (source[i] === ']') {
          i++;
          return out;
        }
        if (i >= source.length) throw new DialectError('unterminated array in meta');
        out.push(value());
        skip();
        if (source[i] === ',') i++;
      }
    }
    if (ch === "'" || ch === '"') return readString();
    if (ch === '-' || /[0-9]/.test(ch ?? '')) {
      const start = i;
      while (i < source.length && /[0-9.eE+-]/.test(source[i])) i++;
      return Number(source.slice(start, i));
    }
    const word = readIdentifier();
    if (word === 'true') return true;
    if (word === 'false') return false;
    if (word === 'null') return null;
    throw new DialectError(`meta must be a pure literal; found \`${word || source.slice(i, i + 10)}\``);
  };
  const parsed = value();
  skip();
  if (i < source.length) throw new DialectError(`meta must be a pure literal; trailing \`${source.slice(i, i + 20)}\``);
  return parsed;
}

// ── deferred options ────────────────────────────────────────────────────────

interface Removal {
  start: number;
  end: number;
  line: number;
  option: string;
  snippet: string;
}

/**
 * Remove deferred options from `agent()` option objects.
 *
 * Returns undefined when the transform cannot be proven — an unreadable call, an
 * option this engine does not know, or a body that fails to compile afterwards.
 */
export function stripDeferredOptions(body: string, diagnostics?: string[]): StripResult | undefined {
  const bail = (reason: string, index?: number): undefined => {
    diagnostics?.push(index === undefined ? reason : `${reason} (line ${lineOf(body, index)})`);
    return undefined;
  };
  const mask = maskCode(body);
  const removals: Removal[] = [];
  const callPattern = /(?<![\w$.])agent\s*\(/g;
  for (let call = callPattern.exec(body); call; call = callPattern.exec(body)) {
    // A prompt or comment may spell `agent(` as prose; only a call in code counts.
    if (!mask[call.index]) continue;
    const open = body.indexOf('(', call.index);
    if (open === -1) return bail('could not read an agent() call', call.index);
    const close = matchClose(body, mask, open, '(', ')');
    if (close === -1) return bail('unbalanced parentheses in an agent() call', call.index);
    const args = splitArguments(body, mask, open + 1, close);
    if (args.length < 2) continue;
    const [argStart, argEnd] = args[1];
    const brace = nextCodeIndex(body, mask, argStart, argEnd);
    if (brace === -1 || body[brace] !== '{') continue;
    const objEnd = matchClose(body, mask, brace, '{', '}');
    if (objEnd === -1 || objEnd > argEnd) return bail('unbalanced braces in an agent() option object', brace);
    const found = optionsIn(body, mask, brace, objEnd, bail);
    if (!found) return undefined;
    removals.push(...found);
  }
  if (removals.length === 0) return { script: body, removed: [] };
  let script = body;
  for (const removal of [...removals].sort((a, b) => b.start - a.start)) {
    script = script.slice(0, removal.start) + script.slice(removal.end);
  }
  if (!compiles(script)) return bail('the transformed script does not compile');
  return { script, removed: removals.map(({ line, option, snippet }) => ({ line, option, snippet })) };
}

/**
 * Walk one `agent()` option object. Every property at depth 1 must be an option
 * this engine knows; a deferred one is removed, an unknown one refuses the run
 * (the engine rejects unknown options at the call, so pretending is worse).
 */
function optionsIn(
  body: string,
  mask: Uint8Array,
  brace: number,
  objEnd: number,
  bail: (reason: string, index?: number) => undefined,
): Removal[] | undefined {
  const removals: Removal[] = [];
  let depth = 0;
  let i = brace;
  while (i < objEnd) {
    if (!mask[i]) {
      i++;
      continue;
    }
    const ch = body[i];
    if (ch === '{' || ch === '(' || ch === '[') {
      depth++;
      i++;
      continue;
    }
    if (ch === '}' || ch === ')' || ch === ']') {
      depth--;
      i++;
      continue;
    }
    if (depth === 1 && /[A-Za-z_$]/.test(ch)) {
      const before = previousCodeIndex(body, mask, i - 1);
      const propertyPosition = before !== -1 && (body[before] === '{' || body[before] === ',');
      if (propertyPosition) {
        let end = i;
        while (end < objEnd && mask[end] && /[\w$]/.test(body[end])) end++;
        const name = body.slice(i, end);
        let cursor = nextCodeIndex(body, mask, end, objEnd);
        if (cursor === -1 || body[cursor] !== ':') return bail(`could not read the value of option \`${name}\``, i);
        cursor++;
        const valueEnd = scanValueEnd(body, mask, cursor, objEnd);
        if (valueEnd === -1) return bail(`could not read the end of option \`${name}\``, i);
        if (DEFERRED_AGENT_OPTIONS.includes(name)) {
          const commaBefore = before !== -1 && body[before] === ',' ? before : i;
          removals.push({
            start: commaBefore,
            end: body[valueEnd] === ',' ? valueEnd + 1 : valueEnd,
            line: lineOf(body, i),
            option: name,
            snippet: body.slice(i, valueEnd).replace(/\s+/g, ' ').slice(0, 60),
          });
        } else if (!SUPPORTED_AGENT_OPTIONS.includes(name)) {
          return bail(`\`agent()\` passes \`${name}\`, which this engine does not accept`, i);
        }
        i = valueEnd;
        continue;
      }
    }
    i++;
  }
  return removals;
}

/** End of a property value: the next depth-0 comma, or the object's closing brace (inclusive of `limit`). */
function scanValueEnd(text: string, mask: Uint8Array, from: number, limit: number): number {
  let depth = 0;
  for (let i = from; i <= limit && i < text.length; i++) {
    if (!mask[i]) continue;
    const ch = text[i];
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') {
      if (depth === 0) return i;
      depth--;
    } else if (ch === ',' && depth === 0) return i;
  }
  return -1;
}

/** Compile exactly as the engine compiles it, without running anything. */
export function compiles(script: string): boolean {
  try {
    new Function('agent', 'parallel', 'pipeline', 'phase', 'log', 'args', `return (async () => {\n${script}\n})`);
    return true;
  } catch {
    return false;
  }
}

// ── absent hooks ────────────────────────────────────────────────────────────

/** Refuse a script that uses a hook this engine does not implement. */
export function scanUnsupported(script: string): void {
  const mask = maskCode(script);
  for (const hook of ABSENT_HOOKS) {
    const pattern = new RegExp(`(?<![\\w$.])${hook}\\s*\\(`, 'g');
    for (let found = pattern.exec(script); found; found = pattern.exec(script)) {
      if (!mask[found.index]) continue;
      const line = lineOf(script, found.index);
      throw new DialectError(`uses \`${hook}()\` on line ${line}: this engine does not implement it`, line);
    }
  }
}
