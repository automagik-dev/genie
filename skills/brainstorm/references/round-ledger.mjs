#!/usr/bin/env node

// The round ledger: the ONLY writer of the fenced `ledger` JSON block in a
// brainstorm's DRAFT.md, and the model-less template and traceability check a
// DESIGN.md passes before review. Node ESM, no dependencies, one JSON object on
// stdout per call. Exit 0 ok, 1 a refusal or blocking findings, 2 usage (or a
// helper that could not run at all).
//
//   apply        --draft P [--answers JSON]           settle answers to Asked ids; creates the DRAFT or its block
//   ask          --draft P --round N --questions JSON record a batch, ids R<round>-<n>
//   ratchet      --draft P --round N --by WHO [--size P|M|G] [--scope JSON] [--approved ID]
//   council      --draft P --round N --run ID --ceiling N [--approved ID] [--decided JSON]
//   review       --draft P --round N --verdict V --digest SHA256 [--repaired] [--findings JSON]
//   render       --draft P                            rewrite the five ledger-owned sections
//   check-design --design P --draft P [--root P]      template and Source checks
//
// Any JSON flag may be given as `@<file>` to read the JSON from that file, so a
// question text never has to survive shell quoting.
//
// Rules a caller codes against:
// - `apply` returns the round this run works on: 1 + the highest round recorded
//   anywhere in the ledger (1 when empty). Answered questions leave Asked, so
//   Asked alone cannot carry the count. Pass that round to every later command.
// - An answer settles only its own id. A Settled id changes only through an
//   asked question whose `reopens` names it and whose text quotes the old answer
//   in quotation marks ("…" or “…”), then `→` and the new one; the old entry
//   stays and records `reopenedBy`, and a Source citing it no longer resolves.
//   One open question at a time may reopen a given id.
// - A pick stores the option's `value`; a multi-select stores an array; free
//   text stores `value: null` and the verbatim quote. An empty answer is a skip:
//   the question stays Asked and is shown again.
// - Asked never holds more than 4 open questions: it is always one batch.
// - `ratchet --scope` is the WHOLE Scope IN list. A smaller size or a missing
//   item is a downgrade, taken only with `--approved` naming an unused Settled
//   decision whose value names it exactly: `size:<P|M|G>`, `scope-drop:<item>`.
// - A council past the ceiling needs `--approved` naming an unused Settled
//   `council-approval` answer whose value is `convene`; none past 3, ever, and
//   no approval question is asked at 3.

import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const KINDS = new Set(['decision', 'council-approval', 'review-findings', 'end-without-design']);
const SIZES = ['P', 'M', 'G'];
const VERDICTS = new Set(['SHIP', 'FIX-FIRST', 'BLOCKED']);
const LEDGER_KEYS = ['settled', 'asked', 'size', 'scopeIn', 'councils', 'reviews'];
const OWNED_SECTIONS = ['Settled', 'Asked', 'Size', 'Scope ratchet', 'Councils'];
const COUNCIL_CAP = 3;
const BATCH_LIMIT = 4;
const CONVENE = 'convene';
const EVIDENCE_START = '<!-- genie-design-review:start -->';
const EVIDENCE_END = '<!-- genie-design-review:end -->';

const USAGE = [
  'usage: round-ledger.mjs <command> [flags]',
  '  apply        --draft <DRAFT.md> [--answers <json>]',
  '  ask          --draft <DRAFT.md> --round <n> --questions <json>',
  '  ratchet      --draft <DRAFT.md> --round <n> --by <who> [--size <P|M|G>] [--scope <json>] [--approved <id>]',
  '  council      --draft <DRAFT.md> --round <n> --run <id> --ceiling <0-3> [--approved <id>] [--decided <json>]',
  '  review       --draft <DRAFT.md> --round <n> --verdict <SHIP|FIX-FIRST|BLOCKED> --digest <sha256> [--repaired] [--findings <json>]',
  '  render       --draft <DRAFT.md>',
  '  check-design --design <DESIGN.md> --draft <DRAFT.md> [--root <dir>]',
].join('\n');

const FLAGS = {
  apply: { required: ['draft'], optional: ['answers'] },
  ask: { required: ['draft', 'round', 'questions'] },
  ratchet: { required: ['draft', 'round', 'by'], optional: ['size', 'scope', 'approved'] },
  council: { required: ['draft', 'round', 'run', 'ceiling'], optional: ['approved', 'decided'] },
  review: { required: ['draft', 'round', 'verdict', 'digest'], optional: ['findings'], booleans: ['repaired'] },
  render: { required: ['draft'] },
  'check-design': { required: ['design', 'draft'], optional: ['root'] },
};

class UsageError extends Error {}

/** A refusal of the whole call: nothing was written. */
class Refusal extends Error {
  constructor(reason, id = null) {
    super(reason);
    this.refused = [{ id, reason }];
  }
}

// ---------------------------------------------------------------- flags

function parseFlags(command, argv) {
  const spec = FLAGS[command];
  const valued = new Set([...spec.required, ...(spec.optional ?? [])]);
  const booleans = new Set(spec.booleans ?? []);
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const name = String(argv[index]).replace(/^--/, '');
    if (!argv[index].startsWith('--') || !(valued.has(name) || booleans.has(name))) {
      throw new UsageError(`${command} does not take ${argv[index]}`);
    }
    if (Object.hasOwn(flags, name)) throw new UsageError(`--${name} is given twice`);
    if (booleans.has(name)) {
      flags[name] = true;
      continue;
    }
    if (argv[index + 1] === undefined) throw new UsageError(`--${name} needs a value`);
    flags[name] = argv[index + 1];
    index += 1;
  }
  const missing = spec.required.filter((name) => !Object.hasOwn(flags, name));
  if (missing.length > 0) throw new UsageError(`${command} needs ${missing.map((name) => `--${name}`).join(', ')}`);
  return flags;
}

function jsonFlag(flags, name, fallback) {
  const raw = flags[name];
  if (raw === undefined) return fallback;
  let text = raw;
  if (raw.startsWith('@')) {
    try {
      text = readFileSync(raw.slice(1), 'utf8');
    } catch (error) {
      throw new UsageError(`--${name} names a file that cannot be read: ${raw.slice(1)} (${error.code ?? error})`);
    }
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new UsageError(`--${name} is not valid JSON: ${error.message}`);
  }
}

function roundFlag(flags) {
  if (!/^[1-9]\d*$/.test(flags.round)) throw new UsageError('--round must be a positive integer');
  return Number(flags.round);
}

function textFlag(flags, name) {
  const value = flags[name];
  if (typeof value !== 'string' || value.trim() === '') throw new UsageError(`--${name} must be a non-empty string`);
  return value.trim();
}

function stringList(value, name, pattern) {
  if (!Array.isArray(value)) throw new UsageError(`--${name} must be a JSON array of strings`);
  const bad = value.find((item) => typeof item !== 'string' || item.trim() === '' || !pattern.test(item));
  if (bad !== undefined) throw new UsageError(`--${name} holds an invalid entry: ${JSON.stringify(bad)}`);
  if (new Set(value).size !== value.length) throw new UsageError(`--${name} repeats an entry`);
  return value;
}

// ---------------------------------------------------------------- DRAFT IO

/** Every line with its offsets and whether it sits inside a ``` fence. */
function scanLines(text) {
  const lines = [];
  let offset = 0;
  let fence = null;
  for (const raw of text.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    const entry = { line, start: offset, end: Math.min(offset + raw.length + 1, text.length), fence, edge: null };
    if (fence === null && line.startsWith('```')) {
      fence = line.trim() === '```ledger' ? 'ledger' : 'code';
      Object.assign(entry, { fence, edge: 'open' });
    } else if (fence !== null && /^```\s*$/.test(line)) {
      Object.assign(entry, { edge: 'close' });
      fence = null;
    }
    lines.push(entry);
    offset += raw.length + 1;
  }
  return lines;
}

function ledgerBlocks(lines) {
  const blocks = [];
  for (const entry of lines) {
    if (entry.edge === 'open' && entry.fence === 'ledger') blocks.push({ open: entry, close: null });
    else if (entry.edge === 'close' && entry.fence === 'ledger') blocks[blocks.length - 1].close = entry;
  }
  return blocks;
}

function emptyLedger() {
  return Object.fromEntries(LEDGER_KEYS.map((key) => [key, []]));
}

function parseLedger(json) {
  let data;
  try {
    data = JSON.parse(json);
  } catch (error) {
    throw new Refusal(`the DRAFT's ledger block is not valid JSON: ${error.message}`);
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new Refusal("the DRAFT's ledger block must hold one JSON object");
  }
  const ledger = { ...emptyLedger(), ...data };
  for (const key of LEDGER_KEYS) {
    const list = ledger[key];
    if (!Array.isArray(list) || list.some((item) => item === null || typeof item !== 'object')) {
      throw new Refusal(`ledger.${key} must be an array of objects`);
    }
  }
  return ledger;
}

function ledgerFence(ledger) {
  return `\`\`\`ledger\n${JSON.stringify(ledger, null, 2)}\n\`\`\`\n`;
}

function readText(path, what) {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') throw new Refusal(`${what} not found at ${path}`);
    throw new Refusal(`${what} at ${path} cannot be read (${error.code ?? error})`);
  }
}

/** The DRAFT and its ledger. `bootstrap` creates a missing file or block. */
function loadDraft(path, { bootstrap = false } = {}) {
  if (!existsSync(path)) {
    if (!bootstrap) throw new Refusal(`DRAFT not found at ${path}; run apply first`);
    const ledger = emptyLedger();
    const title = `# DRAFT: ${basename(dirname(resolve(path)))}\n`;
    const text = `${renderSections(title, ledger).text}\n## Ledger\n\n${ledgerFence(ledger)}`;
    return { path, text, ledger, dirty: true };
  }
  const text = readText(path, 'DRAFT');
  const blocks = ledgerBlocks(scanLines(text));
  if (blocks.length > 1) throw new Refusal(`the DRAFT holds ${blocks.length} ledger blocks; keep exactly one`);
  if (blocks.length === 1 && blocks[0].close === null) throw new Refusal("the DRAFT's ledger block is never closed");
  if (blocks.length === 0) {
    if (!bootstrap) throw new Refusal(`the DRAFT at ${path} has no ledger block; run apply first`);
    const ledger = emptyLedger();
    const base = text === '' || text.endsWith('\n') ? text : `${text}\n`;
    return { path, text: `${base}\n## Ledger\n\n${ledgerFence(ledger)}`, ledger, dirty: true };
  }
  const { open, close } = blocks[0];
  return { path, text, ledger: parseLedger(text.slice(open.end, close.start)), dirty: false };
}

/** Write through a temp file in the same directory and rename it over the DRAFT, keeping its mode. */
function writeDraft(path, text) {
  const target = existsSync(path) ? realpathSync(path) : resolve(path);
  mkdirSync(dirname(target), { recursive: true });
  const temp = join(dirname(target), `.${basename(target)}.${process.pid}.tmp`);
  try {
    writeFileSync(temp, text);
    if (existsSync(target)) chmodSync(temp, statSync(target).mode & 0o7777);
    renameSync(temp, target);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

function saveDraft(draft) {
  const blocks = ledgerBlocks(scanLines(draft.text));
  const { open, close } = blocks[0];
  const text = draft.text.slice(0, open.start) + ledgerFence(draft.ledger) + draft.text.slice(close.end);
  writeDraft(draft.path, text);
  draft.text = text;
}

// ---------------------------------------------------------------- shared rules

function nextRound(ledger) {
  const rounds = LEDGER_KEYS.flatMap((key) => ledger[key].map((entry) => Number(entry.round) || 0));
  return Math.max(0, ...rounds) + 1;
}

function findSettled(ledger, id) {
  return ledger.settled.find((entry) => entry.id === id);
}

function asList(value) {
  return Array.isArray(value) ? value : [value];
}

const QUOTE_MARKS = [
  ['"', '"'],
  ['“', '”'],
];

/** End of the first `part` inside quotation marks in `text`, or -1. */
function quotedEnd(text, part) {
  const ends = QUOTE_MARKS.map(([open, close]) => {
    const at = text.indexOf(`${open}${part}${close}`);
    return at < 0 ? -1 : at + open.length + part.length + close.length;
  }).filter((end) => end >= 0);
  return ends.length > 0 ? Math.min(...ends) : -1;
}

/** True when `text` quotes every part of `oldAnswer` in quotation marks, then an arrow, then something new. */
function quotesOldToNew(text, oldAnswer) {
  let cursor = 0;
  for (const part of asList(oldAnswer).map(String)) {
    const end = part === '' ? -1 : quotedEnd(text, part);
    if (end < 0) return false;
    cursor = Math.max(cursor, end);
  }
  const arrows = ['→', '->'].map((arrow) => [text.indexOf(arrow, cursor), arrow.length]).filter(([at]) => at >= 0);
  if (arrows.length === 0) return false;
  const [at, length] = arrows.sort((a, b) => a[0] - b[0])[0];
  return text.slice(at + length).trim() !== '';
}

function reopenProblem(ledger, targetId, questionText) {
  const target = findSettled(ledger, targetId);
  if (!target) return `reopens ${targetId}, which is not a Settled id`;
  if (target.reopenedBy) return `${targetId} was already reopened by ${target.reopenedBy}; reopen that one instead`;
  if (!quotesOldToNew(questionText, target.answer)) {
    return `a reopen question must quote ${targetId}'s answer verbatim in quotation marks, then → and the new text`;
  }
  return null;
}

function approvalUsedBy(ledger, id) {
  const size = ledger.size.find((entry) => entry.approvedBy === id);
  if (size) return `the size change to ${size.value} in round ${size.round}`;
  const scope = ledger.scopeIn.find((entry) => entry.dropped?.approvedBy === id);
  if (scope) return `dropping "${scope.item}" in round ${scope.dropped.round}`;
  const council = ledger.councils.find((entry) => entry.approvedBy === id);
  if (council) return `council run ${council.run}`;
  return null;
}

function settledApprovalProblem(ledger, id, kind) {
  const entry = findSettled(ledger, id);
  if (!entry) return `--approved ${id} is not a Settled answer`;
  if (entry.kind !== kind) return `--approved ${id} is a ${entry.kind} answer, not a ${kind} one`;
  if (entry.reopenedBy) return `--approved ${id} was reopened by ${entry.reopenedBy}`;
  const usedBy = approvalUsedBy(ledger, id);
  if (usedBy) return `--approved ${id} was already used by ${usedBy}`;
  return null;
}

// ---------------------------------------------------------------- apply

function answerShapeProblem(answer) {
  if (answer === null || typeof answer !== 'object') return 'each answer must be an object {id, question, answer}';
  if (typeof answer.id !== 'string' || answer.id === '') return 'an answer needs a string id';
  if (typeof answer.question !== 'string') return 'an answer needs the question text as the harness returned it';
  const parts = asList(answer.answer);
  if (parts.some((part) => typeof part !== 'string')) return 'answer must be a string or an array of strings';
  return null;
}

function isSkip(answer) {
  return asList(answer).every((part) => part.trim() === '');
}

function optionFor(asked, label) {
  return asked.options.find((option) => option.label === label);
}

/** The picked labels: a multi-select string the harness joined with ", " is split when every part is a label. */
function picksFor(asked, answer) {
  if (Array.isArray(answer)) return answer;
  if (!asked.multiSelect || optionFor(asked, answer)) return [answer];
  const parts = answer.split(', ');
  return parts.every((part) => optionFor(asked, part)) ? parts : [answer];
}

function provenanceFor(asked, picks) {
  const picked = picks.filter((pick) => optionFor(asked, pick)).map((pick) => `"${pick}"`);
  const said = picks.filter((pick) => !optionFor(asked, pick)).map((pick) => `"${pick}"`);
  const parts = [];
  if (picked.length > 0) parts.push(`owner picked ${picked.join(', ')}`);
  if (said.length > 0) parts.push(`owner said: ${said.join(', ')}`);
  return parts.join('; ');
}

function settlementFor(asked, answer, round) {
  const picks = picksFor(asked, answer).filter((pick) => pick.trim() !== '');
  if (!asked.multiSelect && picks.length > 1) return { error: `${asked.id} is single-select; answer with one label` };
  const values = picks.map((pick) => optionFor(asked, pick)?.value ?? null);
  const entry = {
    id: asked.id,
    kind: asked.kind,
    question: asked.question,
    answer: asked.multiSelect ? picks : picks[0],
    value: asked.multiSelect ? values : values[0],
    provenance: provenanceFor(asked, picks),
    round,
  };
  if (asked.reopens) entry.reopens = asked.reopens;
  return { entry };
}

/** Re-sending the exact answer a Settled id already holds is a no-op; anything else is a change. */
function answerAgain(settled, answer, result) {
  const same = asList(settled.answer).join(', ') === asList(answer.answer).join(', ');
  if (isSkip(answer.answer) || (same && answer.question === settled.question)) {
    if (!isSkip(answer.answer))
      result.applied.push({ id: settled.id, provenance: settled.provenance, unchanged: true });
    return null;
  }
  return `${settled.id} is Settled; it changes only through a question whose reopens names it and quotes old → new`;
}

function applyOne(ledger, answer, round, result) {
  const { id } = answer;
  const settled = findSettled(ledger, id);
  if (settled) return answerAgain(settled, answer, result);
  const index = ledger.asked.findIndex((entry) => entry.id === id);
  if (index < 0) return `unknown id ${id}: it is neither Asked nor Settled`;
  const asked = ledger.asked[index];
  if (answer.question !== asked.question) return `the question text for ${id} differs from the one Asked`;
  if (isSkip(answer.answer)) return null;
  const reopen = asked.reopens ? reopenProblem(ledger, asked.reopens, asked.question) : null;
  if (reopen) return reopen;
  const { entry, error } = settlementFor(asked, answer.answer, round);
  if (error) return error;
  ledger.asked.splice(index, 1);
  ledger.settled.push(entry);
  if (asked.reopens) findSettled(ledger, asked.reopens).reopenedBy = id;
  result.applied.push({ id, provenance: entry.provenance, ...(asked.reopens ? { reopens: asked.reopens } : {}) });
  return null;
}

function answerRefusal(ledger, answer, round, result, seen) {
  const shape = answerShapeProblem(answer);
  if (shape) return shape;
  if (seen.has(answer.id)) return `${answer.id} is answered twice in one batch`;
  seen.add(answer.id);
  return applyOne(ledger, answer, round, result);
}

function commandApply(flags) {
  const answers = jsonFlag(flags, 'answers', []);
  if (!Array.isArray(answers)) throw new UsageError('--answers must be a JSON array');
  const draft = loadDraft(flags.draft, { bootstrap: true });
  const round = nextRound(draft.ledger);
  const result = { round, applied: [], refused: [], skipped: [] };
  const seen = new Set();
  for (const answer of answers) {
    const reason = answerRefusal(draft.ledger, answer, round, result, seen);
    if (reason) result.refused.push({ id: typeof answer?.id === 'string' ? answer.id : null, reason });
  }
  result.skipped = draft.ledger.asked.map((entry) => entry.id);
  if (draft.dirty || result.applied.some((entry) => !entry.unchanged)) saveDraft(draft);
  return { exitCode: result.refused.length > 0 ? 1 : 0, output: { ...result, ledger: draft.ledger } };
}

// ---------------------------------------------------------------- ask

function optionProblem(option) {
  if (option === null || typeof option !== 'object') return 'each option must be an object {label, description, value}';
  if (typeof option.label !== 'string' || option.label.trim() === '') return 'each option needs a label';
  if (typeof option.description !== 'string') return `option "${option.label}" needs a description string`;
  if (typeof option.value !== 'string' || option.value.trim() === '') return `option "${option.label}" needs a value`;
  return null;
}

function optionsProblem(question) {
  const { options } = question;
  if (!Array.isArray(options) || options.length < 2 || options.length > 4) return 'a question needs 2 to 4 options';
  const problem = options.map(optionProblem).find(Boolean);
  if (problem) return problem;
  if (new Set(options.map((option) => option.label)).size !== options.length) return 'option labels must be unique';
  if (new Set(options.map((option) => option.value)).size !== options.length) return 'option values must be unique';
  return null;
}

function councilApprovalQuestionProblem(question, ledger) {
  if (question.kind !== 'council-approval') return null;
  if (ledger.councils.length >= COUNCIL_CAP) {
    return `${COUNCIL_CAP} councils are recorded, the cap; no approval question is asked at the cap`;
  }
  if (question.multiSelect) return 'a council-approval question is single-select';
  const convene = question.options.filter((option) => option.value === CONVENE);
  if (convene.length !== 1) return `a council-approval question needs exactly one option with value "${CONVENE}"`;
  return null;
}

function questionProblem(question, ledger) {
  if (question === null || typeof question !== 'object') return 'each question must be an object';
  if (!KINDS.has(question.kind)) return `kind must be one of ${[...KINDS].join(', ')}`;
  if (typeof question.question !== 'string' || question.question.trim() === '') return 'a question needs its text';
  if (typeof question.header !== 'string' || question.header.trim() === '') return 'a question needs a header';
  if (question.multiSelect !== undefined && typeof question.multiSelect !== 'boolean') {
    return 'multiSelect must be a boolean';
  }
  const options = optionsProblem(question);
  if (options) return options;
  if (question.reopens === undefined) return councilApprovalQuestionProblem(question, ledger);
  if (typeof question.reopens !== 'string') return 'reopens must name one Settled id';
  const pending = ledger.asked.find((entry) => entry.reopens === question.reopens);
  if (pending) return `${question.reopens} is already being reopened by open question ${pending.id}`;
  return reopenProblem(ledger, question.reopens, question.question) ?? councilApprovalQuestionProblem(question, ledger);
}

function nextQuestionNumber(ledger, round) {
  const pattern = new RegExp(`^R${round}-(\\d+)$`);
  const numbers = [...ledger.asked, ...ledger.settled].map((entry) => Number(pattern.exec(entry.id)?.[1] ?? 0));
  return Math.max(0, ...numbers) + 1;
}

function commandAsk(flags) {
  const round = roundFlag(flags);
  const questions = jsonFlag(flags, 'questions');
  if (!Array.isArray(questions) || questions.length === 0) {
    throw new UsageError('--questions must be a non-empty JSON array');
  }
  const draft = loadDraft(flags.draft);
  const { ledger } = draft;
  const refused = questions
    .map((question, index) => ({ index, reason: questionProblem(question, ledger) }))
    .filter((entry) => entry.reason);
  const reopened = questions.map((question) => question?.reopens).filter(Boolean);
  if (new Set(reopened).size !== reopened.length) {
    refused.push({ index: null, reason: 'two questions in one batch reopen the same id' });
  }
  if (ledger.asked.length + questions.length > BATCH_LIMIT) {
    const open = ledger.asked.map((entry) => entry.id).join(', ') || 'none';
    refused.push({
      index: null,
      reason: `Asked would hold ${ledger.asked.length + questions.length} open questions; the batch limit is ${BATCH_LIMIT} (open: ${open})`,
    });
  }
  if (refused.length > 0) return { exitCode: 1, output: { asked: [], refused } };
  let number = nextQuestionNumber(ledger, round);
  const asked = questions.map((question) => {
    const entry = {
      id: `R${round}-${number}`,
      kind: question.kind,
      question: question.question,
      header: question.header,
      multiSelect: question.multiSelect ?? false,
      options: question.options.map(({ label, description, value }) => ({ label, description, value })),
      round,
    };
    if (question.reopens) entry.reopens = question.reopens;
    number += 1;
    return entry;
  });
  ledger.asked.push(...asked);
  saveDraft(draft);
  return { exitCode: 0, output: { asked } };
}

// ---------------------------------------------------------------- ratchet

function currentSize(ledger) {
  return ledger.size.length > 0 ? ledger.size[ledger.size.length - 1].value : null;
}

function currentScope(ledger) {
  return ledger.scopeIn.filter((entry) => !entry.dropped).map((entry) => entry.item);
}

function downgradeProblem(ledger, approved, downgrades) {
  const wanted = downgrades.join(', ');
  if (!approved) return `${wanted} lowers what the owner approved; it needs --approved <settled id> that agreed to it`;
  const problem = settledApprovalProblem(ledger, approved, 'decision');
  if (problem) return problem;
  const values = asList(findSettled(ledger, approved).value);
  const missing = downgrades.filter((token) => !values.includes(token));
  if (missing.length > 0) return `--approved ${approved} did not agree to ${missing.join(', ')}`;
  return null;
}

/** What a ratchet call would change, and which of those changes lower what the owner approved. */
function ratchetPlan(ledger, size, scope) {
  const current = currentSize(ledger);
  const sizeChanges = size !== undefined && size !== current;
  const lowered = sizeChanges && current !== null && SIZES.indexOf(size) < SIZES.indexOf(current);
  const inScope = currentScope(ledger);
  const added = scope ? scope.filter((item) => !inScope.includes(item)) : [];
  const dropped = scope ? inScope.filter((item) => !scope.includes(item)) : [];
  const downgrades = [...(lowered ? [`size:${size}`] : []), ...dropped.map((item) => `scope-drop:${item}`)];
  return { size: sizeChanges ? size : null, lowered, added, dropped, downgrades };
}

function applyRatchet(ledger, plan, stamp) {
  const changes = [];
  if (plan.size) {
    ledger.size.push({
      value: plan.size,
      by: stamp.by,
      round: stamp.round,
      ...(plan.lowered ? { approvedBy: stamp.approvedBy } : {}),
    });
    changes.push({ change: plan.lowered ? 'size-lowered' : 'size-raised', value: plan.size });
  }
  for (const entry of ledger.scopeIn.filter((item) => !item.dropped && plan.dropped.includes(item.item))) {
    entry.dropped = stamp;
    changes.push({ change: 'scope-dropped', item: entry.item });
  }
  for (const item of plan.added) {
    ledger.scopeIn.push({ item, by: stamp.by, round: stamp.round });
    changes.push({ change: 'scope-added', item });
  }
  return changes;
}

function commandRatchet(flags) {
  const round = roundFlag(flags);
  const by = textFlag(flags, 'by');
  if (flags.size === undefined && flags.scope === undefined) throw new UsageError('ratchet needs --size or --scope');
  if (flags.size !== undefined && !SIZES.includes(flags.size)) throw new UsageError('--size must be P, M or G');
  const scope = flags.scope === undefined ? null : stringList(jsonFlag(flags, 'scope'), 'scope', /\S/);
  const draft = loadDraft(flags.draft);
  const { ledger } = draft;
  const plan = ratchetPlan(ledger, flags.size, scope);
  const lowers = plan.downgrades.length > 0;
  const problem = lowers ? downgradeProblem(ledger, flags.approved, plan.downgrades) : null;
  if (problem) throw new Refusal(problem, flags.approved ?? null);
  const changes = applyRatchet(ledger, plan, { by, round, approvedBy: lowers ? flags.approved : undefined });
  if (changes.length > 0) saveDraft(draft);
  return { exitCode: 0, output: { size: currentSize(ledger), scope: currentScope(ledger), changes } };
}

// ---------------------------------------------------------------- council

function councilProblem(ledger, flags, ceiling, decided) {
  const count = ledger.councils.length;
  if (count >= COUNCIL_CAP) return `${count} councils are recorded; no council is convened past ${COUNCIL_CAP}`;
  if (ledger.councils.some((entry) => entry.run === flags.run)) return `council run ${flags.run} is already recorded`;
  const earlier = new Set(ledger.councils.flatMap((entry) => entry.decided ?? []));
  const reused = decided.filter((id) => earlier.has(id));
  if (reused.length > 0) return `${reused.join(', ')} already name an earlier council's decisions`;
  if (flags.approved)
    return settledApprovalProblem(ledger, flags.approved, 'council-approval') ?? conveneProblem(ledger, flags.approved);
  if (count >= ceiling) {
    return `council ${count + 1} is past the ceiling of ${ceiling}; it needs --approved <settled council-approval answer>`;
  }
  return null;
}

function conveneProblem(ledger, id) {
  const entry = findSettled(ledger, id);
  if (entry.value === CONVENE) return null;
  return `--approved ${id} was answered ${JSON.stringify(entry.answer)}, not the option of value "${CONVENE}"`;
}

function commandCouncil(flags) {
  const round = roundFlag(flags);
  const run = textFlag(flags, 'run');
  if (!/^[0-3]$/.test(flags.ceiling)) throw new UsageError(`--ceiling must be an integer from 0 to ${COUNCIL_CAP}`);
  const decided = stringList(jsonFlag(flags, 'decided', []), 'decided', /^P\d+$/);
  const draft = loadDraft(flags.draft);
  const problem = councilProblem(draft.ledger, { ...flags, run }, Number(flags.ceiling), decided);
  if (problem) throw new Refusal(problem, flags.approved ?? null);
  const council = { run, round, ...(flags.approved ? { approvedBy: flags.approved } : {}), decided };
  draft.ledger.councils.push(council);
  saveDraft(draft);
  return { exitCode: 0, output: { council, count: draft.ledger.councils.length, ceiling: Number(flags.ceiling) } };
}

// ---------------------------------------------------------------- review

function commandReview(flags) {
  const round = roundFlag(flags);
  if (!VERDICTS.has(flags.verdict)) throw new UsageError('--verdict must be SHIP, FIX-FIRST or BLOCKED');
  if (!/^[a-f0-9]{64}$/.test(flags.digest)) throw new UsageError('--digest must be 64 lowercase hex characters');
  const findings = stringList(jsonFlag(flags, 'findings', []), 'findings', /\S/);
  const draft = loadDraft(flags.draft);
  const ship = draft.ledger.reviews.find((entry) => entry.verdict === 'SHIP');
  if (ship) throw new Refusal(`DESIGN.md is frozen by the SHIP recorded in round ${ship.round}`);
  const review = { verdict: flags.verdict, digest: flags.digest, round, repaired: flags.repaired === true, findings };
  draft.ledger.reviews.push(review);
  saveDraft(draft);
  return { exitCode: 0, output: { review, ordinal: draft.ledger.reviews.length } };
}

// ---------------------------------------------------------------- render

function oneLine(value) {
  return String(value ?? '')
    .replace(/\s*[\r\n]+\s*/g, ' ')
    .trim();
}

function settledBody(ledger) {
  if (ledger.settled.length === 0) return '_Nothing settled yet._';
  return ledger.settled
    .map((entry) => {
      const notes = [
        entry.reopens && `reopens ${entry.reopens}`,
        entry.reopenedBy && `reopened by ${entry.reopenedBy}`,
      ];
      const tail = notes
        .filter(Boolean)
        .map((note) => ` · ${note}`)
        .join('');
      return `- **${entry.id}** (round ${entry.round}, ${entry.kind}): ${oneLine(entry.question)} — ${oneLine(entry.provenance)}${tail}`;
    })
    .join('\n');
}

function askedBody(ledger) {
  if (ledger.asked.length === 0) return '_No open questions._';
  return ledger.asked
    .map((entry) => {
      const notes = [entry.multiSelect && 'multi-select', entry.reopens && `reopens ${entry.reopens}`];
      const tail = notes
        .filter(Boolean)
        .map((note) => ` · ${note}`)
        .join('');
      const options = entry.options.map(
        (option, index) => `  ${index + 1}. ${oneLine(option.label)} — ${oneLine(option.description)}`,
      );
      return [
        `- **${entry.id}** (round ${entry.round}, ${entry.kind}): ${oneLine(entry.question)}${tail}`,
        ...options,
      ].join('\n');
    })
    .join('\n');
}

function sizeBody(ledger) {
  if (ledger.size.length === 0) return '_Not sized yet._';
  return ledger.size
    .map((entry, index) => {
      const previous = index > 0 ? ledger.size[index - 1].value : null;
      const verb = previous && SIZES.indexOf(entry.value) < SIZES.indexOf(previous) ? 'lowered' : 'raised';
      const approval = entry.approvedBy ? ` · approved by ${entry.approvedBy}` : '';
      return `- **${entry.value}** · ${verb} by ${oneLine(entry.by)} · round ${entry.round}${approval}`;
    })
    .join('\n');
}

function scopeBody(ledger) {
  if (ledger.scopeIn.length === 0) return '_No IN items yet._';
  return ledger.scopeIn
    .map((entry) => {
      const added = `added by ${oneLine(entry.by)} · round ${entry.round}`;
      if (!entry.dropped) return `- ${oneLine(entry.item)} · ${added}`;
      const { by, round, approvedBy } = entry.dropped;
      return `- ~~${oneLine(entry.item)}~~ · ${added} · dropped by ${oneLine(by)} · round ${round} · approved by ${approvedBy}`;
    })
    .join('\n');
}

function councilsBody(ledger) {
  if (ledger.councils.length === 0) return '_None convened._';
  return ledger.councils
    .map((entry) => {
      const decided = entry.decided?.length ? ` · decided ${entry.decided.join(', ')}` : '';
      const approval = entry.approvedBy ? ` · approved by ${entry.approvedBy}` : '';
      return `- run ${oneLine(entry.run)} · round ${entry.round}${approval}${decided}`;
    })
    .join('\n');
}

const SECTION_BODIES = {
  Settled: settledBody,
  Asked: askedBody,
  Size: sizeBody,
  'Scope ratchet': scopeBody,
  Councils: councilsBody,
};

/** Where each owned section starts and ends: up to the next level-1/2 heading or the ledger block. */
function ownedSpans(text) {
  const lines = scanLines(text);
  const stops = lines.filter((entry) => (entry.fence === null && /^#{1,2} /.test(entry.line)) || entry.edge === 'open');
  const spans = {};
  for (const name of OWNED_SECTIONS) {
    const heads = lines.filter((entry) => entry.fence === null && entry.line === `## ${name}`);
    if (heads.length > 1) throw new Refusal(`the DRAFT has ${heads.length} sections headed "## ${name}"; merge them`);
    if (heads.length === 0) continue;
    const next = stops.find((entry) => entry.start > heads[0].start);
    spans[name] = { start: heads[0].start, end: next ? next.start : text.length };
  }
  return spans;
}

function renderSections(text, ledger) {
  const spans = ownedSpans(text);
  const present = OWNED_SECTIONS.filter((name) => spans[name]).sort((a, b) => spans[b].start - spans[a].start);
  let out = text;
  for (const name of present) {
    const { start, end } = spans[name];
    const gap = end < out.length ? '\n' : '';
    out = `${out.slice(0, start)}## ${name}\n\n${SECTION_BODIES[name](ledger)}\n${gap}${out.slice(end)}`;
  }
  const missing = OWNED_SECTIONS.filter((name) => !spans[name]);
  for (const name of missing) {
    if (out !== '' && !out.endsWith('\n')) out += '\n';
    out += `${out === '' ? '' : '\n'}## ${name}\n\n${SECTION_BODIES[name](ledger)}\n`;
  }
  return { text: out, rewritten: OWNED_SECTIONS.filter((name) => spans[name]), appended: missing };
}

function commandRender(flags) {
  const draft = loadDraft(flags.draft);
  const { text, rewritten, appended } = renderSections(draft.text, draft.ledger);
  if (text !== draft.text) writeDraft(draft.path, text);
  return { exitCode: 0, output: { rewritten, appended, changed: text !== draft.text } };
}

// ---------------------------------------------------------------- check-design

const REVIEWER_ID = '([A-Z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)*)';
const TOKEN_RULES = [
  { type: 'path', pattern: /`([^`]+)`/g },
  { type: 'reviewer-round', pattern: new RegExp(`\\b[Rr]eviewer round-(\\d+) ${REVIEWER_ID}`, 'g') },
  { type: 'reviewer', pattern: new RegExp(`\\b[Rr]eviewer ${REVIEWER_ID}`, 'g') },
  { type: 'settled', pattern: /\bR\d+-[A-Za-z0-9]+\b/g },
  { type: 'council', pattern: /\bP\d+\b/g },
];

/** Decision 4: id-shaped strings and backticked paths are tokens; every other word is prose. */
export function sourceTokens(text) {
  const tokens = [];
  let rest = text;
  for (const { type, pattern } of TOKEN_RULES) {
    rest = rest.replace(pattern, (match, first, second) => {
      tokens.push({ type, text: match, first, second });
      return ' ';
    });
  }
  return tokens;
}

function pathProblem(token, root) {
  const path = token.first.trim().replace(/:\d+(?:-\d+)?$/, '');
  const target = resolve(root, path);
  const inside = relative(root, target);
  if (isAbsolute(path) || inside.startsWith('..')) return `${token.text} points outside the root ${root}`;
  return existsSync(target) ? null : `${token.text} does not exist under ${root}`;
}

/** A Source cites the current answer: an id another question reopened is superseded. */
function settledSourceProblem(ledger, id) {
  const entry = findSettled(ledger, id);
  if (!entry) return `${id} is not a Settled id`;
  if (entry.reopenedBy) return `${id} was reopened by ${entry.reopenedBy}; cite the current answer instead`;
  return null;
}

function tokenProblem(token, ledger, root) {
  const reviews = ledger.reviews;
  switch (token.type) {
    case 'path':
      return pathProblem(token, root);
    case 'reviewer-round': {
      const review = reviews[Number(token.first) - 1];
      if (!review) return `${token.text}: the ledger records ${reviews.length} reviews`;
      return (review.findings ?? []).includes(token.second)
        ? null
        : `${token.text}: review ${token.first} lists no ${token.second}`;
    }
    case 'reviewer':
      return reviews.some((review) => (review.findings ?? []).includes(token.first))
        ? null
        : `${token.text}: no recorded review lists ${token.first}`;
    case 'settled':
      return settledSourceProblem(ledger, token.text);
    default:
      return ledger.councils.some((council) => (council.decided ?? []).includes(token.text))
        ? null
        : `${token.text} is not a decision of any recorded council`;
  }
}

function sourceFindings(sourceText, location, context) {
  const tokens = sourceTokens(sourceText ?? '');
  if (tokens.length === 0) {
    return [finding('missing-source', location, 'no Source token: cite a Settled id, P<n>, reviewer <id> or a `path`')];
  }
  return tokens
    .map((token) => tokenProblem(token, context.ledger, context.root))
    .filter(Boolean)
    .map((detail) => finding('unresolved-source', location, detail));
}

function finding(kind, location, detail, blocking = true) {
  return { kind, location, detail, blocking };
}

function headingLevel(line) {
  return /^(#{1,6}) /.exec(line)?.[1].length ?? 0;
}

/** The lines under the first heading exactly `heading`, up to the next heading of the same or a higher level. */
function sectionLines(lines, heading) {
  const level = headingLevel(heading);
  const start = lines.findIndex((entry) => entry.fence === null && entry.line.trim() === heading);
  if (start < 0) return null;
  const body = [];
  for (const entry of lines.slice(start + 1)) {
    const entryLevel = entry.fence === null ? headingLevel(entry.line) : 0;
    if (entryLevel > 0 && entryLevel <= level) break;
    body.push(entry);
  }
  return body;
}

function splitRow(line) {
  const cells = [];
  let cell = '';
  let code = false;
  const inner = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  for (let index = 0; index < inner.length; index += 1) {
    const char = inner[index];
    if (char === '`') code = !code;
    if (char === '|' && !code && inner[index - 1] !== '\\') {
      cells.push(cell.trim());
      cell = '';
    } else cell += char;
  }
  cells.push(cell.trim());
  return cells;
}

function table(body) {
  const rows = body.filter((entry) => entry.fence === null && entry.line.trim().startsWith('|'));
  if (rows.length < 2) return null;
  const header = splitRow(rows[0].line).map((cell) => cell.toLowerCase());
  const data = rows.slice(1).filter((entry) => !/^\|?[\s:|-]+$/.test(entry.line.trim()));
  return { header, rows: data.map((entry) => ({ cells: splitRow(entry.line), lineNo: entry.lineNo })) };
}

/** Top-level `- ` bullets with their indented continuation lines. */
function bullets(body) {
  const items = [];
  for (const entry of body) {
    if (entry.fence !== null) continue;
    if (/^[-*] /.test(entry.line)) items.push({ text: entry.line.slice(2), lineNo: entry.lineNo });
    else if (items.length > 0 && /^\s+\S/.test(entry.line)) items[items.length - 1].text += ` ${entry.line.trim()}`;
  }
  return items;
}

function decisionFindings(lines, context) {
  const body = sectionLines(lines, '## Decisions');
  if (!body) return [finding('missing-section', '## Decisions', 'the design has no Decisions section')];
  const rows = table(body);
  if (!rows) return [finding('missing-section', '## Decisions', 'Decisions holds no table')];
  const source = rows.header.indexOf('source');
  if (source < 0) return [finding('missing-source', '## Decisions', 'the Decisions table has no Source column')];
  return rows.rows.flatMap((row) =>
    sourceFindings(row.cells[source], `Decisions #${row.cells[0]} (line ${row.lineNo})`, context),
  );
}

function inFindings(lines, context) {
  const body = sectionLines(lines, '### IN');
  if (!body) return [finding('missing-section', '### IN', 'the design has no Scope IN section')];
  const rows = table(body);
  if (!rows)
    return [finding('missing-section', '### IN', 'Scope IN must be a table with Files changed and Source columns')];
  const source = rows.header.indexOf('source');
  const files = rows.header.findIndex((cell) => cell.startsWith('files'));
  const missing = [];
  if (source < 0) missing.push(finding('missing-source', '### IN', 'the Scope IN table has no Source column'));
  if (files < 0) missing.push(finding('in-without-files', '### IN', 'the Scope IN table has no Files changed column'));
  if (missing.length > 0) return missing;
  return rows.rows.flatMap((row) => {
    const location = `Scope IN #${row.cells[0]} (line ${row.lineNo})`;
    const noFiles = /`[^`]+`/.test(row.cells[files] ?? '')
      ? []
      : [finding('in-without-files', location, 'name the files this item changes, each in backticks')];
    return [...noFiles, ...sourceFindings(row.cells[source], location, context)];
  });
}

function outFindings(lines, context) {
  const body = sectionLines(lines, '### OUT');
  if (!body) return [finding('missing-section', '### OUT', 'the design has no Scope OUT section')];
  return bullets(body).flatMap((item, index) => {
    const location = `Scope OUT bullet ${index + 1} (line ${item.lineNo})`;
    const at = item.text.search(/\bSource:/i);
    if (at < 0) return [finding('missing-source', location, 'an OUT bullet needs "(Source: …)"')];
    const cited = item.text.slice(at + 'Source:'.length).split(')')[0];
    return sourceFindings(cited, location, context);
  });
}

function criteriaFindings(lines) {
  const body = sectionLines(lines, '## Success Criteria');
  if (!body) return [finding('missing-section', '## Success Criteria', 'the design has no Success Criteria section')];
  const items = bullets(body);
  if (items.length === 0) return [finding('missing-section', '## Success Criteria', 'Success Criteria lists nothing')];
  return items
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => !/\bProof:(?:\*\*)?\s*\S/.test(item.text))
    .map(({ item, index }) =>
      finding('criterion-without-proof', `Success Criteria #${index + 1} (line ${item.lineNo})`, 'add **Proof:**'),
    );
}

const PLACEHOLDERS = [/<[A-Za-z][^<>]*>/g, /\bYYYY-MM-DD\b/g, /\b(?:TBD|TODO|FIXME|PENDING)\b/g];
const INLINE_HTML = /^<\/?(?:br|details|summary|sup|sub|kbd|img|a|b|i|em|strong|code|span|div|p)\b[^>]*>$/i;

function placeholderFindings(lines) {
  const found = [];
  let evidence = false;
  for (const entry of lines) {
    if (entry.line.includes(EVIDENCE_START)) evidence = true;
    const skip = evidence || entry.fence !== null;
    if (entry.line.includes(EVIDENCE_END)) evidence = false;
    if (skip) continue;
    const prose = entry.line.replace(/`+[^`]*`+/g, ' ').replace(/<!--.*?-->/g, ' ');
    const hits = PLACEHOLDERS.flatMap((pattern) => prose.match(pattern) ?? []).filter(
      (hit) => !INLINE_HTML.test(hit) && !/^<https?:/i.test(hit),
    );
    for (const hit of hits) found.push(finding('placeholder', `line ${entry.lineNo}`, `placeholder ${hit}`));
  }
  return found;
}

function defaultRoot(designPath) {
  const directory = dirname(resolve(designPath));
  try {
    const top = execFileSync('git', ['-C', directory, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return top.trim() || directory;
  } catch {
    return directory;
  }
}

export function checkDesign(designText, ledger, root) {
  const lines = scanLines(designText).map((entry, index) => ({ ...entry, lineNo: index + 1 }));
  const context = { ledger, root };
  return [
    ...criteriaFindings(lines),
    ...decisionFindings(lines, context),
    ...inFindings(lines, context),
    ...outFindings(lines, context),
    ...placeholderFindings(lines),
  ];
}

function commandCheckDesign(flags) {
  const design = readText(flags.design, 'DESIGN.md');
  const { ledger } = loadDraft(flags.draft);
  const root = flags.root ? resolve(flags.root) : defaultRoot(flags.design);
  const findings = checkDesign(design, ledger, root);
  return { exitCode: findings.some((entry) => entry.blocking) ? 1 : 0, output: { findings, root } };
}

// ---------------------------------------------------------------- CLI

const COMMANDS = {
  apply: commandApply,
  ask: commandAsk,
  ratchet: commandRatchet,
  council: commandCouncil,
  review: commandReview,
  render: commandRender,
  'check-design': commandCheckDesign,
};

/** One call: `{exitCode, output}`, never a throw. */
export function runRoundLedger(argv) {
  try {
    const [command, ...rest] = argv;
    if (!Object.hasOwn(COMMANDS, command ?? '')) throw new UsageError(`unknown command ${command ?? '(none)'}`);
    return COMMANDS[command](parseFlags(command, rest));
  } catch (error) {
    if (error instanceof Refusal) return { exitCode: 1, output: { refused: error.refused } };
    if (error instanceof UsageError) return { exitCode: 2, output: { error: error.message, usage: USAGE } };
    return { exitCode: 2, output: { error: `round-ledger could not run: ${error?.stack ?? error}` } };
  }
}

function realPathOrGiven(path) {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

const invokedAsEntryPoint =
  typeof import.meta.main === 'boolean'
    ? import.meta.main
    : Boolean(process.argv[1]) &&
      realPathOrGiven(resolve(process.argv[1])) === realPathOrGiven(fileURLToPath(import.meta.url));

if (invokedAsEntryPoint) {
  const { exitCode, output } = runRoundLedger(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  process.exitCode = exitCode;
}
