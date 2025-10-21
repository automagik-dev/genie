"use strict";
/**
 * Migration Script - sessions.json → Forge Backend
 *
 * Strategy (Hybrid - Option C):
 * - Active sessions → Forge tasks
 * - Recent completed → Forge tasks (marked complete)
 * - Old completed → Archive file
 * - Malformed → Skip + log warning
 *
 * File: .genie/cli/src/lib/migrate-sessions.ts
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.migrateSessionsToForge = migrateSessionsToForge;
exports.rollbackMigration = rollbackMigration;
exports.dryRunMigration = dryRunMigration;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const forge_executor_1 = require("./forge-executor");
// ============================================================================
// Main Migration Function
// ============================================================================
/**
 * Migrate sessions.json to Forge backend
 *
 * Strategy (Hybrid - Option C):
 * - Active sessions → Forge tasks
 * - Recent completed → Forge tasks (marked complete)
 * - Old completed → Archive file
 * - Malformed → Skip + log warning
 *
 * @param options Migration configuration
 * @returns Migration result with statistics
 */
async function migrateSessionsToForge(options) {
    const result = {
        success: false,
        sessionsProcessed: 0,
        forgeTasksCreated: 0,
        sessionsArchived: 0,
        sessionsSkipped: 0,
        errors: [],
        warnings: []
    };
    try {
        // Step 1: Validate sessions.json exists
        const sessionsPath = resolveSessionsPath();
        if (!fs_1.default.existsSync(sessionsPath)) {
            result.warnings.push('No sessions.json found - nothing to migrate');
            result.success = true;
            return result;
        }
        // Step 2: Backup sessions.json
        if (!options.dryRun) {
            result.backupPath = await backupSessionsJson(sessionsPath);
        }
        // Step 3: Load and parse sessions
        const store = loadSessionStore(sessionsPath);
        const sessions = Object.values(store.sessions || {});
        result.sessionsProcessed = sessions.length;
        if (sessions.length === 0) {
            result.warnings.push('sessions.json is empty - nothing to migrate');
            result.success = true;
            return result;
        }
        // Step 4: Classify sessions
        const classified = classifySessions(sessions, options.recencyDays || 7);
        // Step 5: Migrate active + recent to Forge
        if (!options.dryRun) {
            result.forgeTasksCreated += await migrateToForge([...classified.active, ...classified.recentCompleted], result);
        }
        else {
            // Dry-run: just count
            result.forgeTasksCreated = classified.active.length + classified.recentCompleted.length;
        }
        // Step 6: Archive old completed sessions
        if (classified.oldCompleted.length > 0) {
            if (!options.dryRun) {
                await archiveSessions(classified.oldCompleted, options.archivePath || resolveArchivePath());
            }
            result.sessionsArchived = classified.oldCompleted.length;
        }
        // Step 7: Log malformed sessions
        if (classified.malformed.length > 0) {
            classified.malformed.forEach(session => {
                result.warnings.push(`Skipping malformed session: ${JSON.stringify(session)}`);
            });
            result.sessionsSkipped = classified.malformed.length;
        }
        // Step 8: Mark sessions.json as migrated (or delete)
        if (!options.dryRun) {
            await markAsMigrated(sessionsPath);
        }
        result.success = true;
        return result;
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        result.errors.push(`Migration failed: ${message}`);
        result.success = false;
        return result;
    }
}
// ============================================================================
// Session Classification
// ============================================================================
/**
 * Classify sessions into migration categories
 */
function classifySessions(sessions, recencyDays) {
    const now = Date.now();
    const recencyThreshold = recencyDays * 24 * 60 * 60 * 1000; // Convert days to ms
    const classification = {
        active: [],
        recentCompleted: [],
        oldCompleted: [],
        malformed: []
    };
    sessions.forEach(session => {
        // Sanitize session first
        const sanitized = sanitizeSession(session);
        // Validate critical fields
        if (!isValidSession(sanitized)) {
            classification.malformed.push(sanitized);
            return;
        }
        const status = (sanitized.status || '').toLowerCase();
        const lastUsed = sanitized.lastUsed || sanitized.created;
        const age = lastUsed ? now - new Date(lastUsed).getTime() : Infinity;
        // Active sessions (running/starting/pending)
        if (['running', 'starting', 'pending'].includes(status)) {
            classification.active.push(sanitized);
            return;
        }
        // Completed/failed sessions
        if (['completed', 'failed'].includes(status)) {
            if (age < recencyThreshold) {
                classification.recentCompleted.push(sanitized);
            }
            else {
                classification.oldCompleted.push(sanitized);
            }
            return;
        }
        // Unknown status - treat as malformed
        classification.malformed.push(sanitized);
    });
    return classification;
}
/**
 * Validate session has critical fields for migration
 */
function isValidSession(session) {
    // Must have agent name
    if (!session.agent || typeof session.agent !== 'string') {
        return false;
    }
    // Must have created timestamp (for age calculation)
    if (!session.created && !session.lastUsed) {
        return false;
    }
    return true;
}
/**
 * Pre-migration validation and sanitization
 */
function sanitizeSession(session) {
    const sanitized = { ...session };
    // Edge Case #1: Generate sessionId if missing
    if (!sanitized.sessionId) {
        const { randomUUID } = require('crypto');
        sanitized.sessionId = randomUUID();
        console.warn(`Generated sessionId for session: ${sanitized.agent}`);
    }
    // Edge Case #7: Ensure timestamp exists
    if (!sanitized.created && !sanitized.lastUsed) {
        sanitized.created = new Date().toISOString();
        console.warn(`No timestamp for session ${sanitized.sessionId}, using current time`);
    }
    // Edge Case #12: Validate timestamps
    if (sanitized.created && isNaN(new Date(sanitized.created).getTime())) {
        sanitized.created = new Date().toISOString();
        console.warn(`Invalid created timestamp for ${sanitized.sessionId}`);
    }
    // Edge Case #2: Check if "running" process is actually dead
    if (sanitized.status === 'running' && sanitized.runnerPid) {
        if (!isProcessAlive(sanitized.runnerPid)) {
            sanitized.status = 'failed';
            console.warn(`Session ${sanitized.sessionId} marked running but process dead`);
        }
    }
    return sanitized;
}
/**
 * Check if process is alive (Unix only)
 */
function isProcessAlive(pid) {
    try {
        // Sending signal 0 checks existence without killing
        process.kill(pid, 0);
        return true;
    }
    catch {
        return false;
    }
}
// ============================================================================
// Forge Migration
// ============================================================================
/**
 * Migrate sessions to Forge tasks
 */
async function migrateToForge(sessions, result) {
    const forge = (0, forge_executor_1.createForgeExecutor)();
    let created = 0;
    for (const session of sessions) {
        try {
            // TODO: Implement actual Forge task creation
            // For now, this is a placeholder that will be replaced with real API calls
            // once the forge-executor.ts integration is complete
            console.log(`Would migrate session ${session.sessionId} (${session.agent}) to Forge`);
            created++;
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            result.errors.push(`Failed to migrate session ${session.sessionId || session.agent}: ${message}`);
        }
    }
    return created;
}
// ============================================================================
// Archive Management
// ============================================================================
/**
 * Archive old completed sessions to separate file
 */
async function archiveSessions(sessions, archivePath) {
    // Load existing archive (if any)
    let archive = { version: 2, sessions: {} };
    if (fs_1.default.existsSync(archivePath)) {
        const content = fs_1.default.readFileSync(archivePath, 'utf8');
        archive = JSON.parse(content);
    }
    // Add sessions to archive (keyed by sessionId)
    sessions.forEach(session => {
        const key = session.sessionId || `archive-${Date.now()}-${Math.random()}`;
        archive.sessions[key] = session;
    });
    // Write archive
    const archiveDir = path_1.default.dirname(archivePath);
    if (!fs_1.default.existsSync(archiveDir)) {
        fs_1.default.mkdirSync(archiveDir, { recursive: true });
    }
    fs_1.default.writeFileSync(archivePath, JSON.stringify(archive, null, 2));
}
// ============================================================================
// Backup & Rollback
// ============================================================================
/**
 * Create backup of sessions.json before migration
 *
 * Format: .genie/state/agents/backups/sessions-{timestamp}.json
 */
async function backupSessionsJson(sessionsPath) {
    const backupDir = path_1.default.join(path_1.default.dirname(sessionsPath), 'backups');
    if (!fs_1.default.existsSync(backupDir)) {
        fs_1.default.mkdirSync(backupDir, { recursive: true });
    }
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = path_1.default.join(backupDir, `sessions-${timestamp}.json`);
    fs_1.default.copyFileSync(sessionsPath, backupPath);
    return backupPath;
}
/**
 * Restore sessions.json from backup
 */
async function rollbackMigration(backupPath) {
    const sessionsPath = resolveSessionsPath();
    if (!fs_1.default.existsSync(backupPath)) {
        throw new Error(`Backup not found: ${backupPath}`);
    }
    // Restore backup
    fs_1.default.copyFileSync(backupPath, sessionsPath);
    // TODO: Delete Forge tasks created during failed migration
    // This requires tracking which tasks were created during migration
    // For now, manual cleanup via Forge UI
}
// ============================================================================
// Path Helpers
// ============================================================================
function resolveSessionsPath() {
    return path_1.default.join(process.cwd(), '.genie/state/agents/sessions.json');
}
function resolveArchivePath() {
    return path_1.default.join(process.cwd(), '.genie/state/agents/sessions-archive.json');
}
function loadSessionStore(sessionsPath) {
    const content = fs_1.default.readFileSync(sessionsPath, 'utf8');
    return JSON.parse(content);
}
function markAsMigrated(sessionsPath) {
    // Replace with migration marker
    const marker = {
        version: 2,
        sessions: {},
        _migrated: true,
        _migratedAt: new Date().toISOString(),
        _note: 'Sessions have been migrated to Forge. See sessions-archive.json for historical sessions.'
    };
    fs_1.default.writeFileSync(sessionsPath, JSON.stringify(marker, null, 2));
}
// ============================================================================
// Dry-Run Mode
// ============================================================================
/**
 * Dry-run mode: Preview migration without side effects
 */
async function dryRunMigration() {
    console.log('\n📊 MIGRATION DRY-RUN\n');
    console.log('═'.repeat(60));
    // Step 1: Check sessions.json exists
    const sessionsPath = resolveSessionsPath();
    if (!fs_1.default.existsSync(sessionsPath)) {
        console.log('✅ No sessions.json found - nothing to migrate\n');
        return;
    }
    // Step 2: Load and classify sessions
    const store = loadSessionStore(sessionsPath);
    const sessions = Object.values(store.sessions || {});
    const classified = classifySessions(sessions, 7);
    // Step 3: Display statistics
    console.log(`\n📈 MIGRATION SUMMARY:\n`);
    console.log(`  Total sessions: ${sessions.length}`);
    console.log(`  Active (→ Forge): ${classified.active.length}`);
    console.log(`  Recent completed (→ Forge): ${classified.recentCompleted.length}`);
    console.log(`  Old completed (→ Archive): ${classified.oldCompleted.length}`);
    console.log(`  Malformed (→ Skip): ${classified.malformed.length}`);
    console.log();
    // Step 4: Display Forge tasks that would be created
    const forgeTaskCount = classified.active.length + classified.recentCompleted.length;
    console.log(`\n🔨 FORGE TASKS TO CREATE: ${forgeTaskCount}\n`);
    [...classified.active, ...classified.recentCompleted].forEach((session, i) => {
        console.log(`  ${i + 1}. ${session.agent} (${session.sessionId || 'NO ID'})`);
        console.log(`     Status: ${session.status || 'unknown'}`);
        console.log(`     Created: ${session.created || 'unknown'}`);
        console.log(`     → Forge task: "Genie: ${session.agent}"`);
        console.log();
    });
    // Step 5: Display sessions that would be archived
    if (classified.oldCompleted.length > 0) {
        console.log(`\n📦 SESSIONS TO ARCHIVE: ${classified.oldCompleted.length}\n`);
        classified.oldCompleted.slice(0, 5).forEach((session, i) => {
            console.log(`  ${i + 1}. ${session.agent} (${session.created || 'unknown'})`);
        });
        if (classified.oldCompleted.length > 5) {
            console.log(`  ... and ${classified.oldCompleted.length - 5} more`);
        }
        console.log();
    }
    // Step 6: Display malformed sessions
    if (classified.malformed.length > 0) {
        console.log(`\n⚠️  MALFORMED SESSIONS (WILL BE SKIPPED): ${classified.malformed.length}\n`);
        classified.malformed.forEach((session, i) => {
            console.log(`  ${i + 1}. ${JSON.stringify(session)}`);
        });
        console.log();
    }
    // Step 7: Display next steps
    console.log('═'.repeat(60));
    console.log('\n📋 NEXT STEPS:\n');
    console.log('  1. Review the migration plan above');
    console.log('  2. Ensure Forge backend is running');
    console.log('  3. Run migration:');
    console.log('       genie migrate --execute\n');
    console.log('  4. If something goes wrong:');
    console.log('       genie migrate --rollback\n');
}
