// What a wish is, once granted: its record (v2), the words for how it turned out, the
// evidence of what the host ran for it, and the one check publication will have to pass.
// Nothing here runs git or touches a file; genie.js does, and keeps these as plain data in
// genie.json beside the v1 records it already holds.
//
// A v2 record: { v: 2, slug, title, branch, branches, starts, folder, repo, binding,
// baseSha, sessionId, botId, at, state, evidence }. `binding` is binding.js's snapshot (no
// URL but remoteDisplay), `starts` the commit each given branch (#3184 scope) was on at the
// grant. A v1 record has `base` (a commit) and none of the rest, and loads unchanged.

export const WISH_VERSION = 2;
export const EVIDENCE_KEPT = 40;

/**
 * The states. `working` until the task's turn ends, then: `local-only` (the wish branch is
 * ahead of its base, or a given branch moved from its start, so a local branch holds the
 * work, not published), `no-change` (no branch moved; a given branch is still fetched back,
 * and that attempt is in the evidence), `stopped`, `failed`, or `lost` (the team no longer
 * has the task's record). Program wish 2 adds the published ones.
 */
export const STATES = Object.freeze(['working', 'local-only', 'no-change', 'stopped', 'failed', 'lost']);

/** The ended state for a task's outcome (`done`, `stopped`, `failed`, `lost`) and whether a branch moved. */
export function endedState(outcome, moved) {
  if (outcome === 'done') return moved ? 'local-only' : 'no-change';
  return outcome;
}

/**
 * How a live turn end ended the task, with the team's own mapping (bots-dsh agents.js):
 * `error` failed it, `aborted` stopped it, anything else is done. A `blocked` end goes on
 * in a fresh part (bots-dsh resume.js), so it is no end: undefined.
 */
export function turnOutcome(reason) {
  const kind = reason?.kind;
  if (kind === 'blocked') return undefined;
  if (kind === 'error') return 'failed';
  if (kind === 'aborted') return 'stopped';
  return 'done';
}

/** The outcome the team's task record says, or undefined while it is working (or says nothing known). */
export function taskOutcome(status) {
  return status === 'done' || status === 'stopped' || status === 'failed' ? status : undefined;
}

/** Whether the live turn end of this record settles it: a v2 one working or lost, or a v1 one still running. */
export function awaitsEnd(entry) {
  if (entry?.v === WISH_VERSION) return entry.state === 'working' || entry.state === 'lost';
  return entry !== undefined && entry.state === undefined && entry.delivered === undefined;
}

/** A fresh evidence record. */
export const newEvidence = () => ({ commands: [], dropped: 0, baseSha: null, headSha: null, ahead: null });

/** Adds one `{ step, argv, code, ms }` to `evidence`, keeping the newest EVIDENCE_KEPT. */
export function noteCommand(evidence, command) {
  evidence.commands.push(command);
  const over = evidence.commands.length - EVIDENCE_KEPT;
  if (over > 0) {
    evidence.commands.splice(0, over);
    evidence.dropped = (evidence.dropped ?? 0) + over;
  }
}

/**
 * Whether a wish of this binding may publish under `grant` ({ repoSlug, base }): `{ ok: true }`,
 * or `{ ok: false, reason }` naming what the user does about it. Pure: nothing stores a grant
 * in this release; program wish 2 decides where one comes from and calls this.
 */
export function publishAllowed(grant, binding) {
  if (binding?.baseSource === 'local' || typeof binding?.remote !== 'string')
    return {
      ok: false,
      reason:
        'This repository has no remote, so a wish can only leave a local branch. Add one (git remote add origin <url>) to publish.',
    };
  if (binding.repoSlug === null || binding.repoSlug === undefined)
    return {
      ok: false,
      reason: `The remote ${binding.remote} (${binding.remoteDisplay}) is not an owner/name repository on a host, so Genie cannot publish to it. Point it at one (git remote set-url ${binding.remote} <url>).`,
    };
  if (grant === null || typeof grant !== 'object')
    return {
      ok: false,
      reason: `Publishing is not granted. Grant publishing to ${binding.repoSlug} into ${binding.base} first.`,
    };
  if (grant.repoSlug !== binding.repoSlug)
    return {
      ok: false,
      reason: `The publish grant is for ${grant.repoSlug}, not ${binding.repoSlug}. Grant publishing to ${binding.repoSlug} into ${binding.base}.`,
    };
  if (grant.base !== binding.base)
    return {
      ok: false,
      reason: `The publish grant is into ${grant.base}, not ${binding.base}. Grant publishing to ${binding.repoSlug} into ${binding.base}.`,
    };
  return { ok: true };
}
