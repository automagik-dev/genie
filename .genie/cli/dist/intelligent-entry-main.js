#!/usr/bin/env node
"use strict";
/**
 * Standalone intelligent entry point - spawned by genie-cli.ts
 * Handles animated startup with auto-detection logic
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const intelligent_entry_1 = require("./intelligent-entry");
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const child_process_1 = require("child_process");
async function main() {
    // Get current version from package.json
    const packageJsonPath = path_1.default.join(__dirname, '../../../package.json');
    const packageJson = JSON.parse(fs_1.default.readFileSync(packageJsonPath, 'utf-8'));
    const currentVersion = packageJson.version;
    // Check for latest version
    let latestVersion = currentVersion;
    try {
        const npmVersion = (0, child_process_1.execSync)('npm view automagik-genie@next version', {
            encoding: 'utf-8',
            stdio: ['pipe', 'pipe', 'pipe']
        }).trim();
        latestVersion = npmVersion;
    }
    catch (err) {
        // If npm check fails, assume current version is latest
    }
    // Check if workspace is initialized (.genie directory exists)
    const genieDir = path_1.default.join(process.cwd(), '.genie');
    const isWorkspaceInitialized = fs_1.default.existsSync(genieDir);
    // Check for old version markers
    const hasOldVersion = isWorkspaceInitialized && fs_1.default.existsSync(path_1.default.join(genieDir, '.legacy'));
    await (0, intelligent_entry_1.runIntelligentEntry)({
        currentVersion,
        latestVersion,
        isWorkspaceInitialized,
        hasOldVersion,
        onUpdate: () => {
            console.log('Starting update...');
            try {
                (0, child_process_1.execSync)('pnpm install -g automagik-genie@next', { stdio: 'inherit' });
                console.log('Update complete! Please run genie again.');
                process.exit(0);
            }
            catch (err) {
                console.error('Update failed:', err);
                process.exit(1);
            }
        },
        onInit: () => {
            console.log('Starting workspace initialization...');
            try {
                // Spawn genie init
                const child = (0, child_process_1.spawn)('genie', ['init'], { stdio: 'inherit' });
                child.on('exit', (code) => {
                    process.exit(code || 0);
                });
            }
            catch (err) {
                console.error('Init failed:', err);
                process.exit(1);
            }
        },
        onUpgrade: () => {
            console.log('Starting workspace upgrade...');
            try {
                // Backup old workspace
                const backupDir = path_1.default.join(process.cwd(), '.genie.backup');
                if (fs_1.default.existsSync(backupDir)) {
                    fs_1.default.rmSync(backupDir, { recursive: true, force: true });
                }
                fs_1.default.renameSync(genieDir, backupDir);
                // Initialize new workspace
                const child = (0, child_process_1.spawn)('genie', ['init'], { stdio: 'inherit' });
                child.on('exit', (code) => {
                    console.log('Upgrade complete! Your old workspace is backed up at .genie.backup');
                    process.exit(code || 0);
                });
            }
            catch (err) {
                console.error('Upgrade failed:', err);
                process.exit(1);
            }
        },
        onStart: () => {
            // User pressed ENTER to start - now launch the actual server
            // Spawn genie CLI with no args (which will call startGenieServer)
            process.env.GENIE_SKIP_ENTRY = 'true'; // Prevent recursion
            const genieScript = path_1.default.join(__dirname, 'genie-cli.js');
            const child = (0, child_process_1.spawn)('node', [genieScript], {
                stdio: 'inherit',
                env: process.env
            });
            child.on('exit', (code) => {
                process.exit(code || 0);
            });
        }
    });
}
main().catch((error) => {
    console.error('Failed to start intelligent entry:', error);
    process.exit(1);
});
