export const meta = {
  name: 'council',
  description: 'Convene a lens council: deliberate a decision, or audit the repo across specialist lanes.',
  phases: [
    { title: 'Resolve' },
    { title: 'Round 1' },
    { title: 'Round 2' },
    { title: 'Synthesis' },
    { title: 'Persist' },
  ],
};

// The /council workflow engine. Two modes over one shared lens library:
//   deliberation — Resolve -> Round 1 -> Round 2 -> Synthesis (advisory, writes nothing)
//   audit        — Resolve -> Round 1 -> Synthesis -> Persist (assess-only; single writer merges the profile)
//
// This template ships inside the genie plugin. LENS_ROOT is a placeholder that
// the install-time stamp (scripts/council-stamp.cjs) rewrites to the absolute
// installed-plugin path before the file lands in ~/.claude/workflows/council.js.
// All file access happens inside spawned agents (Read/Glob/Bash/Write); the
// script itself touches no filesystem and no Node globals, so runs stay resumable.

const LENS_ROOT = '__GENIE_LENS_ROOT__';

// Lens name -> path relative to LENS_ROOT. Seven audit lanes (persona skills,
// reached through the plugin's `skills` symlink) plus six deliberation cards.
const LENSES = {
  'repo-hygiene': 'skills/repo-hygiene/SKILL.md',
  architecture: 'skills/architecture/SKILL.md',
  'code-quality': 'skills/code-quality/SKILL.md',
  qa: 'skills/qa/SKILL.md',
  perf: 'skills/perf/SKILL.md',
  'supply-chain': 'skills/supply-chain/SKILL.md',
  'dx-docs': 'skills/dx-docs/SKILL.md',
  questioner: 'references/lenses/questioner.md',
  simplifier: 'references/lenses/simplifier.md',
  operator: 'references/lenses/operator.md',
  deployer: 'references/lenses/deployer.md',
  measurer: 'references/lenses/measurer.md',
  tracer: 'references/lenses/tracer.md',
};

// Keyword routing for deliberation, absorbed from the old council's routing table.
// The four retired council lenses are remapped onto lanes: benchmarker -> perf,
// sentinel -> supply-chain, ergonomist -> dx-docs, architect -> architecture.
const ROUTING = [
  {
    keywords: ['architecture', 'design', 'system', 'interface', 'api'],
    members: ['questioner', 'architecture', 'simplifier', 'perf'],
  },
  {
    keywords: ['performance', 'latency', 'throughput', 'scale'],
    members: ['perf', 'questioner', 'architecture', 'measurer'],
  },
  { keywords: ['security', 'auth', 'secret', 'blast radius'], members: ['questioner', 'supply-chain', 'simplifier'] },
  { keywords: ['endpoint', 'dx', 'developer', 'sdk'], members: ['questioner', 'simplifier', 'dx-docs', 'deployer'] },
  {
    keywords: ['ops', 'deploy', 'infra', 'ci/cd', 'monitoring'],
    members: ['operator', 'deployer', 'tracer', 'measurer'],
  },
  { keywords: ['debug', 'trace', 'observability', 'logging'], members: ['tracer', 'measurer', 'perf'] },
  { keywords: ['plan', 'scope', 'wish', 'feature'], members: ['questioner', 'simplifier', 'architecture', 'dx-docs'] },
];

// Default trio when no keyword matches: wrong-problem, over-engineering, short-term thinking.
const DEFAULT_TRIO = ['questioner', 'simplifier', 'architecture'];

// Audit default roster: the seven specialist lanes.
const AUDIT_ROSTER = ['repo-hygiene', 'architecture', 'code-quality', 'qa', 'perf', 'supply-chain', 'dx-docs'];

const SEVERITY = ['critical', 'high', 'medium', 'low'];

const RESOLVE_SCHEMA = {
  type: 'object',
  required: ['resolved', 'missing'],
  properties: {
    resolved: {
      type: 'array',
      items: {
        type: 'object',
        required: ['name', 'absPath'],
        properties: { name: { type: 'string' }, absPath: { type: 'string' } },
      },
    },
    missing: {
      type: 'array',
      items: {
        type: 'object',
        required: ['name', 'relPath'],
        properties: { name: { type: 'string' }, relPath: { type: 'string' } },
      },
    },
  },
};

const R1_DELIBERATION_SCHEMA = {
  type: 'object',
  required: ['member', 'position', 'assumptions'],
  properties: {
    member: { type: 'string' },
    position: { type: 'string', description: '2-4 opinionated paragraphs' },
    assumptions: { type: 'array', items: { type: 'string' } },
  },
};

const FINDING_SCHEMA = {
  type: 'object',
  required: ['severity', 'summary', 'evidence', 'action'],
  properties: {
    severity: { type: 'string', enum: SEVERITY },
    summary: { type: 'string' },
    evidence: { type: 'string', description: 'file:line or command + its output' },
    action: { type: 'string' },
  },
};

const PROFILE_UPDATE_SCHEMA = {
  type: 'object',
  required: ['anchor', 'change', 'note'],
  properties: {
    anchor: { type: 'string' },
    change: { type: 'string', enum: ['new', 'changed', 'invalidated'] },
    note: { type: 'string' },
  },
};

const R1_AUDIT_SCHEMA = {
  type: 'object',
  required: ['lane', 'verdict', 'findings', 'verifiedSound', 'couldNotVerify', 'profileUpdates'],
  properties: {
    lane: { type: 'string' },
    verdict: { type: 'string', description: 'one-sentence lane verdict' },
    findings: { type: 'array', items: FINDING_SCHEMA },
    verifiedSound: { type: 'string' },
    couldNotVerify: { type: 'string' },
    profileUpdates: { type: 'array', items: PROFILE_UPDATE_SCHEMA },
  },
};

const R2_SCHEMA = {
  type: 'object',
  required: ['member', 'strongestOther', 'challenge', 'changed', 'evolution'],
  properties: {
    member: { type: 'string' },
    strongestOther: { type: 'string' },
    challenge: { type: 'string' },
    changed: { type: 'boolean' },
    evolution: { type: 'string' },
  },
};

const SYNTH_DELIBERATION_SCHEMA = {
  type: 'object',
  required: ['executiveSummary', 'consensus', 'tensions', 'evolution', 'recommendations', 'dissent'],
  properties: {
    executiveSummary: { type: 'string' },
    consensus: { type: 'array', items: { type: 'string' } },
    tensions: { type: 'array', items: { type: 'string' } },
    evolution: { type: 'string' },
    recommendations: {
      type: 'array',
      items: {
        type: 'object',
        required: ['priority', 'recommendation', 'rationale', 'risk'],
        properties: {
          priority: { type: 'string', enum: ['P0', 'P1', 'P2'] },
          recommendation: { type: 'string' },
          rationale: { type: 'string' },
          risk: { type: 'string' },
        },
      },
    },
    dissent: { type: 'string', description: 'minority views preserved verbatim' },
  },
};

const SYNTH_AUDIT_SCHEMA = {
  type: 'object',
  required: ['verdict', 'laneVerdicts', 'topFindings', 'notFullyAudited'],
  properties: {
    verdict: { type: 'string', description: 'one-sentence overall verdict' },
    laneVerdicts: {
      type: 'array',
      items: {
        type: 'object',
        required: ['lane', 'verdict'],
        properties: { lane: { type: 'string' }, verdict: { type: 'string' } },
      },
    },
    topFindings: {
      type: 'array',
      maxItems: 10,
      items: {
        type: 'object',
        required: ['lanes', 'severity', 'summary', 'evidence', 'action'],
        properties: {
          lanes: { type: 'array', items: { type: 'string' } },
          severity: { type: 'string', enum: SEVERITY },
          summary: { type: 'string' },
          evidence: { type: 'string' },
          action: { type: 'string' },
        },
      },
    },
    notFullyAudited: { type: 'array', items: { type: 'string' } },
  },
};

const PERSIST_SCHEMA = {
  type: 'object',
  required: ['written', 'path'],
  properties: {
    written: { type: 'boolean' },
    path: { type: 'string' },
    note: { type: 'string' },
  },
};

function failure(error, detail) {
  return detail === undefined ? { ok: false, error } : { ok: false, error, detail };
}

function dedupe(names) {
  return [...new Set(names)];
}

// Best-match routing: the row with the most keyword hits wins; ties break by order.
function classifyMembers(topic) {
  const hay = topic.toLowerCase();
  let best = null;
  let bestScore = 0;
  for (const row of ROUTING) {
    let score = 0;
    for (const kw of row.keywords) {
      if (hay.includes(kw)) score += 1;
    }
    if (score > bestScore) {
      bestScore = score;
      best = row;
    }
  }
  return best ? best.members.slice() : DEFAULT_TRIO.slice();
}

// A `members` override bypasses routing. Unknown names are logged and ignored;
// if nothing valid survives, fall back to the mode's default roster.
function selectRoster(mode, topic, membersArg) {
  if (Array.isArray(membersArg) && membersArg.length) {
    const valid = [];
    for (const raw of membersArg) {
      const name = typeof raw === 'string' ? raw.trim() : '';
      if (name && Object.hasOwn(LENSES, name)) {
        valid.push(name);
      } else if (name) {
        log(`Ignoring unknown member "${name}" — not in the lens library.`);
      }
    }
    if (valid.length) return dedupe(valid);
    log('Members override had no known lenses — using the default roster.');
  }
  if (mode === 'audit') return AUDIT_ROSTER.slice();
  return classifyMembers(topic);
}

function rosterPaths(names) {
  return names.map((name) => ({ name, relPath: LENSES[name] }));
}

function collectProfileUpdates(responded) {
  const out = [];
  for (const entry of responded) {
    const ups = entry.response && Array.isArray(entry.response.profileUpdates) ? entry.response.profileUpdates : [];
    for (const u of ups) out.push({ lane: entry.member, anchor: u.anchor, change: u.change, note: u.note });
  }
  return out;
}

function resolvePrompt(wanted) {
  const lines = wanted.map((w) => `- ${w.name}: ${w.relPath}`).join('\n');
  return [
    'You are the council stage-0 lens resolver. Keep effort low: verify files, do not read or apply them.',
    '',
    `LENS_ROOT (the installed genie plugin directory): ${LENS_ROOT}`,
    '',
    'Roster to resolve (lens name -> path relative to LENS_ROOT):',
    lines,
    '',
    'For each entry, confirm the lens file exists on disk:',
    '1. First try LENS_ROOT joined with the relative path (use Read or Glob).',
    '2. If NONE of them exist under LENS_ROOT, the stamped root is stale. Glob your home',
    '   ".claude" tree for the marker "**/plugins/**/references/lenses/questioner.md", take the',
    '   plugin root (the directory two levels above "references/lenses"), and re-resolve every',
    '   relative path against that discovered root instead.',
    '',
    'Return the schema object only: resolved = [{name, absPath}] for files that exist (absolute',
    'paths), missing = [{name, relPath}] for files you could not find anywhere. A missing lens is',
    'reported, never silently dropped.',
  ].join('\n');
}

function round1DeliberationPrompt(member, topic) {
  return [
    `You are the council's ${member.name} lens. Read your lens file at ${member.absPath} and adopt its voice and method.`,
    '',
    'Council topic:',
    topic,
    '',
    'Deliver an opinionated Round 1 position: 2-4 paragraphs that take clear positions and name the',
    'assumptions behind them. Ground each claim in your expertise or cite the evidence you would need.',
    "Do not retreat into neutrality — the council's value is distinct, committed perspectives.",
    '',
    `Return the schema object: member = "${member.name}", position = your 2-4 paragraphs, assumptions = the named assumptions.`,
  ].join('\n');
}

function round1AuditPrompt(member, focus) {
  const target = focus ? focus : 'the whole repository at the current working directory';
  return [
    `You are the ${member.name} audit lane. Read your lens file at ${member.absPath} and follow its`,
    'methodology exactly, including its ground-truth discovery step.',
    '',
    `Audit target: ${target}.`,
    '',
    'You are strictly assess-only for this run: make NO edits and do NOT write the repo profile —',
    "return your profile updates as data instead. Run the lens's real commands and measurements",
    '(Bash/Read/Glob). Rank findings by severity. For each finding give: severity',
    '(critical/high/medium/low), a one-sentence summary, evidence (file:line or a command plus its',
    'output), and a recommended action. Also give a one-sentence lane verdict, what you verified as',
    'sound, and what you could not verify.',
    '',
    `Return the schema object: lane = "${member.name}", verdict, findings[], verifiedSound,`,
    'couldNotVerify, and profileUpdates[] (knowledge anchors you would change — as data; you write nothing).',
  ].join('\n');
}

function round2Prompt(self, others, topic) {
  const otherBlocks = others.map((o) => `### ${o.member}\n${o.response.position}`).join('\n\n');
  return [
    `You are the council's ${self.member} lens in Round 2 of a deliberation. You already delivered a`,
    "Round 1 position; the other members' positions follow, attributed by name.",
    '',
    'Council topic:',
    topic,
    '',
    'YOUR Round 1 position:',
    self.response.position,
    '',
    "OTHER MEMBERS' Round 1 positions:",
    otherBlocks,
    '',
    'Reply, staying in your lens voice, with: (1) the single strongest point another member made,',
    '(2) at least one point you challenge or refine, and (3) whether your position changed and why.',
    '',
    `Return the schema object: member = "${self.member}", strongestOther, challenge, changed (boolean), evolution.`,
  ].join('\n');
}

function synthesisDeliberationPrompt(topic, responded, round2) {
  const r2by = {};
  for (const r of round2) {
    if (r.response) r2by[r.member] = r.response;
  }
  const blocks = responded
    .map((x) => {
      const r2 = r2by[x.member];
      const r2text = r2
        ? `${r2.evolution} (challenge: ${r2.challenge}; strongest other: ${r2.strongestOther})`
        : 'no Round 2 response';
      return `### ${x.member}\nRound 1:\n${x.response.position}\n\nRound 2:\n${r2text}`;
    })
    .join('\n\n');
  return [
    'You are the council synthesizer. You did not deliberate; you integrate the members into one',
    'advisory report. Advisory only — no voting, no verdict, no gate-keeping language. Preserve',
    "minority views in the members' own words.",
    '',
    'Council topic:',
    topic,
    '',
    'Members and their two rounds:',
    blocks,
    '',
    'Produce: an executive summary (2-3 sentences); the points of consensus; the key tensions and',
    'unresolved disagreements; how thinking evolved between rounds; prioritized recommendations',
    '(P0/P1/P2, each with rationale and the risk if ignored); and a Dissent section that preserves',
    'minority views verbatim.',
    '',
    'Return the schema object: executiveSummary, consensus[], tensions[], evolution, recommendations[], dissent.',
  ].join('\n');
}

function synthesisAuditPrompt(focus, responded, silentRound1, notConvened) {
  const target = focus ? focus : 'the whole repository';
  const blocks = responded
    .map((x) => {
      const r = x.response;
      return [
        `### ${x.member} (verdict: ${r.verdict})`,
        `Findings: ${JSON.stringify(r.findings)}`,
        `Verified sound: ${r.verifiedSound}`,
        `Could not verify: ${r.couldNotVerify}`,
      ].join('\n');
    })
    .join('\n\n');
  const silent = silentRound1.length ? silentRound1.join(', ') : '(none)';
  const absent = notConvened.length ? notConvened.join(', ') : '(none)';
  return [
    'You are the panel synthesizer. Integrate the lanes into ONE cross-cutting report. Advisory only:',
    'approved findings route to /wish — there is no approval mechanism here.',
    '',
    `Audit target: ${target}.`,
    '',
    'Lane outputs:',
    blocks,
    '',
    `Lanes that resolved but returned NOTHING this run: ${silent}.`,
    `Lenses that never convened (lens file did not resolve): ${absent}.`,
    'These lanes were NOT audited: never average them into a finding or verdict, and never imply the',
    'area they cover is clean. They are surfaced separately in the report, so do NOT list them in',
    'notFullyAudited[] — reserve that array for lanes that DID respond but whose coverage is partial.',
    '',
    'Do the synthesis work: (1) DEDUPE — when the same fact appears in multiple lanes, merge it into',
    'one finding that names every lane it came from; (2) RESOLVE CONFLICTS — when lanes disagree,',
    'present both judgments with their evidence and recommend one side, saying why; (3) RE-RANK',
    "GLOBALLY by real risk across lanes, not per-lane labels — a lane's high may be the panel's",
    'medium; (4) keep only the top findings (at most 10); (5) flag any responding lane whose audit',
    'was not fully completed — never silently average it in.',
    '',
    'Return the schema object: verdict (one sentence), laneVerdicts[], topFindings[] (<=10, each',
    'naming its lane(s), severity, summary, evidence, action), notFullyAudited[].',
  ].join('\n');
}

function persistPrompt(updates) {
  return [
    'You are the panel single profile writer. Merge the knowledge updates below into the repo profile',
    'at <repo>/.genie/repo-profile.md, where <repo> is the toplevel of the current git repository',
    '(resolve it with `git rev-parse --show-toplevel`). Create the file if it does not exist. You are',
    'the ONLY writer this run, so there is no conflict to reconcile — apply every update.',
    '',
    'These are knowledge anchors (new / changed / invalidated), NOT fixes. Do not modify any source',
    'file; write only the profile.',
    '',
    'Updates:',
    JSON.stringify(updates, null, 2),
    '',
    'Merge rules: a "new" anchor is added; a "changed" anchor replaces the prior note for that anchor;',
    'an "invalidated" anchor is removed. Keep the profile concise and de-duplicated.',
    '',
    'Return the schema object: written (boolean), path (the profile path you wrote), note (one line on what changed).',
  ].join('\n');
}

function renderDeliberation(topic, convened, notConvened, synth) {
  const composition = convened.map((c) => `- ${c.name}`).join('\n');
  const consensus = synth.consensus.length ? synth.consensus.map((c) => `- ${c}`).join('\n') : '- (none recorded)';
  const tensions = synth.tensions.length ? synth.tensions.map((t) => `- ${t}`).join('\n') : '- (none recorded)';
  const recs = synth.recommendations
    .map((r) => `| ${r.priority} | ${r.recommendation} | ${r.rationale} | ${r.risk} |`)
    .join('\n');
  const missing = notConvened.length ? `\n\n_Not convened (lens file missing): ${notConvened.join(', ')}_` : '';
  return [
    `# Council Report: ${topic}`,
    '',
    '## Executive Summary',
    synth.executiveSummary,
    '',
    '## Council Composition',
    composition,
    '',
    '## Consensus',
    consensus,
    '',
    '## Tensions',
    tensions,
    '',
    '## Evolution',
    synth.evolution,
    '',
    '## Recommendations',
    '| Priority | Recommendation | Rationale | Risk if ignored |',
    '| --- | --- | --- | --- |',
    recs,
    '',
    '## Dissent',
    synth.dissent,
    `${missing}`,
  ].join('\n');
}

function renderAudit(focus, notConvened, silentRound1, synth, persist) {
  const target = focus ? focus : 'whole repository';
  const laneVerdicts = synth.laneVerdicts.map((l) => `- **${l.lane}** — ${l.verdict}`).join('\n');
  const findings = synth.topFindings
    .map(
      (f, i) =>
        `${i + 1}. **[${f.severity}]** (${f.lanes.join(', ')}) ${f.summary}\n   - Evidence: ${f.evidence}\n   - Action: ${f.action}`,
    )
    .join('\n');
  // A lane that returned nothing, or a lens that never convened, is reported "not audited" here —
  // never silently dropped and never averaged in. Merge the synthesizer's partial-coverage list
  // with the code-known silent lanes and unresolved lenses.
  const notAuditedEntries = [
    ...synth.notFullyAudited,
    ...silentRound1.map((n) => `${n} (resolved but returned nothing)`),
    ...notConvened.map((n) => `${n} (lens file missing)`),
  ];
  const notAudited = notAuditedEntries.length
    ? notAuditedEntries.map((n) => `- ${n}`).join('\n')
    : '- (all convened lanes fully audited)';
  const profile = persist?.written
    ? `Profile updated at ${persist.path}${persist.note ? ` — ${persist.note}` : ''}.`
    : 'No profile updates persisted.';
  return [
    `# Council Audit: ${target}`,
    '',
    '## Verdict',
    synth.verdict,
    '',
    '## Lane Verdicts',
    laneVerdicts,
    '',
    '## Top Findings',
    findings,
    '',
    '## Not Fully Audited',
    notAudited,
    '',
    '## Profile',
    profile,
    '',
    '_Findings are advisory. Route the ones you approve into a wish via /wish._',
  ].join('\n');
}

if (!args || typeof args !== 'object') {
  return failure('No input received. Try /council <topic> to deliberate, or /council audit [focus] to audit.');
}

const mode = args.mode === 'audit' ? 'audit' : 'deliberation';
const topic = typeof args.topic === 'string' ? args.topic.trim() : '';
const focus = typeof args.focus === 'string' ? args.focus.trim() : '';

if (mode === 'deliberation' && !topic) {
  return failure('No topic to deliberate. Try /council <topic>.');
}

const roster = selectRoster(mode, topic, args.members);
if (!roster.length) {
  return failure('No lenses selected. Provide --members, or a topic that routes to a lens.');
}
log(`Mode: ${mode}. Roster: ${roster.join(', ')}.`);

// Phase 1 — Resolve lens files on disk (fail-open: a stale LENS_ROOT is rediscovered by the agent).
phase('Resolve');
const resolveResult = await agent(resolvePrompt(rosterPaths(roster)), {
  label: 'resolve-lenses',
  phase: 'Resolve',
  effort: 'low',
  schema: RESOLVE_SCHEMA,
});
if (!resolveResult || !Array.isArray(resolveResult.resolved) || resolveResult.resolved.length < 2) {
  return failure('Fewer than two lenses resolved on disk — cannot convene the council.', {
    requested: roster,
    resolveResult,
  });
}
const convened = resolveResult.resolved;
const notConvened = (resolveResult.missing || []).map((m) => m.name);
if (notConvened.length) log(`Not convened (lens file missing): ${notConvened.join(', ')}.`);

// Phase 2 — Round 1: every convened lens delivers in parallel.
phase('Round 1');
const round1Raw = await parallel(
  convened.map(
    (member) => () =>
      agent(mode === 'audit' ? round1AuditPrompt(member, focus) : round1DeliberationPrompt(member, topic), {
        label: `round1-${member.name}`,
        phase: 'Round 1',
        schema: mode === 'audit' ? R1_AUDIT_SCHEMA : R1_DELIBERATION_SCHEMA,
      }),
  ),
);
const round1 = convened.map((member, i) => ({
  member: member.name,
  absPath: member.absPath,
  response: round1Raw[i],
}));
const responded = round1.filter((x) => x.response);
const silentRound1 = round1.filter((x) => !x.response).map((x) => x.member);
if (silentRound1.length) log(`No Round 1 response: ${silentRound1.join(', ')}.`);
if (responded.length < 2) {
  return failure('Fewer than two lenses delivered Round 1 — the council cannot proceed.', {
    silent: silentRound1,
    notConvened,
  });
}

// Phase 3 — Round 2: deliberation only, one fresh agent per responding member.
phase('Round 2');
let round2 = [];
if (mode === 'deliberation') {
  const round2Raw = await parallel(
    responded.map(
      (self) => () =>
        agent(
          round2Prompt(
            self,
            responded.filter((o) => o.member !== self.member),
            topic,
          ),
          {
            label: `round2-${self.member}`,
            phase: 'Round 2',
            schema: R2_SCHEMA,
          },
        ),
    ),
  );
  round2 = responded.map((self, i) => ({ member: self.member, response: round2Raw[i] }));
  const silentRound2 = round2.filter((r) => !r.response).map((r) => r.member);
  if (silentRound2.length) log(`No Round 2 response: ${silentRound2.join(', ')}.`);
} else {
  log('Round 2 skipped — audit mode is single-round.');
}

// Phase 4 — Synthesis: one agent integrates everything into an advisory report.
phase('Synthesis');
const synthesis = await agent(
  mode === 'audit'
    ? synthesisAuditPrompt(focus, responded, silentRound1, notConvened)
    : synthesisDeliberationPrompt(topic, responded, round2),
  {
    label: 'synthesis',
    phase: 'Synthesis',
    schema: mode === 'audit' ? SYNTH_AUDIT_SCHEMA : SYNTH_DELIBERATION_SCHEMA,
  },
);
if (!synthesis) {
  return failure('Synthesis returned nothing usable.', { round1Responders: responded.length });
}

// Phase 5 — Persist: audit only, a single writer merges lane profile updates.
phase('Persist');
let persist = null;
if (mode === 'audit') {
  const updates = collectProfileUpdates(responded);
  if (updates.length) {
    persist = await agent(persistPrompt(updates), {
      label: 'persist-profile',
      phase: 'Persist',
      effort: 'low',
      schema: PERSIST_SCHEMA,
    });
  } else {
    log('No profile updates returned by the lanes — nothing to persist.');
  }
} else {
  log('Persist skipped — deliberation writes nothing.');
}

const markdown =
  mode === 'audit'
    ? renderAudit(focus, notConvened, silentRound1, synthesis, persist)
    : renderDeliberation(topic, convened, notConvened, synthesis);

return {
  ok: true,
  mode,
  topic: mode === 'deliberation' ? topic : undefined,
  focus: mode === 'audit' ? focus || 'whole repository' : undefined,
  convened: convened.map((c) => c.name),
  notConvened,
  silentRound1,
  responders: responded.map((r) => r.member),
  synthesis,
  persist,
  markdown,
};
