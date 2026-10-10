#!/usr/bin/env node
/**
 * Experiment-only stdio binding; selected artifacts own engines, results and sessions.
 * Native profiles may additionally freeze agentNames, agentBudgets[name].maxIterations,
 * agentConfigSha256[name] and absolute contextRoots. Scored engine profiles expose only wish-context.
 */
import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync,
  readlinkSync, readSync, readdirSync, realpathSync, writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function fileSha256(path) {
  const hash = createHash('sha256');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  const buffer = Buffer.allocUnsafe(65536);
  try {
    for (;;) {
      const count = readSync(fd, buffer, 0, buffer.length, null);
      if (!count) break;
      hash.update(buffer.subarray(0, count));
    }
  } finally { closeSync(fd); }
  return hash.digest('hex');
}

export function inside(root, path) {
  const rel = relative(resolve(root), resolve(path));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** Directory digest includes names, empty directories, regular bytes and internal symlink targets. */
export function directorySha256(root) {
  const hash = createHash('sha256');
  const walk = (path) => {
    for (const name of readdirSync(path).sort()) {
      const child = join(path, name);
      const rel = relative(root, child);
      const stat = lstatSync(child);
      if (stat.isDirectory()) {
        hash.update(JSON.stringify(['directory', rel]));
        walk(child);
      } else if (stat.isFile()) {
        hash.update(JSON.stringify(['file', rel, fileSha256(child)]));
      } else if (stat.isSymbolicLink()) {
        if (!inside(realpathSync(root), realpathSync(child))) throw new Error(`external seal symlink: ${child}`);
        hash.update(JSON.stringify(['symlink', rel, readlinkSync(child)]));
      } else throw new Error(`irregular sealed path: ${child}`);
    }
  };
  walk(root);
  return hash.digest('hex');
}

export function verifySeals(seals) {
  if (!Array.isArray(seals) || !seals.length) throw new Error('missing frozen file seals');
  for (const seal of seals) {
    if (!isAbsolute(seal.path)) throw new Error('seal paths must be absolute');
    if (seal.kind === 'absent') {
      try { lstatSync(seal.path); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      throw new Error(`required absence changed: ${seal.path}`);
    }
    const stat = lstatSync(seal.path);
    const actual = seal.kind === 'directory' && stat.isDirectory() ? directorySha256(seal.path)
      : seal.kind === 'file' && stat.isFile() ? fileSha256(seal.path) : null;
    if (!actual || actual !== seal.sha256) throw new Error(`frozen bytes changed: ${seal.path}`);
  }
}

export function immutableJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
}

export function safeFailureMessage(error) {
  let message = error instanceof Error ? error.message : 'non-Error backend failure';
  for (const name in process.env) {
    const value = process.env[name];
    if (value && /KEY|TOKEN|PASSWORD|SECRET|CREDENTIAL/i.test(name)) message = message.replaceAll(value, '[redacted]');
  }
  return message.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9+\/=_.:-]+/gi, '$1 [redacted]');
}

function privateCredential(reference) {
  if (!reference || !/^[A-Z_][A-Z0-9_]*$/.test(reference.envName) || !isAbsolute(reference.keyFile)) {
    throw new Error('invalid private credential reference');
  }
  const fd = openSync(reference.keyFile, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    const parent = lstatSync(dirname(reference.keyFile));
    if (!stat.isFile() || (stat.mode & 0o077) || !parent.isDirectory() || (parent.mode & 0o077)) {
      throw new Error('credential file/directory permissions must be private');
    }
    const key = readFileSync(fd, 'utf8').trim();
    if (!key || /\s|[\u0000-\u001f\u007f]/.test(key)) throw new Error('invalid private credential');
    process.env[reference.envName] = key;
  } finally { closeSync(fd); }
}

async function runtime(argv) {
  const profileIndex = argv.indexOf('--profile');
  if (profileIndex < 0 || !argv[profileIndex + 1]) throw new Error('--profile is required');
  const profilePath = resolve(argv[profileIndex + 1]);
  const profile = JSON.parse(readFileSync(profilePath, 'utf8'));
  if (profile.version !== 1 || !['old', 'new'].includes(profile.generation)
    || !['rlm', 'pi'].includes(profile.engine) || (profile.generation === 'old' && profile.engine !== 'rlm')) {
    throw new Error('unsupported runtime profile');
  }
  if (process.version !== 'v26.7.0') throw new Error('experiment requires the frozen Node v26.7.0 runtime');
  for (const field of ['artifactRoot', 'configRoot', 'agentsDir', 'homeRoot', 'receiptRoot']) {
    if (typeof profile[field] !== 'string' || !isAbsolute(profile[field])) throw new Error(`invalid ${field}`);
  }
  verifySeals(profile.seals);
  process.env.HOME = profile.homeRoot;
  process.env.PATH = profile.runtimePath;
  process.env.MIKRO_AGENTS_DIR = profile.agentsDir;
  process.env.MIKRO_MCP_RUN_TIMEOUT_MS = '600000';
  delete process.env.MIKRO_FACTS;
  const artifact = (path) => import(pathToFileURL(join(profile.artifactRoot, 'dist/src', path)).href);
  const version = await artifact('version.js');
  if (version.VERSION !== profile.provenance.version) throw new Error('artifact version changed');
  if (argv.includes('--version')) { process.stdout.write(`${version.VERSION}\n`); return; }
  // stdout belongs solely to MCP. Do this before importing the backend dependency graph.
  for (const method of ['log', 'info', 'debug', 'warn']) console[method] = (...values) => {
    process.stderr.write(`${values.map(String).join(' ')}\n`);
  };
  const [serverApi, configApi, agentsApi, llmApi, backendApi] = await Promise.all([
    artifact('mcp/server.js'), artifact('config.js'), artifact('mcp/agents.js'), artifact('llm.js'), artifact('mcp/backend.js'),
  ]);
  for (const name of ['runTurn', 'selectBackend', 'buildToolList', 'sessionResult', 'McpSessionStore', 'applyAgent', 'buildResumeQuery']) {
    if (typeof serverApi[name] !== 'function') throw new Error(`selected artifact lacks supported exported seam: ${name}`);
  }
  const agents = await agentsApi.discoverAgents(profile.configRoot);
  const agentNames = profile.agentNames ?? ['wish-context'];
  if (!Array.isArray(agentNames) || agents.length !== agentNames.length
    || !agents.every((agent) => agentNames.includes(agent.name))) throw new Error('discovered agents differ from frozen profile');
  const baseConfig = await configApi.loadConfig(profile.configRoot);
  const byTool = new Map();
  for (const agent of agents) {
    const expectedIterations = profile.agentBudgets?.[agent.name]?.maxIterations ?? 16;
    if (agent.spec.budget?.maxIterations !== expectedIterations || agent.spec.budget?.maxCost !== 0.3
      || agent.spec.budget?.maxDepth !== 0) {
      throw new Error('agent iterations/cost/depth do not match frozen controls');
    }
    // Historical spelling is confined to the immutable old control.
    if (profile.generation === 'old' && agent.spec.backend !== undefined && agent.spec.backend !== 'mikro') {
      throw new Error('old control is not the historical RLM backend');
    }
    const config = serverApi.applyAgent(baseConfig, agent);
    // Raw config parsers reject zero; applyAgent omits the pack's supported maxDepth declaration.
    // Bind only that exact frozen declaration to the owned programmatic engine config.
    const loadedMaxDepth = config.budget.maxDepth;
    config.budget.maxDepth = agent.spec.budget.maxDepth;
    if (config.budget.maxDepth !== 0 || config.budget.maxCost !== 0.3) {
      throw new Error('effective config must bind maxDepth=0/maxCost=.30; MCP CLI flags do not enforce these');
    }
    if (config.model.provider !== profile.provider || config.model.model !== profile.model) throw new Error('resolved model differs');
    const model = llmApi.resolveModel(config.model.provider, config.model.model, config.model.providers);
    if (model.id !== profile.model || model.api !== profile.api || model.baseUrl !== profile.baseUrl) {
      throw new Error('resolved model/API/endpoint differs from frozen profile');
    }
    const declared = config.model.providers?.find((provider) => provider.id === profile.provider)?.models
      .find((candidate) => candidate.id === profile.model);
    if (profile.generation === 'new' && declared
      && (!Number.isFinite(declared.cost?.input) || !Number.isFinite(declared.cost?.output))) {
      throw new Error('candidate SDK nominal input/output rates must be explicitly declared before any engine dispatch');
    }
    const effectiveConfigSha256 = sha256(JSON.stringify(config));
    const binding = {
      profileSha256: fileSha256(profilePath), artifactRoot: profile.artifactRoot,
      node: process.execPath, nodeVersion: process.version, generation: profile.generation, engine: profile.engine,
      agent: agent.name, toolName: agent.toolName, maxIterations: expectedIterations,
      budgetBinding: { maxDepth: config.budget.maxDepth, loadedMaxDepth,
        maxDepthSource: 'agent.spec.budget.maxDepth', method: 'programmatic-after-applyAgent' },
      provider: model.provider, model: model.id, api: model.api, baseUrl: model.baseUrl,
      effectiveConfigSha256, systemSha256: sha256(agent.system ?? ''),
      sdkNominalRates: model.cost, provenance: profile.provenance,
      modelCapabilities: { reasoning: model.reasoning, input: model.input, contextWindow: model.contextWindow,
        maxTokens: model.maxTokens, thinkingLevelMap: model.thinkingLevelMap, compat: model.compat },
      modelOptions: { thinkingLevel: config.gemini.thinkingLevel, temperature: config.temperature ?? null,
        cache: config.cache, outputSchemaSha256: sha256(JSON.stringify(config.output.schema)),
        packSchemaSha256: sha256(JSON.stringify(config.validate?.schema ?? null)) },
    };
    const expectedHash = profile.agentConfigSha256?.[agent.name] ?? profile.effectiveConfigSha256;
    if (!argv.includes('--describe') && effectiveConfigSha256 !== expectedHash) throw new Error('effective external config changed');
    const backend = profile.generation === 'old' ? serverApi.selectBackend(agent) : serverApi.selectBackend(agent, profile.engine);
    if (typeof backend?.run !== 'function') throw new Error('selected artifact does not expose the frozen engine');
    byTool.set(agent.toolName, { agent, config, binding });
  }
  const first = byTool.values().next().value;
  if (!first) throw new Error('no frozen agents');
  const { config, binding } = first;
  const tierEvents = [];
  if (profile.requestOptions?.serviceTier !== undefined) {
    if (profile.generation !== 'new' || profile.requestOptions.serviceTier !== 'fast'
      || profile.model !== 'gpt-6-luna' || profile.api !== 'openai-responses'
      || !config.model.providers?.some((provider) => provider.id === profile.provider)) {
      throw new Error('fast tier requires the exact advertised Luna model and isolated Responses provider');
    }
    // These files are the installed package's public ./api/* and ./models export targets.
    const sdkImport = (name) => import(pathToFileURL(join(profile.artifactRoot,
      'node_modules/@earendil-works/pi-ai/dist', `${name}.js`)).href);
    const [responses, simple, sdkModels] = await Promise.all([
      sdkImport('api/openai-responses'), sdkImport('api/simple-options'), sdkImport('models'),
    ]);
    const models = llmApi.getModelRuntime(config.model.providers);
    const provider = models.getProvider(profile.provider);
    if (!provider) throw new Error('isolated Responses provider is unavailable');
    // Only this config-scoped provider is replaced; Pi registers the same native provider.
    // Full SDK owns requests, auth delegation, retries and served/request-tier pricing.
    models.setProvider({
      ...provider,
      streamSimple(selected, context, options) {
        const base = simple.buildBaseOptions(selected, context, options, options?.apiKey);
        const level = options?.reasoning ? sdkModels.clampThinkingLevel(selected, options.reasoning) : undefined;
        return responses.stream(selected, context, {
          ...base, toolChoice: options?.toolChoice, reasoningEffort: level === 'off' ? undefined : level,
          serviceTier: 'fast',
          onProviderStreamEvent(event, selectedModel) {
            if (event?.type === 'response.completed') {
              tierEvents.push({ requested: 'fast', served: event.response?.service_tier ?? null,
                model: event.response?.model ?? null });
            }
            return options?.onProviderStreamEvent?.(event, selectedModel);
          },
        });
      },
    });
  }
  if (argv.includes('--describe')) {
    process.stdout.write(`${JSON.stringify({ ...binding, agents: [...byTool.values()].map((entry) => entry.binding) })}\n`);
    return;
  }
  if (argv.includes('--check')) { process.stdout.write(`${JSON.stringify(binding)}\n`); return; }
  if (profile.credential) privateCredential(profile.credential);
  const dirIndex = argv.indexOf('--dir');
  const cwd = realpathSync(dirIndex < 0 ? process.cwd() : resolve(argv[dirIndex + 1]));
  if (!argv.includes('mcp') || inside(cwd, profile.configRoot) || inside(cwd, profile.agentsDir)) {
    throw new Error('MCP requires external controls, never a parent truth overlay');
  }
  // Match the selected CLI: Python subprocesses inherit this target, while Pi receives it explicitly.
  process.chdir(cwd);
  const receiptDir = process.env.MIKRO_EXPERIMENT_RECEIPT_DIR;
  if (!receiptDir || !inside(profile.receiptRoot, receiptDir) || resolve(receiptDir) === resolve(profile.receiptRoot)) {
    throw new Error('owned MIKRO_EXPERIMENT_RECEIPT_DIR below profile.receiptRoot is required');
  }
  mkdirSync(receiptDir, { recursive: true, mode: 0o700 });
  const require = createRequire(join(profile.artifactRoot, 'package.json'));
  const [{ Server }, { StdioServerTransport }, { CallToolRequestSchema, ListToolsRequestSchema }] = await Promise.all([
    import(pathToFileURL(require.resolve('@modelcontextprotocol/sdk/server/index.js')).href),
    import(pathToFileURL(require.resolve('@modelcontextprotocol/sdk/server/stdio.js')).href),
    import(pathToFileURL(require.resolve('@modelcontextprotocol/sdk/types.js')).href),
  ]);
  const sessions = new serverApi.McpSessionStore();
  const server = new Server({ name: 'mikro', version: version.VERSION }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: serverApi.buildToolList(agents).filter((tool) => byTool.has(tool.name)),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const selected = byTool.get(request.params.name);
    const args = request.params.arguments ?? {};
    if (!selected || typeof args.prompt !== 'string' || !args.prompt.trim()
      || Object.hasOwn(args, 'backend') || (args.engine !== undefined && args.engine !== profile.engine)) {
      return serverApi.textResult('request does not match frozen controls', true);
    }
    const { agent, config, binding } = selected;
    let contextPath;
    if (args.context !== undefined) {
      if (typeof args.context !== 'string' || !isAbsolute(args.context)
        || !(profile.contextRoots ?? []).some((root) => inside(root, realpathSync(args.context)))) {
        return serverApi.textResult('context is not within frozen external facts roots', true);
      }
      contextPath = args.context;
    }
    const session = args.session_id ? sessions.get(args.session_id) : sessions.create(agent.toolName);
    if (!session || session.toolName !== agent.toolName || session.busy) return serverApi.textResult('unknown or busy session', true);
    session.busy = true;
    const id = randomUUID();
    const startedAt = new Date().toISOString();
    const tierStart = tierEvents.length;
    const query = serverApi.buildResumeQuery(session.turns, args.prompt);
    immutableJson(join(receiptDir, `${id}.started.json`), {
      version: 1, id, sessionId: session.id, startedAt, cwd, binding,
      promptSha256: sha256(args.prompt), dispatchedQuerySha256: sha256(query), prompt: args.prompt,
      contextPath: contextPath ?? null,
      contextSha256: contextPath ? (lstatSync(contextPath).isDirectory() ? directorySha256(contextPath) : fileSha256(contextPath)) : null,
    });
    const actual = profile.generation === 'old' ? serverApi.selectBackend(agent) : serverApi.selectBackend(agent, profile.engine);
    let observed = null;
    // This wrapper observes once. It does not add usage, change outputs or perform an engine call of its own.
    const backend = { run: async (...arguments_) => {
      try {
        const result = await actual.run(...arguments_);
        observed = { kind: 'returned', iterations: result.iterations, budgetHit: result.budgetHit ?? null,
          validationFailed: result.validationFailed ?? false, usage: result.usage ?? null,
          usageComplete: result.usage ? result.usageComplete !== false : false };
        return result;
      } catch (error) {
        const receipt = typeof backendApi.BackendRunError === 'function' && error instanceof backendApi.BackendRunError
          ? error.receipt : undefined;
        const failureUsage = typeof llmApi.LLMCompletionError === 'function' && error instanceof llmApi.LLMCompletionError
          ? error.usage : undefined;
        observed = { kind: 'thrown', iterations: receipt?.iterations ?? null,
          usage: receipt?.usage ?? failureUsage ?? null, usageComplete: Boolean(receipt?.usage && receipt.usageComplete !== false),
          errorType: error instanceof Error ? error.constructor.name : 'UnknownError', error: safeFailureMessage(error) };
        throw error;
      }
    } };
    try {
      const progressToken = request.params._meta?.progressToken;
      const progress = progressToken === undefined ? undefined : (message) => {
        void server.notification({ method: 'notifications/progress', params: { progressToken, progress: 0, message } }).catch(() => {});
      };
      const outcome = await serverApi.runTurn(backend, agent, config, `agent=${agent.name}`,
        query, session.id, contextPath, cwd, progress, binding.maxIterations, extra.signal);
      sessions.record(session, { prompt: args.prompt, answer: outcome.answer });
      immutableJson(join(receiptDir, `${id}.result.json`), {
        version: 1, id, sessionId: session.id, startedAt, finishedAt: new Date().toISOString(), binding,
        failed: outcome.failed, observed, costKind: 'sdk-nominal-estimate-not-invoice',
        requestOptions: profile.requestOptions ?? null, tierEvents: tierEvents.slice(tierStart),
      });
      return serverApi.sessionResult(outcome.text, session.id, outcome.failed);
    } catch (error) {
      immutableJson(join(receiptDir, `${id}.result.json`), {
        version: 1, id, sessionId: session.id, startedAt, finishedAt: new Date().toISOString(), binding,
        failed: true, observed, errorType: error instanceof Error ? error.constructor.name : 'UnknownError',
        error: safeFailureMessage(error),
        costKind: 'sdk-nominal-estimate-not-invoice',
        requestOptions: profile.requestOptions ?? null, tierEvents: tierEvents.slice(tierStart),
      });
      return serverApi.sessionResult(`mikro ${agent.toolName} failed: ${safeFailureMessage(error)}`, session.id, true);
    } finally { session.busy = false; }
  });
  await server.connect(new StdioServerTransport());
  process.stdout.on('error', () => process.exit(0));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runtime(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`engine experiment runtime: ${error.message}\n`);
    process.exitCode = 1;
  });
}
