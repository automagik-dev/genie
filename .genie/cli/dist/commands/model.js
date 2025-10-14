"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.modelCommand = modelCommand;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const YAML = __importStar(require("yaml"));
/**
 * genie model - Configure default executor (codex or claude)
 *
 * Usage:
 *   genie model              # Show current default
 *   genie model show         # Show current default with details
 *   genie model codex        # Set codex as default
 *   genie model claude       # Set claude as default
 *   genie model detect       # Detect available executors
 */
async function modelCommand(parsed, config, paths) {
    const [subcommand] = parsed.commandArgs;
    if (!subcommand || subcommand === 'show') {
        await showModel(config, paths);
    }
    else if (subcommand === 'detect') {
        await detectExecutors(config, paths);
    }
    else if (subcommand === 'codex' || subcommand === 'claude') {
        await setModel(subcommand, config, paths);
    }
    else {
        console.error(`Unknown subcommand: ${subcommand}`);
        console.error('');
        console.error('Usage:');
        console.error('  genie model              # Show current default');
        console.error('  genie model show         # Show current default with details');
        console.error('  genie model codex        # Set codex as default');
        console.error('  genie model claude       # Set claude as default');
        console.error('  genie model detect       # Detect available executors');
        process.exit(1);
    }
}
async function showModel(config, paths) {
    const currentDefault = config.defaults?.executor || 'codex';
    const available = await getAvailableExecutors();
    console.log('🧞 Genie Executor Configuration');
    console.log('');
    console.log(`Default executor: ${currentDefault}`);
    console.log('');
    console.log('Available executors:');
    if (available.codex) {
        const indicator = currentDefault === 'codex' ? '✓' : ' ';
        console.log(`  [${indicator}] codex  - ${available.codex.version || 'installed'}`);
        console.log(`      Binary: ${available.codex.binary}`);
        console.log(`      Model: ${config.executors?.codex?.exec?.model || 'gpt-5-codex'}`);
    }
    else {
        console.log(`  [ ] codex  - not found`);
    }
    if (available.claude) {
        const indicator = currentDefault === 'claude' ? '✓' : ' ';
        console.log(`  [${indicator}] claude - ${available.claude.version || 'installed'}`);
        console.log(`      Binary: ${available.claude.binary}`);
        console.log(`      Model: ${config.executors?.claude?.exec?.model || 'sonnet'}`);
    }
    else {
        console.log(`  [ ] claude - not found`);
    }
    console.log('');
    console.log('To change default: genie model <codex|claude>');
    console.log('To override per-run: genie run <agent> --executor <codex|claude> "prompt"');
}
async function detectExecutors(config, paths) {
    console.log('🔍 Detecting available executors...');
    console.log('');
    const available = await getAvailableExecutors();
    if (available.codex) {
        console.log('✅ Codex found:');
        console.log(`   Binary: ${available.codex.binary}`);
        console.log(`   Version: ${available.codex.version || 'unknown'}`);
        console.log(`   Package: ${config.executors?.codex?.packageSpec || '@namastexlabs/codex@latest'}`);
    }
    else {
        console.log('❌ Codex not found');
        console.log('   Install: npm install -g @namastexlabs/codex');
    }
    console.log('');
    if (available.claude) {
        console.log('✅ Claude found:');
        console.log(`   Binary: ${available.claude.binary}`);
        console.log(`   Version: ${available.claude.version || 'unknown'}`);
    }
    else {
        console.log('❌ Claude not found');
        console.log('   Install: https://docs.claude.com/docs/claude-code/install');
    }
    console.log('');
    const currentDefault = config.defaults?.executor || 'codex';
    const defaultAvailable = currentDefault === 'codex' ? available.codex : available.claude;
    if (!defaultAvailable) {
        console.log(`⚠️  Warning: Default executor "${currentDefault}" is not available`);
        console.log('');
        if (available.codex && !available.claude) {
            console.log('💡 Recommendation: Set codex as default');
            console.log('   Run: genie model codex');
        }
        else if (available.claude && !available.codex) {
            console.log('💡 Recommendation: Set claude as default');
            console.log('   Run: genie model claude');
        }
        else {
            console.log('❌ No executors available - please install codex or claude');
        }
    }
    else {
        console.log(`✅ Default executor "${currentDefault}" is available`);
    }
}
async function setModel(executor, config, paths) {
    // Verify executor is available
    const available = await getAvailableExecutors();
    const isAvailable = executor === 'codex' ? available.codex : available.claude;
    if (!isAvailable) {
        console.error(`❌ Executor "${executor}" is not available`);
        console.error('');
        console.error('Run "genie model detect" to see available executors');
        process.exit(1);
    }
    // Read config file
    const configPath = path_1.default.resolve('.genie/cli/config.yaml');
    if (!fs_1.default.existsSync(configPath)) {
        console.error(`❌ Config file not found: ${configPath}`);
        console.error('');
        console.error('Are you in a Genie project directory?');
        process.exit(1);
    }
    const configContent = fs_1.default.readFileSync(configPath, 'utf8');
    const configData = YAML.parse(configContent);
    // Update default executor
    if (!configData.defaults) {
        configData.defaults = {};
    }
    const oldDefault = configData.defaults.executor || 'codex';
    configData.defaults.executor = executor;
    // Write back
    const newContent = YAML.stringify(configData, {
        indent: 2,
        lineWidth: 120
    });
    fs_1.default.writeFileSync(configPath, newContent, 'utf8');
    console.log('✅ Default executor updated');
    console.log('');
    console.log(`   Old: ${oldDefault}`);
    console.log(`   New: ${executor}`);
    console.log('');
    console.log(`Future runs will use ${executor} unless overridden by:`);
    console.log('  - Agent frontmatter (genie.executor field)');
    console.log('  - Execution mode override');
    console.log('  - --executor flag');
}
// Helper: Detect which executors are actually available
async function getAvailableExecutors() {
    const result = {
        codex: null,
        claude: null
    };
    // Check Codex
    try {
        const { execFile } = require('child_process');
        const { promisify } = require('util');
        const execFileAsync = promisify(execFile);
        // Try npx codex --version
        try {
            const { stdout } = await execFileAsync('npx', ['--yes', '@namastexlabs/codex@latest', '--version'], {
                timeout: 5000,
                maxBuffer: 1024 * 1024
            });
            result.codex = {
                binary: 'npx @namastexlabs/codex',
                version: stdout.trim()
            };
        }
        catch {
            // Try codex directly
            try {
                const { stdout } = await execFileAsync('codex', ['--version'], {
                    timeout: 5000,
                    maxBuffer: 1024 * 1024
                });
                result.codex = {
                    binary: 'codex',
                    version: stdout.trim()
                };
            }
            catch {
                // Not available
            }
        }
    }
    catch {
        // Not available
    }
    // Check Claude
    try {
        const { execFile } = require('child_process');
        const { promisify } = require('util');
        const execFileAsync = promisify(execFile);
        const { stdout } = await execFileAsync('claude', ['--version'], {
            timeout: 5000,
            maxBuffer: 1024 * 1024
        });
        result.claude = {
            binary: 'claude',
            version: stdout.trim()
        };
    }
    catch {
        // Not available
    }
    return result;
}
