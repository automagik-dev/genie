import { posix } from 'node:path';

export type ReadGitHistory = (...args: string[]) => string;

interface MikroImport {
  commit: string;
  genieParent: string;
  split: string;
}

interface GitHistoryGraph {
  graph: ReadonlyMap<string, readonly string[]>;
  raw: string;
  rows: number;
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
  trustedGenieRoot?: string,
): Set<string> {
  if (trustedGenieRoot !== undefined && !/^[0-9a-f]{40}$/.test(trustedGenieRoot)) {
    throw new Error('--trusted-genie-root requires one full lowercase commit SHA');
  }
  if (trustedGenieRoot !== undefined) {
    let resolved: string;
    try {
      resolved = git('rev-parse', '--verify', `${trustedGenieRoot}^{commit}`).trim();
    } catch {
      throw new Error('--trusted-genie-root must resolve to an available local commit');
    }
    if (resolved !== trustedGenieRoot) {
      throw new Error('--trusted-genie-root must identify an exact local commit, not a tag object');
    }
  }
  const imports = new Map(mikroImports(git, history).map((entry) => [entry.commit, entry]));
  const graphRead = historyGraph(git, history);
  const { graph } = graphRead;
  const sourceTips = new Set<string>();
  for (const { split } of imports.values()) sourceTips.add(split);
  const roots = git('rev-list', '--no-walk', ...history)
    .trim()
    .split('\n')
    .filter(Boolean);
  const headCommit = git('rev-parse', 'HEAD^{commit}').trim();
  const readHead = () => headCommit;
  const head = historyClosure(graphRead, imports, [headCommit], readHead);
  if (trustedGenieRoot !== undefined && !head.has(trustedGenieRoot)) {
    throw new Error('--trusted-genie-root must belong to validated-cut HEAD ancestry');
  }
  const anchor = historyClosure(graphRead, imports, trustedGenieRoot === undefined ? [] : [trustedGenieRoot], readHead);
  const refs = referenceTips(git, graph);
  // Parse ALL negative roles before authentication; document Genie claims cannot authenticate themselves.
  const declared =
    provenance === undefined
      ? { genieRoots: [], sourceRefs: new Set<string>() }
      : referenceProposals(git, provenance, refs, trustedGenieRoot === undefined ? head : anchor);
  const sourceSeeds = [...sourceTips];
  const sourceRefCommits = new Set<string>();
  for (const [ref, commit] of refs) {
    if (declared.sourceRefs.has(ref)) {
      sourceSeeds.push(commit);
      sourceRefCommits.add(commit);
    }
  }
  // Raw source ancestry plus every source-only descendant: a descendant is trusted only inside the
  // anchor or an exact proof, so an ordinary HEAD merge can never extend source trust.
  const rawSource = sourceConnectedHistory(graph, imports, sourceSeeds, anchor).connected;
  const bootstrapNegative = new Set([...rawSource].filter((commit) => !anchor.has(commit)));
  const tainted = sourceDescendants(graph, imports, bootstrapNegative);
  const authority = new Set(
    [...head].filter((commit) => !tainted.has(commit) && (trustedGenieRoot === undefined || anchor.has(commit))),
  );
  if (provenance !== undefined && !authority.has(provenance.slice(0, 40))) {
    throw new Error(
      `reference provenance authority is not independently Genie-owned: ${provenance.slice(0, 40)}; supply an operator-reviewed --trusted-genie-root`,
    );
  }
  // Authority is frozen. Exact independently authenticated positive roots grant history, never reauthentication.
  const proven = historyClosure(graphRead, imports, declared.genieRoots, readHead);
  const negative = new Set([...bootstrapNegative].filter((commit) => !proven.has(commit)));
  if ([...head].some((commit) => negative.has(commit))) {
    throw new Error(
      'ambiguous source-crossing HEAD history; supply an operator-reviewed --trusted-genie-root or independent proof',
    );
  }
  const known = new Set([...anchor, ...head, ...proven]);
  let source = sourceConnectedHistory(graph, imports, sourceSeeds, known);
  // A different shipped root may not retroactively authenticate an unknown source ref.
  for (const [ref, commit] of refs) {
    if (
      roots.includes(commit) &&
      source.connected.has(commit) &&
      !known.has(commit) &&
      !sourceTips.has(commit) &&
      !declared.sourceRefs.has(ref)
    ) {
      throw new Error(`ambiguous history reference ${ref} at ${commit}; supply commit-bound --ref-provenance`);
    }
  }
  const retirementRoots = git('rev-list', '--no-walk', ...retirementHistory)
    .trim()
    .split('\n')
    .filter(Boolean);
  const eligible = new Set([...head, ...proven]);
  // Each shipped root is checked against the SAME frozen negative/known sets: no mutual-root bootstrap.
  for (const root of retirementRoots) {
    if (sourceTips.has(root) || sourceRefCommits.has(root)) continue;
    if (source.connected.has(root) && !known.has(root)) continue; // The all-ref gate below names the ambiguity.
    const lineage = historyClosure(graphRead, imports, [root], readHead);
    if ([...lineage].some((commit) => negative.has(commit))) {
      throw new Error(
        `ambiguous shipped mixed history at ${root}; supply --trusted-genie-root or commit-bound --ref-provenance`,
      );
    }
    for (const commit of lineage) eligible.add(commit);
  }
  const witnesses = new Set([...known, ...eligible]);
  source = sourceConnectedHistory(graph, imports, sourceSeeds, witnesses);
  const rootSet = new Set(roots);
  const namedRoots = new Set<string>();
  for (const [ref, commit] of refs) {
    namedRoots.add(commit);
    if (
      rootSet.has(commit) &&
      !witnesses.has(commit) &&
      !sourceTips.has(commit) &&
      !declared.sourceRefs.has(ref) &&
      (source.connected.has(commit) || (source.boundary.has(commit) && !source.genieBoundary.has(commit)))
    ) {
      throw new Error(`ambiguous history reference ${ref} at ${commit}; supply commit-bound --ref-provenance`);
    }
  }
  for (const root of roots) {
    if (
      !witnesses.has(root) &&
      !sourceTips.has(root) &&
      !namedRoots.has(root) &&
      (source.connected.has(root) || source.boundary.has(root))
    ) {
      throw new Error(`ambiguous unnamed history root ${root}; cannot establish reference provenance`);
    }
  }
  if ([...eligible].some((commit) => negative.has(commit))) throw new Error('ambiguous final retirement history');
  return eligible;
}

function historyClosure(
  graphRead: GitHistoryGraph,
  imports: ReadonlyMap<string, MikroImport>,
  roots: readonly string[],
  readHead: () => string,
): Set<string> {
  const closure = new Set<string>();
  visitHistory(graphRead, imports, [...roots], closure, readHead);
  return closure;
}

/** A proof on source or its ordinary mixed descendants is not independent authority. */
function sourceDescendants(
  graph: ReadonlyMap<string, readonly string[]>,
  imports: ReadonlyMap<string, MikroImport>,
  source: ReadonlySet<string>,
): Set<string> {
  const children = new Map<string, string[]>();
  for (const [commit, parents] of graph) {
    const imported = imports.get(commit);
    for (const parent of imported ? [imported.genieParent] : parents) {
      const descendants = children.get(parent);
      if (descendants) descendants.push(commit);
      else children.set(parent, [commit]);
    }
  }
  const tainted = new Set(source);
  const pending = [...source];
  while (pending.length) {
    const commit = pending.pop();
    if (!commit) continue;
    for (const child of children.get(commit) ?? []) {
      if (tainted.has(child)) continue;
      tainted.add(child);
      pending.push(child);
    }
  }
  return tainted;
}

/** Cut only validated import source edges; every ordinary merge parent remains Genie-owned. */
export function foreignOnlyMikroCommits(git: ReadGitHistory, tip: string): Set<string> {
  const imports = new Map(mikroImports(git, [tip]).map((entry) => [entry.commit, entry]));
  const graphRead = historyGraph(git, [tip]);
  const owned = new Set<string>();
  visitHistory(graphRead, imports, [tip], owned, () => git('rev-parse', 'HEAD^{commit}').trim());
  return foreignHistory(graphRead.graph, owned);
}

function historyGraph(git: ReadGitHistory, history: readonly string[]): GitHistoryGraph {
  const graph = new Map<string, string[]>();
  const raw = git('rev-list', '--parents', ...history);
  const rows = raw.trim().split('\n');
  for (const line of rows) {
    const [commit, ...parents] = line.split(' ');
    if (!commit || !/^[0-9a-f]{40}$/.test(commit) || parents.some((parent) => !/^[0-9a-f]{40}$/.test(parent))) {
      throw new Error('invalid Git ancestry record');
    }
    graph.set(commit, parents);
  }
  return { graph, raw, rows: rows.length };
}

function visitHistory(
  graphRead: GitHistoryGraph,
  imports: ReadonlyMap<string, MikroImport>,
  pending: string[],
  owned: Set<string>,
  readHead: () => string,
): void {
  const roots = pending.slice(0, 3);
  const rootCount = pending.length;
  while (pending.length) {
    const commit = pending.pop();
    if (!commit || owned.has(commit)) continue;
    const parents = graphRead.graph.get(commit);
    if (!parents) {
      let head = 'unavailable';
      try {
        const resolved = readHead();
        if (/^[0-9a-f]{40}$/.test(resolved)) head = resolved;
      } catch {
        // Diagnostic reads must never replace the original ancestry refusal.
      }
      throw new Error(
        `incomplete Git ancestry at ${commit}; revListRows=${graphRead.rows}; ` +
          `graphCommits=${graphRead.graph.size}; revListBytes=${Buffer.byteLength(graphRead.raw)}; ` +
          `head(HEAD^{commit})=${head}; walkRootCount=${rootCount}; ` +
          `walkRoots=[${roots.filter((root) => /^[0-9a-f]{40}$/.test(root)).join(',')}]; ` +
          `missingInRaw=${graphRead.raw.includes(commit)}`,
      );
    }
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

/**
 * Mikro source history: the ancestry of every validated split, plus descendants that stay
 * entirely inside it. A descendant that also has Genie ancestry is a boundary merge - it pulls
 * source history into Genie, so a ref may not own it without proof, but the Genie history
 * behind it is not source. Walking up through such a merge would mark every Genie ref as
 * foreign, which is what an unmerged subtree-pull branch used to do.
 */
function sourceConnectedHistory(
  graph: ReadonlyMap<string, readonly string[]>,
  imports: ReadonlyMap<string, MikroImport>,
  pending: string[],
  owned: ReadonlySet<string>,
): { connected: Set<string>; boundary: Set<string>; genieBoundary: Set<string> } {
  const connected = new Set<string>();
  const ancestors = [...pending];
  while (ancestors.length) {
    const commit = ancestors.pop();
    if (!commit || connected.has(commit)) continue;
    const parents = graph.get(commit);
    if (!parents) throw new Error(`incomplete source ancestry at ${commit}`);
    connected.add(commit);
    // Source data remains raw ancestry: nested metadata cannot hide source commits.
    ancestors.push(...parents);
  }

  // Process every parent before its children. Git's row order (and the order of
  // siblings at a reconvergent merge) is not an ownership signal.
  const children = new Map<string, string[]>();
  const remaining = new Map<string, number>();
  const effectiveParents = new Map<string, readonly string[]>();
  const queue: string[] = [];
  for (const [commit, parents] of graph) {
    const imported = imports.get(commit);
    const effective = imported ? [imported.genieParent] : parents;
    effectiveParents.set(commit, effective);
    remaining.set(commit, effective.length);
    if (effective.length === 0) queue.push(commit);
    for (const parent of effective) {
      if (!graph.has(parent)) throw new Error(`incomplete source ancestry at ${parent}`);
      const descendants = children.get(parent);
      if (descendants) descendants.push(commit);
      else children.set(parent, [commit]);
    }
  }

  const boundary = new Set<string>();
  const genieBoundary = new Set<string>();
  let visited = 0;
  while (queue.length) {
    const commit = queue.pop();
    if (!commit) continue;
    visited++;
    const parents = effectiveParents.get(commit) ?? [];
    if (!connected.has(commit) && parents.length > 0) {
      if (parents.every((parent) => connected.has(parent))) connected.add(commit);
      else if (parents.some((parent) => connected.has(parent) || boundary.has(parent))) {
        boundary.add(commit);
        // A foreign parent is not evidence of Genie ownership. Only independently
        // owned Genie ancestry can waive ambiguity for an unshipped mixed branch.
        if (parents.every((parent) => connected.has(parent) || owned.has(parent) || genieBoundary.has(parent))) {
          genieBoundary.add(commit);
        }
      }
    }
    for (const child of children.get(commit) ?? []) {
      const count = (remaining.get(child) ?? 0) - 1;
      remaining.set(child, count);
      if (count === 0) queue.push(child);
    }
  }
  if (visited !== graph.size) throw new Error('invalid cyclic Git ancestry');
  return { connected, boundary, genieBoundary };
}

function provenanceRecords(git: ReadGitHistory, selector: string, candidate: ReadonlySet<string>): unknown[] {
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
  // Preliminary reachability is necessary, not authentication: negative roles still constrain it below.
  if (!candidate.has(commit))
    throw new Error(`reference provenance authority is not independently Genie-owned: ${commit}`);
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

function referenceProposals(
  git: ReadGitHistory,
  selector: string,
  refs: ReadonlyMap<string, string>,
  candidate: ReadonlySet<string>,
): { genieRoots: string[]; sourceRefs: Set<string> } {
  const genieRoots: string[] = [];
  const sourceRefs = new Set<string>();
  const seen = new Set<string>();
  for (const value of provenanceRecords(git, selector, candidate)) {
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
