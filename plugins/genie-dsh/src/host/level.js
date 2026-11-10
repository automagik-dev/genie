// Whether a group's permission level is known to allow no more than a Bot's, ranked as the
// Bot team ranks them (@automagik/bots-dsh, src/host/permission-rank.js): by what DSH's
// preset allows, its sandbox (read-only < workspace-write < danger-full-access), then its
// approval (ask before never). Pure: `service` is DSH's permissionPresets service.
// A copy of the team's ranking, kept in step by hand: nothing fails here when the team's changes.

const AUTO = 'auto';
// What a saved Auto runs as where it cannot be set (the Bot team's AUTO_FALLBACK).
const AUTO_FALLBACK = 'workspace-write';
const SANDBOX = { 'read-only': 0, 'workspace-write': 1, 'danger-full-access': 2 };
const APPROVAL = { ask: 0, never: 1 };

function rankOf(service, name) {
  let spec;
  try {
    spec = service.resolve(name);
  } catch {
    return undefined;
  }
  const sandbox = SANDBOX[spec?.sandbox];
  const approval = APPROVAL[spec?.approval];
  return sandbox === undefined || approval === undefined ? undefined : sandbox * 2 + approval;
}

// The ranks a level may run as. Auto runs as Auto where DSH offers it and the set holds,
// else as its fallback, so it has two; every other level has one. Undefined when any
// of them cannot be ranked.
function ranksOf(service, name, autoOffered) {
  const names = name === AUTO ? (autoOffered ? [AUTO, AUTO_FALLBACK] : [AUTO_FALLBACK]) : [name];
  const ranks = names.map((each) => rankOf(service, each));
  return ranks.includes(undefined) ? undefined : ranks;
}

/**
 * True only when the widest `groupLevel` can run as allows no more than the narrowest
 * `botLevel` can run as. A Bot without a level of its own (`botLevel` undefined) is
 * compared by the catalog's default, which is what its task is given. Anything that cannot
 * be read or ranked is not proof, and answers false.
 */
export function groupNotWider(service, botLevel, groupLevel) {
  try {
    const { options, defaultPreset } = service.catalog();
    const autoOffered = options.some((option) => option.value === AUTO);
    const own = botLevel ?? defaultPreset;
    if (typeof own !== 'string' || own === '' || typeof groupLevel !== 'string' || groupLevel === '') return false;
    const bot = ranksOf(service, own, autoOffered);
    const group = ranksOf(service, groupLevel, autoOffered);
    return bot !== undefined && group !== undefined && Math.max(...group) <= Math.min(...bot);
  } catch {
    return false;
  }
}
