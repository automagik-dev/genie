import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

const count = value => Number.isSafeInteger(value) && value >= 0;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const same = isDeepStrictEqual;

function ownedEvents(header, events, reportedCut, blockers) {
  const marker = events.findLastIndex(event => event.type === 'session/end-seed' && event.data.inherited === true);
  const cut = marker < 0 ? 0 : marker;
  if (header.isSeeded !== (marker >= 0) || reportedCut !== cut) {
    blockers.push('persisted inherited cut disagrees with canonical header/observation');
    return [];
  }
  // The tagged marker sits AT the cut and is child-owned, but is not a bill.
  return events.slice(cut).filter(event => event.type !== 'session/end-seed');
}

export function accountEvents(events, deriveTurnTokenUsage) {
  const blockers = [];
  const turns = [];
  const tools = new Map();
  const requests = [];
  let turn;
  for (const event of events) {
    if (event.type === 'tool/call') {
      const id = event.data.callId;
      if (typeof id !== 'string' || (tools.has(id) && !same(tools.get(id), event))) {
        blockers.push('invalid or conflicting model tool call identity');
      } else tools.set(id, event);
    }
    if (event.type === 'request/header') {
      requests.push({ seq: event.seq, config: event.data.header.config, adapterDefaults: event.data.header.adapterDefaults ?? null });
    }
    if (event.type === 'turn/start') {
      if (turn) blockers.push('overlapping durable turn boundaries');
      turn = [event];
    } else if (turn) {
      turn.push(event);
      if (event.type === 'turn/end') {
        const usage = deriveTurnTokenUsage(turn);
        if (!usage) blockers.push(`turn ${turn[0].data.turn} has incomplete/contradictory usage`);
        turns.push({ turn: turn[0].data.turn, startSeq: turn[0].seq, endSeq: event.seq, reason: event.data.reason ?? null, usage: usage ?? null });
        turn = undefined;
      }
    } else if (['assistant/message', 'assistant/attempt', 'step/start', 'llm/retry', 'llm/retry-started'].includes(event.type)) {
      blockers.push(`billing lifecycle ${event.type} lacks its owned turn/start`);
    }
  }
  if (turn) blockers.push('durable turn lacks turn/end (no cold synthesized closer accepted)');
  const usages = turns.map(item => item.usage);
  const summed = field => {
    if (usages.some(usage => !usage || !count(usage[field]))) return null;
    const result = usages.reduce((total, usage) => total + usage[field], 0);
    return count(result) ? result : null;
  };
  // A genuinely empty durable session with no requests/attempts proves no native inference.
  // Optional cache/reasoning buckets remain unknown even in that case.
  const totals = {
    totalTokens: blockers.length ? null : summed('totalTokens'),
    uncachedInputTokens: blockers.length ? null : summed('uncachedInputTokens'),
    outputTokens: blockers.length ? null : summed('outputTokens'),
    cacheReadTokens: usages.length ? summed('cacheReadTokens') : null,
    cacheWriteTokens: usages.length ? summed('cacheWriteTokens') : null,
    reasoningTokens: usages.length ? summed('reasoningTokens') : null,
  };
  if (requests.length && !turns.length) {
    blockers.push('request exists without complete billed turn');
    totals.totalTokens = totals.uncachedInputTokens = totals.outputTokens = null;
  }
  // request/header is assembled routing evidence, not proof of the served model.
  // Exact successful assistant source routes in deriveTurnTokenUsage are served evidence.
  const routes = [...new Map(usages.flatMap(usage => usage?.routes ?? []).map(route => [`${route.provider}\0${route.model}`, route])).values()];
  if (usages.some(usage => usage && !usage.routes)) blockers.push('one or more billed attempts lack served provider/model evidence');
  if (routes.some(route => route.provider !== 'deepseek-official' || route.model !== 'deepseek-flash')) {
    blockers.push('served native route is not deepseek-official/deepseek-flash');
  }
  return {
    totals, turns, requests, servedRoutes: routes, toolCalls: tools.size,
    modelToolCalls: [...tools.values()].map(event => ({ seq: event.seq, ...event.data })),
    attempts: events.filter(event => ['assistant/message', 'assistant/attempt'].includes(event.type)).map(event => ({ seq: event.seq, type: event.type, turn: event.data.turn, step: event.data.step })),
    retries: events.filter(event => ['llm/retry', 'llm/retry-started'].includes(event.type)),
    blockers,
  };
}

export async function reconcileSessions(ctx, sessionIds, deriveTurnTokenUsage) {
  const results = [];
  const globalBlockers = [];
  for (const session of ctx.sessions.list()) {
    try {
      if (!await ctx.sessions.flush(session)) globalBlockers.push(`session ${session.id} flush did not establish persistence`);
    } catch (error) { globalBlockers.push(`session ${session.id} flush failed: ${error.code ?? error.name}`); }
  }
  try { await ctx.sessionPersistence.flush(); }
  catch (error) { globalBlockers.push(`persistence barrier failed: ${error.code ?? error.name}`); }
  for (const id of sessionIds) {
    const blockers = [];
    let observation;
    let handle;
    try {
      observation = await ctx.sessionQuery.observeSession(id, { projectionMode: 'none' });
      handle = await ctx.sessionPersistence.open(id, 'read');
      const { events } = await handle.read();
      const header = handle.header;
      // Reconcile a public live/prepared observation against the actual durable handle.
      // A cold query may append interruption closers in memory; they are retained as
      // discrepancies, never folded into a persisted bill or invented boundary.
      if (!same(observation.header, header)) blockers.push('observation header differs from durable header');
      if (observation.inheritedEventCount !== handle.inheritedEventCount) blockers.push('observation inherited cut differs from durable cut');
      if (observation.events.length < events.length || !events.every((event, index) => same(event, observation.events[index]))) {
        blockers.push('observation does not match durable event prefix');
      }
      const seqs = new Map();
      for (const event of events) {
        if (!count(event.seq) || (seqs.has(event.seq) && !same(seqs.get(event.seq), event))) blockers.push('invalid/conflicting durable event sequence');
        seqs.set(event.seq, event);
      }
      const unique = [...seqs.values()].sort((a, b) => a.seq - b.seq);
      if (unique.some((event, index) => event.seq !== index)) blockers.push('durable event sequence is not contiguous');
      const own = ownedEvents(header, unique, handle.inheritedEventCount, blockers);
      const accounting = accountEvents(own, deriveTurnTokenUsage);
      results.push({
        sessionId: id, header, inheritedEventCount: handle.inheritedEventCount,
        observation: { source: observation.source, cursor: observation.cursor, revision: observation.revision ?? null, synthesizedSuffix: observation.events.slice(events.length) },
        durableEventCount: events.length, durableEventsSha256: hash(JSON.stringify(events)),
        ownEventCount: own.length, events: unique, accounting,
        blockers: [...blockers, ...accounting.blockers],
      });
    } catch (error) {
      results.push({ sessionId: id, accounting: null, blockers: [`canonical reconciliation failed: ${error.code ?? error.name}`] });
    } finally {
      observation?.[Symbol.dispose]();
      await handle?.close();
    }
  }
  return { sessions: results, blockers: globalBlockers };
}

async function filesWithin(root) {
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const paths = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) paths.push(...await filesWithin(path));
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) paths.push(path);
  }
  return paths;
}

export async function collectOffloads(roots, receiptRoot, launchSeals, traceId, enabled, engine, executionCalls) {
  const blockers = [];
  const attempts = new Map();
  const sources = [];
  for (const root of roots) {
    for (const path of await filesWithin(root)) {
      const bytes = await readFile(path);
      sources.push({ path, sha256: hash(bytes) });
      for (const line of bytes.toString('utf8').split('\n').filter(Boolean)) {
        let row;
        try { row = JSON.parse(line); }
        catch { blockers.push(`malformed offload ledger: ${path}`); continue; }
        if (row.traceId !== traceId) continue;
        if (typeof row.runId !== 'string' || !count(row.attempt)) {
          blockers.push(`invalid offload attempt identity: ${path}`); continue;
        }
        const key = `${row.runId}\0${row.attempt}`;
        if (attempts.has(key) && !same(attempts.get(key).row, row)) blockers.push('conflicting duplicate offload attempt');
        else attempts.set(key, { path, row });
      }
    }
  }
  const rows = [...attempts.values()];
  const nativeExecEvidence = executionCalls.filter(call => {
    if (call.name !== 'bash') return false;
    let args = call.arguments;
    if (typeof args === 'string') {
      try { args = JSON.parse(args); } catch { return false; }
    }
    const command = args?.command;
    return typeof command === 'string' && /(?:^|[;&|\n])\s*(?:genie\s+mikro\s+call|(?:bun|node)\s+(?:\S*\/)?scripts\/mikro\/call\.ts)(?:\s|$)/.test(command);
  });
  const sdkCalls = new Map();
  for (const filename of (await readdir(receiptRoot)).sort()) {
    const match = /^([a-f0-9-]+)\.(started|result)\.json$/.exec(filename);
    if (!match) continue;
    const path = join(receiptRoot, filename);
    const bytes = await readFile(path);
    let value;
    try { value = JSON.parse(bytes.toString('utf8')); }
    catch { blockers.push(`malformed real SDK sidecar: ${path}`); continue; }
    if (value.version !== 1 || value.id !== match[1] || typeof value.sessionId !== 'string') {
      blockers.push(`SDK sidecar identity/version mismatch: ${path}`); continue;
    }
    const pair = sdkCalls.get(value.id) ?? { id: value.id };
    pair[match[2]] = { path, sha256: hash(bytes), value };
    sdkCalls.set(value.id, pair);
  }
  const sdk = [...sdkCalls.values()];
  for (const pair of sdk) {
    const start = pair.started?.value;
    const result = pair.result?.value;
    if (!start || !result || start.sessionId !== result.sessionId || !same(start.binding, result.binding) || start.startedAt !== result.startedAt) {
      blockers.push(`incomplete/conflicting actual SDK lifecycle ${pair.id}`); continue;
    }
    const binding = result.binding;
    if (!binding || !launchSeals.some(seal => seal.kind === 'file' && seal.sha256 === binding.profileSha256)) {
      blockers.push(`SDK ${pair.id} does not bind a frozen arm profile`);
    }
    if (binding?.engine !== engine || binding?.model !== 'deepseek-flash') blockers.push(`SDK ${pair.id} route/treatment differs from frozen Flash arm`);
    const usage = result.observed?.usage;
    if (result.costKind !== 'sdk-nominal-estimate-not-invoice' || result.observed?.usageComplete !== true ||
        !usage || !count(usage.inputTokens) || !count(usage.outputTokens) || !Number.isFinite(usage.totalCost) || usage.totalCost < 0) {
      blockers.push(`SDK ${pair.id} usage/cost unknown or incomplete`);
    }
    const elapsed = Date.parse(result.finishedAt) - Date.parse(start.startedAt);
    if (!Number.isFinite(elapsed) || elapsed < 0) blockers.push(`SDK ${pair.id} duration unknown`);
    pair.durationMs = Number.isFinite(elapsed) && elapsed >= 0 ? elapsed : null;
    pair.modelEvidence = 'actual backend dispatch config binding; not a gateway response invoice';
  }
  for (const { row } of rows) {
    if (row.footer?.sessionId && sdk.filter(pair => pair.result?.value.sessionId === row.footer.sessionId).length !== 1) {
      blockers.push(`offload ledger ${row.runId}/${row.attempt} does not reconcile to one actual SDK session`);
    }
  }
  if (!enabled && (rows.length || sdk.length || nativeExecEvidence.length)) blockers.push('offload-off treatment executed an offload');
  if (enabled && (!nativeExecEvidence.length || !rows.length || !sdk.length)) blockers.push('enabled offload accounting unavailable; no proven command/caller/SDK lifecycle (wish numeric zero is not evidence)');
  if (rows.length !== sdk.length) blockers.push('caller attempts and actual SDK calls do not reconcile one-to-one');
  const usages = sdk.map(pair => pair.result?.value.observed?.usage);
  let fullyMeasured = sdk.length > 0 && blockers.length === 0;
  const sum = field => usages.reduce((total, usage) => total + usage[field], 0);
  const optional = field => usages.length && usages.every(usage => usage && count(usage[field])) ? sum(field) : null;
  if (fullyMeasured && (!count(sum('inputTokens')) || !count(sum('outputTokens')) || !Number.isFinite(sum('totalCost')))) {
    blockers.push('SDK aggregate exceeds safe exact numeric accounting range');
    fullyMeasured = false;
  }
  return {
    enabled, traceId, sources, attempts: rows, sdkCalls: sdk, executableEvidence: nativeExecEvidence,
    nominalFooter: rows.length && rows.every(({ row }) => row.footer && count(row.footer.tokensIn) && count(row.footer.tokensOut) && Number.isFinite(row.footer.cost)) ? {
      tokensIn: rows.reduce((total, { row }) => total + row.footer.tokensIn, 0),
      tokensOut: rows.reduce((total, { row }) => total + row.footer.tokensOut, 0),
      costUsd: rows.reduce((total, { row }) => total + row.footer.cost, 0),
      basis: 'actual MCP rounded footer; not invoice; preserve per-attempt priceBasis',
    } : null,
    sdkUsage: fullyMeasured ? {
      inputTokens: sum('inputTokens'), outputTokens: sum('outputTokens'),
      // Backend input convention is retained verbatim; do not re-add cache or reasoning.
      cacheReadTokens: optional('cacheReadTokens'), cacheWriteTokens: optional('cacheWriteTokens'),
      reasoningTokens: optional('reasoningTokens'),
    } : null,
    sdkNominalCostUsd: fullyMeasured ? sum('totalCost') : null,
    costKind: 'sdk-nominal-estimate-not-invoice', gatewayInvoice: null, keeperAggregate: null,
    disabledEvidence: !enabled && rows.length === 0 && sdk.length === 0 && nativeExecEvidence.length === 0 ? 'frozen offload:false; reconciled own native tool calls and owned caller/SDK receipt roots contain no offloads' : null,
    blockers,
  };
}

// Producer-side projection for the unchanged wish report's two cost fields.
// Every paid caller attempt (including earlier repair reviews and rescued retries)
// contributes once. Original model-reported savedResult remains separate evidence.
export function projectReportResult(savedResult, offload) {
  const blockers = [];
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const finiteNonnegative = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
  if (!object(savedResult) || !object(offload) || typeof offload.enabled !== 'boolean' || !Array.isArray(offload.attempts) || !Array.isArray(offload.sdkCalls)) {
    return { result: null, projection: null, blockers: ['report offload projection lacks saved result/caller/SDK evidence'] };
  }
  if (!Array.isArray(offload.blockers) || offload.blockers.length) {
    return { result: null, projection: null, blockers: ['report offload projection requires complete reconciled accounting'] };
  }
  const stages = new Map();
  const attemptIds = new Set();
  const claimedSdkIds = new Set();
  for (const entry of offload.attempts) {
    const row = entry?.row;
    const footer = row?.footer;
    if (!object(row) || typeof row.runId !== 'string' || !count(row.attempt) || typeof row.ok !== 'boolean') {
      blockers.push('report offload projection has an invalid caller attempt'); continue;
    }
    const key = `${row.runId}\0${row.attempt}`;
    if (attemptIds.has(key)) { blockers.push('report offload projection has duplicate caller attempt'); continue; }
    attemptIds.add(key);
    const stage = row.tags?.stage;
    const expectedAgent = stage === 'scout' ? 'wish-context' : stage === 'review' ? 'review-prep' : null;
    if (!expectedAgent || row.agent !== expectedAgent || row.traceId !== offload.traceId || row.tags?.slug !== offload.traceId) {
      blockers.push(`report offload ${row.runId}/${row.attempt} has unknown/conflicting stage attribution`); continue;
    }
    if (!object(footer) || typeof footer.sessionId !== 'string' || !footer.sessionId ||
        !count(footer.tokensIn) || !count(footer.tokensOut) || !finiteNonnegative(footer.cost) ||
        !finiteNonnegative(footer.seconds) || typeof row.priceBasis !== 'string' || !row.priceBasis) {
      blockers.push(`report offload ${row.runId}/${row.attempt} has unknown rounded-footer pricing`); continue;
    }
    const matches = offload.sdkCalls.filter(pair => pair.result?.value.sessionId === footer.sessionId);
    if (matches.length !== 1) { blockers.push(`report offload ${key} lacks exactly one matched SDK session`); continue; }
    const pair = matches[0];
    const sdk = pair.result.value;
    const usage = sdk.observed?.usage;
    if (typeof pair.id !== 'string' || claimedSdkIds.has(pair.id)) {
      blockers.push('report offload projection duplicates an SDK call'); continue;
    }
    claimedSdkIds.add(pair.id);
    if (!object(usage) || sdk.observed?.usageComplete !== true || sdk.costKind !== 'sdk-nominal-estimate-not-invoice' ||
        usage.inputTokens !== footer.tokensIn || usage.outputTokens !== footer.tokensOut ||
        !finiteNonnegative(usage.totalCost) || typeof sdk.failed !== 'boolean' || (row.ok && sdk.failed)) {
      blockers.push(`report offload ${key} disagrees with complete actual SDK receipt`); continue;
    }
    // These are the existing MCP formatter's rounding rules, used only to detect
    // inconsistent receipts. Report prices remain the observed footer values.
    const roundedSdkCost = usage.totalCost <= 0 ? 0 : Number(usage.totalCost.toFixed(usage.totalCost < 0.01 ? 4 : 2));
    const sdkModel = `${sdk.binding?.provider}/${sdk.binding?.model}`;
    if (footer.cost !== roundedSdkCost || footer.model !== sdkModel) {
      blockers.push(`report offload ${key} footer price/model differs from matched SDK receipt`); continue;
    }
    const grouped = stages.get(stage) ?? { agent: expectedAgent, attempts: [], runs: new Map() };
    grouped.attempts.push({ runId: row.runId, attempt: row.attempt, sessionId: footer.sessionId, sdkCallId: pair.id, model: footer.model, priceBasis: row.priceBasis, costUsd: footer.cost, seconds: footer.seconds });
    const previous = grouped.runs.get(row.runId);
    if (!previous || previous.attempt < row.attempt) grouped.runs.set(row.runId, { attempt: row.attempt, ok: row.ok });
    stages.set(stage, grouped);
  }
  if (claimedSdkIds.size !== offload.sdkCalls.length || offload.attempts.length !== offload.sdkCalls.length) blockers.push('report offload projection does not cover all actual caller/SDK attempts exactly once');
  if (offload.enabled === false && (offload.attempts.length || offload.sdkCalls.length || !offload.disabledEvidence)) blockers.push('report offload-off projection lacks measured absence evidence');
  if (offload.enabled === true && !offload.attempts.length) blockers.push('report enabled offload pricing is unknown, not zero');
  const fields = {};
  const attribution = {};
  for (const [stage, grouped] of stages) {
    const costUsd = grouped.attempts.reduce((sum, attempt) => sum + attempt.costUsd, 0);
    const seconds = grouped.attempts.reduce((sum, attempt) => sum + attempt.seconds, 0);
    if (!finiteNonnegative(costUsd) || !finiteNonnegative(seconds)) blockers.push(`report ${stage} aggregate pricing/duration is unsafe`);
    fields[stage] = { agent: grouped.agent, ok: [...grouped.runs.values()].every(run => run.ok), notReported: false, costUsd, seconds, usedFacts: null, usedFiles: null };
    attribution[stage] = { attempts: grouped.attempts, priceBases: [...new Set(grouped.attempts.map(attempt => attempt.priceBasis))] };
  }
  if (blockers.length) return { result: null, projection: null, blockers };
  const review = object(savedResult.review) ? { ...savedResult.review, mikro: fields.review ?? null } : fields.review ? { mikro: fields.review } : savedResult.review ?? null;
  const result = { ...savedResult, scoutMikro: fields.scout ?? null, review };
  return { result, projection: { basis: 'all reconciled caller attempts; actual MCP rounded-footer pricing, not SDK repricing or invoice', stages: attribution }, blockers };
}
