export const meta = {
  name: 'council',
  description: 'Pressure-test a decision through five independent lenses, then synthesize a decision (assess-only)',
  whenToUse:
    'A consequential decision benefits from independent scrutiny. Pass the decision as a string, or {decision, constraints?, evidence?, unknowns?}. Advisory: nothing is mutated.',
  phases: [
    { title: 'Lenses', detail: 'architecture, delivery, product, security, dissent — same brief, no cross-talk' },
    { title: 'Synthesis', detail: 'one synthesizer integrates the lenses without manufacturing consensus' },
  ],
}

// The first canonical entry of genie's `.claude/workflows/` catalog. It mirrors
// skills/council/SKILL.md: five lenses answer the same brief independently and
// in parallel, then one synthesizer produces the decision block. Everything the
// script needs arrives through `args`; there are no lens files and no paths.

const LENSES = [
  {
    key: 'architecture',
    brief: 'Assess contracts, coupling, failure modes, operability, and long-term cost.',
  },
  {
    key: 'delivery',
    brief: 'Assess sequencing, testability, migration, rollback, and the evidence required to ship.',
  },
  {
    key: 'product',
    brief: 'Assess user value, usability, scope discipline, and compatibility.',
  },
  {
    key: 'security',
    brief: 'Assess trust boundaries, permissions, data exposure, and abuse cases.',
  },
  {
    key: 'dissent',
    brief:
      'Make the strongest evidence-backed case AGAINST the decision as stated, whatever the other lenses would say. If you cannot find one, say so and explain why.',
  },
]

const LENS_SCHEMA = {
  type: 'object',
  required: ['verdict', 'confidence', 'keyEvidence', 'risks', 'conditions', 'unknowns'],
  properties: {
    verdict: { type: 'string', enum: ['support', 'support-with-conditions', 'oppose', 'insufficient-evidence'] },
    confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
    keyEvidence: { type: 'array', items: { type: 'string' } },
    risks: { type: 'array', items: { type: 'string' }, description: 'risks or objections' },
    conditions: { type: 'array', items: { type: 'string' }, description: 'required conditions' },
    unknowns: { type: 'array', items: { type: 'string' } },
  },
}

const SYNTHESIS_SCHEMA = {
  type: 'object',
  required: ['decision', 'consensus', 'dissent', 'conditions', 'evidenceGaps', 'nextAction', 'conflictResolution'],
  properties: {
    decision: { type: 'string', enum: ['proceed', 'proceed-with-conditions', 'revise', 'stop', 'gather-evidence'] },
    consensus: { type: 'string', description: 'where the lenses agree' },
    dissent: {
      type: 'array',
      items: {
        type: 'object',
        required: ['lens', 'position'],
        properties: { lens: { type: 'string' }, position: { type: 'string' } },
      },
      description: 'minority positions, attributed by lens, never deleted because the majority agrees',
    },
    conditions: { type: 'array', items: { type: 'string' }, description: 'concrete prerequisites' },
    evidenceGaps: { type: 'array', items: { type: 'string' }, description: 'unknowns that could change the decision' },
    nextAction: { type: 'string', description: 'one bounded next step' },
    conflictResolution: { type: 'string', description: 'how conflicts between lenses were resolved' },
  },
}

// Accept a plain string (the decision) or an object; JSON strings are parsed.
function normalizeInput(raw) {
  let input = raw
  if (typeof input === 'string') {
    const text = input.trim()
    let parsed = null
    try {
      parsed = JSON.parse(text)
    } catch {
      parsed = null
    }
    input = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : { decision: text }
  }
  if (!input || typeof input !== 'object') return null
  const decision = typeof input.decision === 'string' ? input.decision.trim() : ''
  if (!decision) return null
  const list = (v) => (Array.isArray(v) ? v.map(String) : typeof v === 'string' && v.trim() ? [v.trim()] : [])
  return { decision, constraints: list(input.constraints), evidence: list(input.evidence), unknowns: list(input.unknowns) }
}

function section(title, items) {
  return items.length ? `${title}:\n${items.map((x) => `- ${x}`).join('\n')}` : `${title}: (none given)`
}

function lensPrompt(lens, brief) {
  return [
    `You are the council's ${lens.key} lens. ${lens.brief}`,
    '',
    'Decision under assessment:',
    brief.decision,
    '',
    section('Constraints', brief.constraints),
    section('Evidence supplied', brief.evidence),
    section('Explicit unknowns', brief.unknowns),
    '',
    'Answer independently. You have not seen any other lens. Verify claims against the repository',
    'where you can (read-only: Read, Grep, Glob, Bash for read-only commands). Do not edit files,',
    'change configuration, or execute the proposed plan. Ground every point in evidence you cite.',
    '',
    'Return the schema object only: verdict, confidence, keyEvidence[], risks[], conditions[], unknowns[].',
  ].join('\n')
}

function synthesisPrompt(brief, responded, notConvened) {
  const blocks = responded
    .map((r) => {
      const v = r.response
      return [
        `### ${r.key} — ${v.verdict} (confidence: ${v.confidence})`,
        section('Key evidence', v.keyEvidence),
        section('Risks or objections', v.risks),
        section('Required conditions', v.conditions),
        section('Unknowns', v.unknowns),
      ].join('\n')
    })
    .join('\n\n')
  const absent = notConvened.length ? notConvened.join(', ') : '(none)'
  return [
    'You are the council synthesizer. You did not assess; you integrate the lens responses below',
    'into one decision. Preserve minority opinions attributed by lens — a dissenting finding is not',
    'deleted merely because most lenses agree. If evidence is insufficient, say so rather than',
    'manufacturing consensus. Assess only; recommend no mutation.',
    '',
    'Decision under assessment:',
    brief.decision,
    '',
    'Lens responses:',
    blocks,
    '',
    `Lenses that did not respond this run: ${absent}. Never infer their position.`,
    '',
    'Return the schema object only: decision, consensus, dissent[] ({lens, position}), conditions[],',
    'evidenceGaps[], nextAction (one bounded step), conflictResolution (how conflicts were resolved).',
  ].join('\n')
}

function render(brief, responded, notConvened, synth) {
  const lensBlocks = responded
    .map((r) => {
      const v = r.response
      return [
        `### ${r.key}`,
        `Verdict: ${v.verdict}`,
        `Confidence: ${v.confidence}`,
        section('Key evidence', v.keyEvidence),
        section('Risks or objections', v.risks),
        section('Required conditions', v.conditions),
        section('Unknowns', v.unknowns),
      ].join('\n')
    })
    .join('\n\n')
  const dissent = synth.dissent.length ? synth.dissent.map((d) => `- **${d.lens}:** ${d.position}`).join('\n') : '- (none recorded)'
  const absent = notConvened.length ? `\n\n_Not convened this run: ${notConvened.join(', ')}_` : ''
  return [
    `# Council: ${brief.decision}`,
    '',
    '## Lenses',
    lensBlocks,
    '',
    '## Synthesis',
    `Decision: ${synth.decision}`,
    `Consensus: ${synth.consensus}`,
    'Dissent:',
    dissent,
    section('Conditions', synth.conditions),
    section('Evidence gaps', synth.evidenceGaps),
    `Next action: ${synth.nextAction}`,
    '',
    `Conflict resolution: ${synth.conflictResolution}`,
    absent,
  ].join('\n')
}

const brief = normalizeInput(args)
if (!brief) {
  return { ok: false, error: 'No decision to assess. Pass a decision string, or {decision, constraints?, evidence?, unknowns?}.' }
}
log(`Council convened on: ${brief.decision.slice(0, 120)}${brief.decision.length > 120 ? '…' : ''}`)

phase('Lenses')
const raw = await parallel(
  LENSES.map((lens) => () => agent(lensPrompt(lens, brief), { label: `lens:${lens.key}`, phase: 'Lenses', schema: LENS_SCHEMA })),
)
const responded = LENSES.map((lens, i) => ({ key: lens.key, response: raw[i] })).filter((r) => r.response)
const notConvened = LENSES.filter((_, i) => !raw[i]).map((l) => l.key)
if (notConvened.length) log(`No response from: ${notConvened.join(', ')}.`)
if (responded.length < 3) {
  return { ok: false, error: 'Fewer than three lenses responded — the council cannot synthesize.', notConvened }
}

phase('Synthesis')
const synth = await agent(synthesisPrompt(brief, responded, notConvened), { label: 'synthesis', phase: 'Synthesis', schema: SYNTHESIS_SCHEMA })
if (!synth) {
  return { ok: false, error: 'The synthesizer returned nothing.', lenses: responded, notConvened }
}
log(`Decision: ${synth.decision}`)
return { ok: true, decision: synth.decision, report: render(brief, responded, notConvened, synth), lenses: responded, synthesis: synth, notConvened }
