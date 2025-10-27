"use strict";
/**
 * Install Flow Helpers - Master Genie orchestration for fresh installations
 *
 * Architecture:
 * 1. Launch Master Genie with discovery + installation prompt
 * 2. User continues in Forge dashboard via shortened URL
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.printBox = printBox;
exports.buildExplorePrompt = buildExplorePrompt;
exports.runExploreAgent = runExploreAgent;
exports.buildMasterGeniePrompt = buildMasterGeniePrompt;
exports.launchMasterGenieInstall = launchMasterGenieInstall;
exports.runInstallFlow = runInstallFlow;
const gradient_string_1 = __importDefault(require("gradient-string"));
const child_process_1 = require("child_process");
// Import ForgeExecutor for workspace project management
const forge_executor_js_1 = require("./forge-executor.js");
const FORGE_URL = process.env.FORGE_BASE_URL || 'http://localhost:8887';
// Import from compiled MCP dist (will be available after build)
let shortenUrl;
let getApiKeyFromEnv;
try {
    const urlShortener = require('../../mcp/dist/lib/url-shortener.js');
    shortenUrl = urlShortener.shortenUrl;
    getApiKeyFromEnv = urlShortener.getApiKeyFromEnv;
}
catch {
    // Fallback if MCP not built yet
    shortenUrl = async (url) => ({ success: false, fullUrl: url });
    getApiKeyFromEnv = () => undefined;
}
/**
 * Print a gradient box to console
 */
function printBox(title, content) {
    const border = '═'.repeat(60);
    console.log(gradient_string_1.default.pastel(`╔${border}╗`));
    console.log(gradient_string_1.default.pastel(`║ ${title.padEnd(58)} ║`));
    console.log(gradient_string_1.default.pastel(`╠${border}╣`));
    console.log(content);
    console.log(gradient_string_1.default.pastel(`╚${border}╝`));
}
/**
 * Build explore agent prompt for context gathering
 */
function buildExplorePrompt() {
    return `You are the Explore agent conducting project discovery for installation.

@.genie/spells/install-genie.md

**Mission:** Execute Phase 1-3 (Detect Repo State → Silent Analysis → Build Context)

Analyze this repository and provide structured context covering:

**1. Project Identity**
- Name (from package.json, git remote, or directory)
- Purpose (from README, package description)
- Domain/industry

**2. Tech Stack**
- Languages (file extensions)
- Frameworks (dependencies from package.json)
- Package manager (pnpm, npm, yarn)
- Deployment target

**3. Architecture**
- Type (web_app, api, cli, library, mobile)
- Directory structure (src/, tests/, docs/)
- Entry points (main files)

**4. Existing Progress**
- Git commits count (if git repo)
- Features (from README ## Features section)
- Development status (mvp, production, prototype)

**5. Detection Confidence**
- HIGH confidence items (use directly, don't ask user)
- MEDIUM/LOW confidence items (Master Genie will ask user in interview)

**IMPORTANT:** Return your final analysis as structured JSON in your LAST MESSAGE.
Use this format:
\`\`\`json
{
  "project": { "name": "...", "purpose": "...", "domain": "..." },
  "tech": { "languages": [], "frameworks": [], "packageManager": "..." },
  "architecture": { "type": "...", "structure": {}, "entryPoints": [] },
  "progress": { "commits": 0, "features": [], "status": "..." },
  "confidence": { "high": {}, "medium": {}, "low": {} }
}
\`\`\`

**Read-only:** Do not modify any files.
**No interview:** Master Genie will interview user with your findings.
`;
}
/**
 * Run explore agent, stream output to console, return last message
 */
async function runExploreAgent(prompt) {
    const forgeExecutor = (0, forge_executor_js_1.createForgeExecutor)({ forgeBaseUrl: FORGE_URL });
    console.log('');
    printBox('🔍 PROJECT DISCOVERY', 'Analyzing your repository...');
    console.log('');
    // Get or create workspace-specific Forge project (not hardcoded!)
    // @ts-ignore - getOrCreateGenieProject is private but needed here
    const projectId = await forgeExecutor['getOrCreateGenieProject']();
    // Get ForgeClient for raw API access
    // @ts-ignore - forge is private but needed here
    const forgeClient = forgeExecutor['forge'];
    // Create explore task (read-only context gathering)
    const result = await forgeClient.createAndStartTask({
        task: {
            project_id: projectId,
            title: '🔍 Installation Discovery',
            description: prompt
        },
        executor_profile_id: {
            executor: 'CLAUDE_CODE',
            variant: 'CODE_EXPLORE' // Correct variant name (collective_agent)
        },
        base_branch: getCurrentBranch()
    });
    const taskId = result.task?.id || result.id;
    const attemptId = result.task_attempt?.id || result.attempts?.[0]?.id;
    // Validate attemptId exists (debugging aid for API response changes)
    if (!attemptId) {
        console.error('⚠️  Failed to extract attemptId from Forge response');
        console.error('   Response structure:', JSON.stringify(result, null, 2));
        throw new Error('Forge API returned unexpected response structure - no attemptId found');
    }
    // Poll for completion and stream updates
    console.log('⏳ Gathering context...\n');
    let lastOutput = '';
    const maxWaitTime = 120000; // 2 minutes
    const pollInterval = 2000; // 2 seconds
    const startTime = Date.now();
    while (Date.now() - startTime < maxWaitTime) {
        try {
            const attempt = await forgeClient.getTaskAttempt(attemptId);
            // Get latest output
            const processes = await forgeClient.listExecutionProcesses(attemptId);
            if (processes && processes.length > 0) {
                const latest = processes[processes.length - 1];
                if (latest.output && latest.output !== lastOutput) {
                    // Print new output (show progress)
                    const newContent = latest.output.substring(lastOutput.length);
                    if (newContent.trim()) {
                        process.stdout.write(gradient_string_1.default.pastel('  '));
                        process.stdout.write(gradient_string_1.default.pastel(newContent.substring(0, 200))); // First 200 chars
                        if (newContent.length > 200)
                            process.stdout.write(gradient_string_1.default.pastel('...'));
                        process.stdout.write('\n');
                    }
                    lastOutput = latest.output;
                }
            }
            // Check if completed
            if (attempt.status === 'completed' || attempt.status === 'failed') {
                break;
            }
            await new Promise(resolve => setTimeout(resolve, pollInterval));
        }
        catch (error) {
            // Continue polling on error
        }
    }
    console.log('');
    console.log(gradient_string_1.default.pastel('✅ Context gathered!\n'));
    return lastOutput;
}
/**
 * Build Master Genie install prompt with injected context
 */
function buildMasterGeniePrompt(exploreContext, templates) {
    return `You are Master Genie, orchestrating installation.

@.genie/spells/install-genie.md

**Context from Explore Agent:**
${exploreContext}

**Templates Selected:** ${templates.join(', ')}

**Your Mission:**
1. Review the context above (project identity, tech stack, architecture, progress)
2. Follow install-genie.md workflow Phase 4-6:
   - Phase 4: Validate context with user (interview for missing/low-confidence items)
   - Phase 5: Spawn specialized agents (Code/Create install based on templates)
   - Phase 6: Monitor & coordinate completion

**IMPORTANT:**
- User interview is REQUIRED (Phase 4) - validate explore findings, ask about missing items
- Technical assessment (Phase 0) was done in wizard - adapt communication accordingly
- Spawn agents with unified context (no duplicate interviews by specialists)
- Report completion with next steps

**Execution Mode:** Interactive (interview user, spawn agents, coordinate)
`;
}
/**
 * Launch Master Genie install task in Forge, return shortened URL
 */
async function launchMasterGenieInstall(context, config) {
    const forgeExecutor = (0, forge_executor_js_1.createForgeExecutor)({ forgeBaseUrl: FORGE_URL });
    const installPrompt = buildMasterGeniePrompt(context, config.templates);
    console.log('');
    printBox('🧞 MASTER GENIE AWAKENING', 'Starting installation orchestration...');
    console.log('');
    // Get or create workspace-specific Forge project (not hardcoded!)
    // @ts-ignore - getOrCreateGenieProject is private but needed here
    const projectId = await forgeExecutor['getOrCreateGenieProject']();
    // Get ForgeClient for raw API access
    // @ts-ignore - forge is private but needed here
    const forgeClient = forgeExecutor['forge'];
    // Create Master Genie Forge task
    const result = await forgeClient.createAndStartTask({
        task: {
            project_id: projectId,
            title: '🧞 Genie Installation & Setup',
            description: installPrompt
        },
        executor_profile_id: {
            executor: config.executor.toUpperCase(),
            variant: 'DEFAULT'
        },
        base_branch: getCurrentBranch()
    });
    const taskId = result.task?.id || result.id;
    const attemptId = result.task_attempt?.id || result.attempts?.[0]?.id;
    // Validate attemptId exists (debugging aid for API response changes)
    if (!attemptId) {
        console.error('⚠️  Failed to extract attemptId from Forge response');
        console.error('   Response structure:', JSON.stringify(result, null, 2));
        throw new Error('Forge API returned unexpected response structure - no attemptId found');
    }
    // Build full Forge URL
    const fullUrl = `${FORGE_URL}/projects/${projectId}/tasks/${taskId}/attempts/${attemptId}?view=diffs`;
    // Shorten URL
    const { shortUrl: shortened } = await shortenUrl(fullUrl, {
        apiKey: getApiKeyFromEnv()
    });
    return shortened || fullUrl;
}
/**
 * Main install flow orchestrator
 */
async function runInstallFlow(config) {
    // Step 1: Run explore agent (context gathering)
    const explorePrompt = buildExplorePrompt();
    const exploreContext = await runExploreAgent(explorePrompt);
    // Step 2: Launch Master Genie with injected context
    const shortUrl = await launchMasterGenieInstall(exploreContext, config);
    return shortUrl;
}
/**
 * Get current git branch (suppresses stderr to avoid scary errors in new repos)
 */
function getCurrentBranch() {
    try {
        return (0, child_process_1.execSync)('git rev-parse --abbrev-ref HEAD', {
            encoding: 'utf8',
            stdio: ['pipe', 'pipe', 'pipe'] // Suppress stderr
        }).trim();
    }
    catch {
        // Return 'main' for brand new repos (no commits yet) or non-git directories
        return 'main';
    }
}
