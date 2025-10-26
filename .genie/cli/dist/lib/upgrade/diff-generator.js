"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.generateFrameworkDiff = generateFrameworkDiff;
const path_1 = __importDefault(require("path"));
const fs_1 = require("fs");
const child_process_1 = require("child_process");
const fs_utils_1 = require("../fs-utils");
const TEMPLATE_CACHE_DIR = path_1.default.join(process.env.HOME || '/tmp', '.genie', 'templates');
const TEMPLATE_REPO = 'https://github.com/namastexlabs/automagik-genie.git';
/**
 * Generate git diff between old and new framework versions
 */
async function generateFrameworkDiff(context) {
    const { oldCommit, newCommit } = context;
    // Ensure template repo is cached locally
    const templatePath = await ensureTemplateRepo();
    // Update repo to latest
    (0, child_process_1.execSync)('git fetch --all --tags', {
        cwd: templatePath,
        stdio: 'pipe'
    });
    // Generate diff for framework files only
    const frameworkGlobs = [
        'AGENTS.md',
        'CLAUDE.md',
        '.genie/spells/*.md',
        '.genie/code/AGENTS.md',
        '.genie/code/agents/*.md',
        '.genie/code/workflows/*.md',
        '.genie/create/AGENTS.md',
        '.genie/create/agents/*.md',
        '.genie/workflows/*.md',
        '.genie/product/**/*.md',
        '.genie/qa/**/*.md'
    ];
    const patchFile = path_1.default.join('/tmp', `genie-upgrade-${Date.now()}.patch`);
    try {
        // Generate diff (oldCommit might be 'unknown' for legacy installs)
        const diffArgs = oldCommit === 'unknown'
            ? `${newCommit}~10..${newCommit}` // Last 10 commits if no baseline
            : `${oldCommit}..${newCommit}`;
        const diffCmd = `git diff ${diffArgs} -- ${frameworkGlobs.join(' ')}`;
        const diffOutput = (0, child_process_1.execSync)(diffCmd, {
            cwd: templatePath,
            encoding: 'utf8',
            stdio: ['pipe', 'pipe', 'pipe']
        });
        // Write patch file
        await fs_1.promises.writeFile(patchFile, diffOutput, 'utf8');
        // Parse affected files
        const affectedFiles = parseAffectedFiles(diffOutput);
        return {
            hasChanges: affectedFiles.length > 0,
            patchFile,
            affectedFiles
        };
    }
    catch (error) {
        throw new Error(`Failed to generate framework diff: ${error instanceof Error ? error.message : String(error)}`);
    }
}
/**
 * Ensure template repo is cloned and cached locally
 */
async function ensureTemplateRepo() {
    const templatePath = path_1.default.join(TEMPLATE_CACHE_DIR, 'automagik-genie');
    if (await (0, fs_utils_1.pathExists)(templatePath)) {
        return templatePath;
    }
    // Clone repo
    await (0, fs_utils_1.ensureDir)(TEMPLATE_CACHE_DIR);
    (0, child_process_1.execSync)(`git clone ${TEMPLATE_REPO} automagik-genie`, {
        cwd: TEMPLATE_CACHE_DIR,
        stdio: 'pipe'
    });
    return templatePath;
}
/**
 * Parse affected files from git diff output
 */
function parseAffectedFiles(diffOutput) {
    const lines = diffOutput.split('\n');
    const files = [];
    for (const line of lines) {
        if (line.startsWith('diff --git')) {
            // Extract file path: "diff --git a/.genie/spells/learn.md b/.genie/spells/learn.md"
            const match = line.match(/diff --git a\/(.+?) b\//);
            if (match && match[1]) {
                files.push(match[1]);
            }
        }
    }
    return files;
}
