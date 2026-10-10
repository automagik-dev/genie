import { posix } from 'node:path';

export type ReadGitHistory = (...args: string[]) => string;

interface MikroImport {
  commit: string;
  genieParent: string;
  split: string;
}

/** Validate source-edge authority before either consumer interprets foreign history. */
function mikroImports(git: ReadGitHistory, history: readonly string[]): MikroImport[] {
  const validated: MikroImport[] = [];
  const imports = git('log', ...history, '--format=%H', '--grep=^git-subtree-dir:')
    .split('\n')
    .filter((line) => /^[0-9a-f]{40}$/.test(line));
  for (const commit of imports) {
    const body = git('show', '-s', '--format=%B', commit);
    const dirs = [...body.matchAll(/^git-subtree-dir:[ \t]*(.*)$/gm)].map((match) => match[1]?.trim());
    if (!dirs.some((dir) => dir === 'mikro' || dir?.startsWith('mikro/'))) continue;
    const splits = [...body.matchAll(/^git-subtree-split:[ \t]*(.*)$/gm)].map((match) => match[1]?.trim());
    const split = splits[0];
    const parents = git('show', '-s', '--format=%P', commit).trim().split(' ');
    const genieParent = parents[0];
    if (
      dirs.length !== 1 ||
      dirs[0] !== 'mikro' ||
      splits.length !== 1 ||
      !split ||
      !genieParent ||
      !/^[0-9a-f]{40}$/.test(split) ||
      parents.length !== 2 ||
      parents[1] !== split
    ) {
      throw new Error(`invalid Mikro subtree import metadata at ${commit}`);
    }
    if (git('rev-parse', `${commit}:mikro`).trim() !== git('rev-parse', `${split}^{tree}`).trim()) {
      throw new Error(`Mikro subtree import tree does not match its source at ${commit}`);
    }
    validated.push({ commit, genieParent, split });
  }
  return validated;
}

/** Validate all-ref ownership, then grant retirement authority only to shipped or proven Genie roots. */
export function catalogGenieCommits(
  git: ReadGitHistory,
  history: readonly string[],
  retirementHistory: readonly string[],
  provenance?: string,
): Set<string> {
  const imports = new Map(mikroImports(git, history).map((entry) => [entry.commit, entry]));
  const graph = historyGraph(git, history);
  const sourceTips = new Set<string>();
  for (const { split } of imports.values()) sourceTips.add(split);
  const roots = git('rev-list', '--no-walk', ...history)
    .trim()
    .split('\n')
    .filter(Boolean);
  const owned = new Set<string>();
  // The collector runs in a Genie checkout. Independent refs cannot authenticate
  // proof blobs before their own provenance has been established.
  visitHistory(graph, imports, [git('rev-parse', 'HEAD^{commit}').trim()], owned);

  const refs = referenceTips(git, graph);
  const declared =
    provenance === undefined
      ? { genieRoots: [], sourceRefs: new Set<string>() }
      : provenReferences(git, provenance, owned, refs);
  // visitHistory consumes its stack; retain exact proof roots for the eligibility walk.
  visitHistory(graph, imports, [...declared.genieRoots], owned);
  const sourceSeeds = [...sourceTips];
  for (const [ref, commit] of refs) {
    if (declared.sourceRefs.has(ref)) sourceSeeds.push(commit);
  }
  const sourceConnected = sourceSeeds.length ? sourceConnectedHistory(graph, imports, sourceSeeds) : new Set<string>();
  visitHistory(
    graph,
    imports,
    roots.filter((root) => !sourceConnected.has(root)),
    owned,
  );

  const rootSet = new Set(roots);
  const namedRoots = new Set<string>();
  for (const [ref, commit] of refs) {
    namedRoots.add(commit);
    if (rootSet.has(commit) && !owned.has(commit) && !sourceTips.has(commit) && !declared.sourceRefs.has(ref)) {
      throw new Error(`ambiguous history reference ${ref} at ${commit}; supply commit-bound --ref-provenance`);
    }
  }
  for (const root of roots) {
    if (!owned.has(root) && !sourceTips.has(root) && !namedRoots.has(root)) {
      throw new Error(`ambiguous unnamed history root ${root}; cannot establish reference provenance`);
    }
  }
  const eligibleRoots = git('rev-list', '--no-walk', ...retirementHistory)
    .trim()
    .split('\n')
    .filter((root) => owned.has(root));
  eligibleRoots.push(...declared.genieRoots);
  // Ownership of an unmerged Genie ref does not mean its skills ever shipped.
  // All-ref validation is complete; reuse its visited set for the eligible walk.
  owned.clear();
  visitHistory(graph, imports, eligibleRoots, owned);
  return owned;
}

/** Cut only validated import source edges; every ordinary merge parent remains Genie-owned. */
export function foreignOnlyMikroCommits(git: ReadGitHistory, tip: string): Set<string> {
  const imports = new Map(mikroImports(git, [tip]).map((entry) => [entry.commit, entry]));
  const graph = historyGraph(git, [tip]);
  const owned = new Set<string>();
  visitHistory(graph, imports, [tip], owned);
  return foreignHistory(graph, owned);
}

function historyGraph(git: ReadGitHistory, history: readonly string[]): Map<string, string[]> {
  const graph = new Map<string, string[]>();
  for (const line of git('rev-list', '--parents', ...history)
    .trim()
    .split('\n')) {
    const [commit, ...parents] = line.split(' ');
    if (!commit || !/^[0-9a-f]{40}$/.test(commit) || parents.some((parent) => !/^[0-9a-f]{40}$/.test(parent))) {
      throw new Error('invalid Git ancestry record');
    }
    graph.set(commit, parents);
  }
  return graph;
}

function visitHistory(
  graph: ReadonlyMap<string, readonly string[]>,
  imports: ReadonlyMap<string, MikroImport>,
  pending: string[],
  owned: Set<string>,
): void {
  while (pending.length) {
    const commit = pending.pop();
    if (!commit || owned.has(commit)) continue;
    const parents = graph.get(commit);
    if (!parents) throw new Error(`incomplete Git ancestry at ${commit}`);
    owned.add(commit);
    const imported = imports.get(commit);
    if (imported) pending.push(imported.genieParent);
    else pending.push(...parents);
  }
}

function foreignHistory(graph: ReadonlyMap<string, readonly string[]>, owned: ReadonlySet<string>): Set<string> {
  const foreign = new Set<string>();
  for (const commit of graph.keys()) {
    if (!owned.has(commit)) foreign.add(commit);
  }
  return foreign;
}

function referenceTips(git: ReadGitHistory, graph: ReadonlyMap<string, readonly string[]>): Map<string, string> {
  const refs = new Map<string, string>();
  // --dereference peels annotated and nested tags. Non-commit objects cannot grant history authority.
  for (const line of git('show-ref', '--head', '--dereference').trim().split('\n')) {
    const [commit, reference] = line.split(' ');
    if (commit && reference && graph.has(commit)) {
      refs.set(reference.endsWith('^{}') ? reference.slice(0, -3) : reference, commit);
    }
  }
  return refs;
}

/** Source forks can expose off-tip refs; never cross a validated import source edge. */
function sourceConnectedHistory(
  graph: ReadonlyMap<string, readonly string[]>,
  imports: ReadonlyMap<string, MikroImport>,
  pending: string[],
): Set<string> {
  const children = new Map<string, string[]>();
  for (const [commit, parents] of graph) {
    const imported = imports.get(commit);
    for (const parent of parents) {
      if (imported && parent !== imported.genieParent) continue;
      const descendants = children.get(parent);
      if (descendants) descendants.push(commit);
      else children.set(parent, [commit]);
    }
  }
  const connected = new Set<string>();
  while (pending.length) {
    const commit = pending.pop();
    if (!commit || connected.has(commit)) continue;
    const parents = graph.get(commit);
    if (!parents) throw new Error(`incomplete source ancestry at ${commit}`);
    connected.add(commit);
    const imported = imports.get(commit);
    if (imported) pending.push(imported.genieParent);
    else pending.push(...parents);
    const descendants = children.get(commit);
    if (descendants) pending.push(...descendants);
  }
  return connected;
}

function provenanceRecords(git: ReadGitHistory, selector: string, owned: ReadonlySet<string>): unknown[] {
  const match = /^([0-9a-f]{40}):(.+)$/.exec(selector);
  const commit = match?.[1];
  const path = match?.[2];
  if (
    !commit ||
    !path ||
    path.startsWith('/') ||
    posix.normalize(path) !== path ||
    path === 'mikro' ||
    path.startsWith('mikro/') ||
    path.startsWith('../')
  ) {
    throw new Error('reference provenance must select an exact commit and canonical non-Mikro root blob (SHA:path)');
  }
  // Proof cannot bootstrap its own authority from a source commit or a nested foreign destination.
  if (!owned.has(commit)) throw new Error(`reference provenance authority is not independently Genie-owned: ${commit}`);
  const document: unknown = JSON.parse(git('show', selector));
  if (
    !document ||
    typeof document !== 'object' ||
    !('version' in document) ||
    document.version !== 1 ||
    !('refs' in document) ||
    !Array.isArray(document.refs)
  ) {
    throw new Error('invalid reference provenance document; expected version 1 and refs array');
  }
  return document.refs;
}

function provenReferences(
  git: ReadGitHistory,
  selector: string,
  owned: ReadonlySet<string>,
  refs: ReadonlyMap<string, string>,
): { genieRoots: string[]; sourceRefs: Set<string> } {
  const genieRoots: string[] = [];
  const sourceRefs = new Set<string>();
  const seen = new Set<string>();
  for (const value of provenanceRecords(git, selector, owned)) {
    const entry = value as { ref?: unknown; commit?: unknown; owner?: unknown } | null;
    if (
      !entry ||
      typeof entry !== 'object' ||
      typeof entry.ref !== 'string' ||
      typeof entry.commit !== 'string' ||
      (entry.owner !== 'genie' && entry.owner !== 'source')
    ) {
      throw new Error('invalid reference provenance entry; expected ref, commit and genie/source owner');
    }
    if (seen.has(entry.ref)) throw new Error(`duplicate reference provenance entry: ${entry.ref}`);
    if (refs.get(entry.ref) !== entry.commit) throw new Error(`stale or unknown reference provenance: ${entry.ref}`);
    seen.add(entry.ref);
    if (entry.owner === 'genie') genieRoots.push(entry.commit);
    else sourceRefs.add(entry.ref);
  }
  return { genieRoots, sourceRefs };
}
