/**
 * The row, end to end, without a host.
 *
 * A stub `ctx.tools` captures the definition; a stub `ctx.workflowEngine` runs
 * the submitted script in-process with recording globals, which is the same
 * contract the real engine offers a script (the bare globals plus a returned
 * value) minus the agents. The repository's own catalog is the fixture.
 */
import { describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, workflowRunTool } from './index'
import { resolveLoaderConfig } from './config'

const REPO = join(import.meta.dir, '..', '..', '..')

/**
 * A writable scratch directory. `os.tmpdir()` is the convention and works in CI;
 * a sandbox that mounts its temp area read-only falls back to one inside the
 * package, which every caller removes in `finally`.
 */
function tempRoot(): string {
  try {
    return mkdtempSync(join(tmpdir(), 'workflow-loader-'))
  } catch {
    const base = join(import.meta.dir, '..', '.test-tmp')
    mkdirSync(base, { recursive: true })
    return mkdtempSync(join(base, 'run-'))
  }
}

interface Capture {
  script?: string
  meta?: { name?: string }
  args?: unknown
  runs: number
}

/** Build a value that satisfies a JSON Schema, deterministically. */
function canned(schema: unknown): unknown {
  if (!schema || typeof schema !== 'object') return 'stub'
  const node = schema as Record<string, unknown>
  if (Array.isArray(node.oneOf) && node.oneOf.length) return canned(node.oneOf[0])
  if (Array.isArray(node.enum) && node.enum.length) return node.enum[0]
  switch (node.type) {
    case 'object': {
      const properties = (node.properties ?? {}) as Record<string, unknown>
      const required = Array.isArray(node.required) ? (node.required as string[]) : Object.keys(properties)
      const out: Record<string, unknown> = {}
      for (const key of required) out[key] = canned(properties[key])
      return out
    }
    case 'array':
      return []
    case 'number':
    case 'integer':
      return 1
    case 'boolean':
      return true
    case 'null':
      return null
    default:
      return 'stub'
  }
}

/** A stand-in for `ctx.workflowEngine` that runs the script for real. */
function stubEngine(capture: Capture) {
  return {
    start(request: { script: string; meta: unknown; args?: unknown }) {
      capture.script = request.script
      capture.meta = request.meta as { name?: string }
      capture.args = request.args
      capture.runs++
      let agentsStarted = 0
      const agent = async (_prompt: string, opts?: { schema?: unknown }) => {
        agentsStarted++
        return canned(opts?.schema)
      }
      const parallel = async (thunks: Array<() => Promise<unknown>>) =>
        Promise.all(thunks.map((thunk) => thunk().catch(() => null)))
      const pipeline = async (items: unknown[], ...stages: Array<(prev: unknown, item: unknown, index: number) => unknown>) => {
        const out: unknown[] = []
        for (const [index, item] of items.entries()) {
          let value: unknown = item
          for (const stage of stages) value = await stage(value, item, index)
          out.push(value)
        }
        return out
      }
      const phase = () => {}
      const log = () => {}
      const result = (async () => {
        const run = new Function(
          'agent',
          'parallel',
          'pipeline',
          'phase',
          'log',
          'args',
          `return (async () => {\n${request.script}\n})()`,
        )
        return await run(agent, parallel, pipeline, phase, log, request.args ?? {})
      })()
      return {
        id: 'run-stub-1',
        result: result.then((value) => ({ stopReason: 'completed' as const, agentsStarted, value })),
        dispose: async () => {},
      }
    },
  }
}

function harness(config: Record<string, unknown> = {}) {
  const capture: Capture = { runs: 0 }
  const root = tempRoot()
  const workspace = join(root, 'workspace')
  const userWorkflows = join(root, 'user-workflows')
  mkdirSync(join(workspace, '.claude', 'workflows'), { recursive: true })
  mkdirSync(userWorkflows, { recursive: true })
  const ctx = { tools: { register: () => () => {} }, workflowEngine: stubEngine(capture) }
  const resolved = resolveLoaderConfig({ journalDir: join(root, 'journal'), userRoot: userWorkflows, ...config })
  const tool = workflowRunTool(ctx as never, resolved) as {
    execute: (args: unknown, exec: unknown) => Promise<Record<string, unknown>>
    name: string
  }
  const exec = { agent: { session: { header: { cwd: workspace } } } }
  return { capture, root, workspace, userWorkflows, tool, exec, ctx, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

describe('the workflow_run row', () => {
  test('registers one tool under the configured name', () => {
    const h = harness({ toolName: 'run_saved_workflow' })
    try {
      expect(h.tool.name).toBe('run_saved_workflow')
      expect(h.ctx.tools.register).toBeFunction()
    } finally {
      h.cleanup()
    }
  })

  test('runs the repository catalog by name and never hands the script to the model', async () => {
    const h = harness()
    try {
      // The loader reads the project root from the calling session's cwd, so the
      // repository's own catalog is reachable by pointing cwd at the repo.
      const exec = { agent: { session: { header: { cwd: REPO } } } }
      const outcome = await h.tool.execute({ name: 'council', args: { decision: 'Ship the loader route?' } }, exec)
      expect(outcome.ok).toBe(true)
      expect(outcome.name).toBe('council')
      expect(outcome.agentsStarted).toBe(6)
      expect(outcome.truncated).toBe(false)
      expect(String(outcome.preview)).toContain('# Council:')
      // The engine received the body WITHOUT the export, and the meta as data.
      expect(h.capture.script ?? '').not.toContain('export const meta')
      expect(h.capture.meta?.name).toBe('council')
      expect(h.capture.args).toEqual({ decision: 'Ship the loader route?' })
      // The journal holds the whole value, outside the run root.
      const journal = JSON.parse(readFileSync(String(outcome.journalPath), 'utf8'))
      expect(journal.name).toBe('council')
      expect(journal.value.ok).toBe(true)
      expect(journal.agentsStarted).toBe(6)
    } finally {
      h.cleanup()
    }
  })

  test('strips a deferred option from a catalog file and reports it', async () => {
    const h = harness()
    try {
      writeFileSync(
        join(h.workspace, '.claude', 'workflows', 'effortful.js'),
        [
          "export const meta = { name: 'effortful', description: 'uses effort', phases: [{ title: 'One' }] }",
          "const facts = { effort: 'high' }",
          "const answer = await agent('answer', { label: 'a', phase: 'One', schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] }, effort: 'high' })",
          'return { answer, facts }',
        ].join('\n'),
      )
      const outcome = await h.tool.execute({ name: 'effortful' }, h.exec)
      expect(outcome.stoppedEffort).toBe(1)
      expect(h.capture.script ?? '').not.toMatch(/,\s*effort:/)
      // The data occurrence survives untouched.
      expect(h.capture.script ?? '').toContain("const facts = { effort: 'high' }")
    } finally {
      h.cleanup()
    }
  })

  test('journals the full value and bounds the projection', async () => {
    const h = harness({ maxResultChars: 1000 })
    try {
      writeFileSync(
        join(h.workspace, '.claude', 'workflows', 'big.js'),
        [
          "export const meta = { name: 'big', description: 'returns a lot' }",
          "return { blob: 'x'.repeat(5000), tail: 'the-important-decision' }",
        ].join('\n'),
      )
      const outcome = await h.tool.execute({ name: 'big' }, h.exec)
      expect(outcome.truncated).toBe(true)
      expect(String(outcome.preview).length).toBeLessThan(1200)
      const journal = JSON.parse(readFileSync(String(outcome.journalPath), 'utf8'))
      expect(journal.value.blob.length).toBe(5000)
      expect(journal.value.tail).toBe('the-important-decision')
    } finally {
      h.cleanup()
    }
  })

  test('refuses a name that exists in both roots instead of guessing', async () => {
    const h = harness()
    try {
      const body = ["export const meta = { name: 'twice', description: 'both roots' }", 'return 1'].join('\n')
      writeFileSync(join(h.workspace, '.claude', 'workflows', 'twice.js'), body)
      writeFileSync(join(h.userWorkflows, 'twice.js'), body)
      await expect(h.tool.execute({ name: 'twice' }, h.exec)).rejects.toThrow(/exists in both roots/)
    } finally {
      h.cleanup()
    }
  })

  test('names the available workflows when the name is unknown', async () => {
    const h = harness()
    try {
      writeFileSync(
        join(h.workspace, '.claude', 'workflows', 'known.js'),
        ["export const meta = { name: 'known', description: 'k' }", 'return 1'].join('\n'),
      )
      await expect(h.tool.execute({ name: 'missing' }, h.exec)).rejects.toThrow(/Available: known/)
    } finally {
      h.cleanup()
    }
  })

  test('refuses a script that uses a hook the engine lacks', async () => {
    const h = harness()
    try {
      writeFileSync(
        join(h.workspace, '.claude', 'workflows', 'budgeted.js'),
        ["export const meta = { name: 'budgeted', description: 'uses budget' }", 'const cap = budget({ maxAgents: 2 })', 'return cap'].join('\n'),
      )
      await expect(h.tool.execute({ name: 'budgeted' }, h.exec)).rejects.toThrow(/budget\(\)/)
    } finally {
      h.cleanup()
    }
  })

  test('apply() registers exactly one tool and returns its disposer', () => {
    const registered: unknown[] = []
    const ctx = {
      tools: {
        register: (definition: unknown) => {
          registered.push(definition)
          return () => registered.pop()
        },
      },
      workflowEngine: stubEngine({ runs: 0 }),
    }
    const dispose = apply(ctx as never, {})
    expect(registered).toHaveLength(1)
    expect((registered[0] as { name: string }).name).toBe('workflow_run')
    dispose()
    expect(registered).toHaveLength(0)
  })
})
