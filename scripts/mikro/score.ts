/**
 * Mechanical scoring of a microagent answer against a fixture's ground truth.
 * Nothing here consults a model: recall/precision over file sets, exact enum
 * matches, and the citation verdict `call.ts` already computed. The numbers feed
 * `bench.ts` and each agent's EVIDENCE.md; the go/no-go bars live in bench.ts.
 */
import type { Citation } from './call';

export interface Truth {
  files?: string[];
  type?: string;
  lane?: string;
  tests?: string[];
  notes?: string;
}

export interface Score {
  filesRecall: number | null;
  filesPrecision: number | null;
  typeOk: boolean | null;
  laneOk: boolean | null;
  testsRecall: number | null;
  citationsTotal: number;
  citationsDropped: number;
}

const norm = (p: string) => p.replace(/^\.\//, '').split(':')[0].trim();

function setScores(
  predicted: string[],
  truth: string[] | undefined,
): { recall: number | null; precision: number | null } {
  if (!truth || truth.length === 0) return { recall: null, precision: null };
  const t = new Set(truth.map(norm));
  const p = new Set(predicted.map(norm));
  let hit = 0;
  for (const x of p) if (t.has(x)) hit++;
  return { recall: hit / t.size, precision: p.size ? hit / p.size : 0 };
}

function pathsOf(answer: unknown, key: string): string[] {
  const out: string[] = [];
  const walk = (v: unknown) => {
    if (Array.isArray(v)) for (const i of v) walk(i);
    else if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        if (k === key) {
          if (typeof x === 'string') out.push(x);
          else if (Array.isArray(x)) for (const s of x) if (typeof s === 'string') out.push(s);
        }
        walk(x);
      }
    }
  };
  walk(answer);
  return out;
}

export function scoreAnswer(agent: string, answer: unknown, truth: Truth, citations: Citation[]): Score {
  const a = (answer ?? {}) as Record<string, unknown>;
  let predictedFiles: string[] = [];
  if (agent === 'issue-triage') predictedFiles = pathsOf(a.candidate_files, 'path');
  else if (agent === 'wish-context')
    predictedFiles = pathsOf((a.plan as Record<string, unknown> | undefined)?.files, 'path');
  else if (agent === 'review-prep') predictedFiles = pathsOf(a.files, 'path');
  const files = setScores(predictedFiles, truth.files);
  const tests = agent === 'review-prep' ? setScores(pathsOf(a.files, 'pinning_tests'), truth.tests) : { recall: null };
  return {
    filesRecall: files.recall,
    filesPrecision: files.precision,
    typeOk: truth.type ? a.type === truth.type : null,
    laneOk: truth.lane ? a.lane === truth.lane : null,
    testsRecall: tests.recall,
    citationsTotal: citations.length,
    citationsDropped: citations.filter((c) => !c.ok).length,
  };
}
