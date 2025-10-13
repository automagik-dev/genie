"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.detectInstallType = detectInstallType;
exports.backupGenie = backupGenie;
exports.analyzeAgents = analyzeAgents;
exports.extractCustomizations = extractCustomizations;
exports.copyTemplates = copyTemplates;
exports.runMigration = runMigration;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const child_process_1 = require("child_process");
// Core agents that ship with npm package (should NOT be in user .genie/agents/)
const CORE_AGENT_IDS = [
    // Top-level orchestrators
    'plan', 'wish', 'forge', 'review', 'orchestrator', 'vibe',
    // Core delivery agents
    'core/analyze', 'core/audit', 'core/commit', 'core/debug',
    'core/git-workflow', 'core/github-workflow', 'core/implementor',
    'core/install', 'core/learn', 'core/polish', 'core/prompt',
    'core/refactor', 'core/tests',
    // Orchestrator modes
    'core/modes/challenge', 'core/modes/consensus', 'core/modes/docgen',
    'core/modes/explore', 'core/modes/tracer',
    // QA agents
    'qa/genie-qa'
];
/**
 * Detects if this is a clean install or needs migration
 */
function detectInstallType() {
    const genieDir = '.genie';
    if (!fs_1.default.existsSync(genieDir)) {
        return 'clean';
    }
    const agentsDir = path_1.default.join(genieDir, 'agents');
    if (!fs_1.default.existsSync(agentsDir)) {
        return 'clean';
    }
    // Check if agents/core/ exists with proper structure
    const coreDir = path_1.default.join(agentsDir, 'core');
    if (fs_1.default.existsSync(coreDir)) {
        // Has core/ subdirectory - likely new structure OR mid-migration
        const coreAgents = fs_1.default.readdirSync(coreDir).filter(f => f.endsWith('.md'));
        // If core/ has agents, this is old structure (agents in repo)
        // New structure has empty .genie/agents/, core comes from npm
        if (coreAgents.length > 0) {
            return 'old_genie';
        }
        return 'already_new';
    }
    // Check for top-level core agents (very old structure)
    const topLevelAgents = fs_1.default.readdirSync(agentsDir).filter(f => f.endsWith('.md'));
    const hasCoreAgents = topLevelAgents.some(f => CORE_AGENT_IDS.map(id => id.split('/').pop()).includes(f.replace('.md', '')));
    return hasCoreAgents ? 'old_genie' : 'already_new';
}
/**
 * Creates timestamped backup of .genie/ directory
 */
function backupGenie() {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').split('T').join('-').slice(0, -5);
    const backupPath = `.genie-backup-${timestamp}`;
    (0, child_process_1.execSync)(`cp -r .genie "${backupPath}"`);
    return backupPath;
}
/**
 * Analyzes which agents are custom (user-created) vs core (framework)
 */
function analyzeAgents() {
    const agentsDir = '.genie/agents';
    const result = {
        core: [],
        custom: [],
        modified: []
    };
    if (!fs_1.default.existsSync(agentsDir)) {
        return result;
    }
    const walkDir = (dir, prefix = '') => {
        const entries = fs_1.default.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
            if (entry.name === 'README.md')
                continue;
            const fullPath = path_1.default.join(dir, entry.name);
            const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
            if (entry.isDirectory()) {
                walkDir(fullPath, relativePath);
            }
            else if (entry.name.endsWith('.md')) {
                const agentId = relativePath.replace(/\.md$/, '');
                if (CORE_AGENT_IDS.includes(agentId)) {
                    // TODO: Check if modified from framework default
                    // For now, assume all core agents should be removed
                    result.core.push(agentId);
                }
                else {
                    result.custom.push(agentId);
                }
            }
        }
    };
    walkDir(agentsDir);
    return result;
}
/**
 * Extracts customizations from modified core agents to .genie/custom/
 */
function extractCustomizations(coreAgents) {
    const extracted = [];
    // TODO: Implement diff-based extraction
    // For now, we'll preserve by moving to .genie/custom/
    return extracted;
}
/**
 * Copies templates from npm package to user project
 */
function copyTemplates(options = {}) {
    // Resolve npm package location
    const packageRoot = path_1.default.resolve(__dirname, '../../../..');
    const templatesSource = path_1.default.join(packageRoot, 'templates', 'base');
    if (!fs_1.default.existsSync(templatesSource)) {
        throw new Error(`Templates not found at ${templatesSource}`);
    }
    // Copy .claude/ directory (npm-referencing aliases)
    const claudeSource = path_1.default.join(templatesSource, '.claude');
    const claudeDest = '.claude';
    if (fs_1.default.existsSync(claudeDest) && !options.force) {
        console.warn(`⚠️  .claude/ exists, skipping (use --force to overwrite)`);
    }
    else {
        if (fs_1.default.existsSync(claudeDest)) {
            (0, child_process_1.execSync)(`rm -rf ${claudeDest}`);
        }
        (0, child_process_1.execSync)(`cp -r "${claudeSource}" "${claudeDest}"`);
    }
    // Copy .genie/custom/ stubs (merge with existing)
    const customSource = path_1.default.join(templatesSource, '.genie', 'custom');
    const customDest = path_1.default.join('.genie', 'custom');
    if (!fs_1.default.existsSync(customDest)) {
        fs_1.default.mkdirSync(customDest, { recursive: true });
    }
    const customStubs = fs_1.default.readdirSync(customSource);
    for (const stub of customStubs) {
        const stubSource = path_1.default.join(customSource, stub);
        const stubDest = path_1.default.join(customDest, stub);
        if (!fs_1.default.existsSync(stubDest)) {
            fs_1.default.copyFileSync(stubSource, stubDest);
        }
    }
    // Copy product/ and standards/ templates if they don't exist
    const copyIfMissing = (subdir) => {
        const source = path_1.default.join(templatesSource, '.genie', subdir);
        const dest = path_1.default.join('.genie', subdir);
        if (!fs_1.default.existsSync(dest)) {
            (0, child_process_1.execSync)(`cp -r "${source}" "${dest}"`);
        }
    };
    copyIfMissing('product');
    copyIfMissing('standards');
    // Ensure state/ and wishes/ directories exist
    ['state', 'wishes'].forEach(dir => {
        const dirPath = path_1.default.join('.genie', dir);
        if (!fs_1.default.existsSync(dirPath)) {
            fs_1.default.mkdirSync(dirPath, { recursive: true });
        }
    });
    // Copy root documentation files if missing
    const rootDocs = ['AGENTS.md', 'CLAUDE.md', 'README.md', '.gitignore'];
    for (const doc of rootDocs) {
        const source = path_1.default.join(templatesSource, doc);
        const dest = doc;
        if (fs_1.default.existsSync(source) && !fs_1.default.existsSync(dest)) {
            fs_1.default.copyFileSync(source, dest);
        }
    }
}
/**
 * Main migration orchestrator
 */
async function runMigration(options = {}) {
    const result = {
        status: 'failed',
        customAgentsPreserved: [],
        coreAgentsRemoved: [],
        customizationsExtracted: [],
        errors: [],
        warnings: []
    };
    try {
        // Step 1: Detect installation type
        const installType = detectInstallType();
        console.log(`📊 Installation type: ${installType}`);
        if (installType === 'clean') {
            console.log('✨ Clean installation detected');
            if (!options.dryRun) {
                copyTemplates(options);
            }
            result.status = 'clean_install';
            return result;
        }
        if (installType === 'already_new') {
            console.log('✅ Already using new structure');
            result.status = 'already_migrated';
            return result;
        }
        // Step 2: Backup existing installation
        console.log('💾 Creating backup...');
        if (!options.dryRun) {
            result.backupPath = backupGenie();
            console.log(`   Backup created: ${result.backupPath}`);
        }
        // Step 3: Analyze agents
        console.log('🔍 Analyzing agents...');
        const analysis = analyzeAgents();
        console.log(`   Core agents: ${analysis.core.length}`);
        console.log(`   Custom agents: ${analysis.custom.length}`);
        console.log(`   Modified: ${analysis.modified.length}`);
        result.customAgentsPreserved = analysis.custom;
        // Step 4: Extract customizations from modified core agents
        if (analysis.modified.length > 0) {
            console.log('📝 Extracting customizations...');
            if (!options.dryRun) {
                result.customizationsExtracted = extractCustomizations(analysis.modified);
            }
        }
        // Step 5: Remove core agents (they'll come from npm)
        console.log('🗑️  Removing core agents (now in npm package)...');
        if (!options.dryRun) {
            for (const agentId of analysis.core) {
                const agentPath = path_1.default.join('.genie', 'agents', `${agentId}.md`);
                if (fs_1.default.existsSync(agentPath)) {
                    fs_1.default.unlinkSync(agentPath);
                    result.coreAgentsRemoved.push(agentId);
                }
            }
            // Clean up empty directories
            const cleanEmptyDirs = (dir) => {
                if (!fs_1.default.existsSync(dir))
                    return;
                const entries = fs_1.default.readdirSync(dir, { withFileTypes: true });
                // Recursively clean subdirectories first
                for (const entry of entries) {
                    if (entry.isDirectory()) {
                        cleanEmptyDirs(path_1.default.join(dir, entry.name));
                    }
                }
                // If directory is empty, remove it
                const remaining = fs_1.default.readdirSync(dir);
                if (remaining.length === 0 || (remaining.length === 1 && remaining[0] === 'README.md')) {
                    (0, child_process_1.execSync)(`rm -rf "${dir}"`);
                }
            };
            cleanEmptyDirs(path_1.default.join('.genie', 'agents', 'core'));
            cleanEmptyDirs(path_1.default.join('.genie', 'agents', 'qa'));
        }
        // Step 6: Copy new templates
        console.log('📦 Installing new template structure...');
        if (!options.dryRun) {
            copyTemplates(options);
        }
        // Step 7: Success!
        console.log('✅ Migration complete!');
        result.status = 'upgraded';
        // Summary
        console.log('\n📋 Migration Summary:');
        console.log(`   Backup: ${result.backupPath}`);
        console.log(`   Custom agents preserved: ${result.customAgentsPreserved.length}`);
        console.log(`   Core agents removed: ${result.coreAgentsRemoved.length}`);
        if (result.customizationsExtracted.length > 0) {
            console.log(`   Customizations extracted: ${result.customizationsExtracted.length}`);
        }
    }
    catch (error) {
        result.errors.push(error instanceof Error ? error.message : String(error));
        console.error('❌ Migration failed:', error);
    }
    return result;
}
