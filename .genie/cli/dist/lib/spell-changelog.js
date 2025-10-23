"use strict";
/**
 * Spell Changelog Extractor
 *
 * Detects new spells (skills) learned by Master Genie between versions
 * by analyzing git commits for changes in spell directories:
 * - .genie/spells/ (universal spells)
 * - .genie/code/spells/ (Code collective spells)
 * - .genie/create/spells/ (Create collective spells)
 */
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.getLearnedSpells = getLearnedSpells;
exports.formatSpellChangelog = formatSpellChangelog;
exports.getLastTag = getLastTag;
exports.getTagForVersion = getTagForVersion;
const child_process_1 = require("child_process");
const path = __importStar(require("path"));
/**
 * Extract spell changes between two git references (tags/commits)
 */
function getLearnedSpells(fromRef, toRef = 'HEAD') {
    const spellPatterns = [
        '.genie/spells/**/*.md',
        '.genie/code/spells/**/*.md',
        '.genie/create/spells/**/*.md'
    ];
    const newSpells = [];
    const modifiedSpells = [];
    try {
        // Get all changed files between refs
        const diffOutput = (0, child_process_1.execSync)(`git diff --name-status ${fromRef}..${toRef} -- ${spellPatterns.join(' ')}`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).trim();
        if (!diffOutput) {
            return { newSpells, modifiedSpells, totalCount: 0 };
        }
        const lines = diffOutput.split('\n');
        for (const line of lines) {
            const match = line.match(/^([A-Z])\s+(.+\.md)$/);
            if (!match)
                continue;
            const [, status, filePath] = match;
            // Skip non-spell files
            if (!filePath.includes('/spells/'))
                continue;
            if (filePath.includes('README.md'))
                continue;
            const spell = parseSpellFromPath(filePath);
            if (!spell)
                continue;
            if (status === 'A') {
                // Added (new spell)
                newSpells.push({ ...spell, action: 'added' });
            }
            else if (status === 'M') {
                // Modified (enhanced spell)
                modifiedSpells.push({ ...spell, action: 'modified' });
            }
        }
        return {
            newSpells,
            modifiedSpells,
            totalCount: newSpells.length + modifiedSpells.length
        };
    }
    catch (error) {
        // If git command fails (e.g., no tags yet), return empty
        return { newSpells, modifiedSpells, totalCount: 0 };
    }
}
/**
 * Parse spell metadata from file path
 */
function parseSpellFromPath(filePath) {
    // Extract spell name from filename
    const fileName = path.basename(filePath, '.md');
    // Determine type based on path
    let type;
    if (filePath.includes('.genie/code/spells/')) {
        type = 'code';
    }
    else if (filePath.includes('.genie/create/spells/')) {
        type = 'create';
    }
    else if (filePath.includes('.genie/spells/')) {
        type = 'universal';
    }
    else {
        return null;
    }
    // Convert filename to readable name
    const name = fileName
        .split('-')
        .map(word => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ');
    return {
        name,
        type,
        path: filePath
    };
}
/**
 * Format spell changelog for display in terminal
 */
function formatSpellChangelog(changelog) {
    const lines = [];
    if (changelog.totalCount === 0) {
        return lines;
    }
    lines.push('🎓 New Magik Learned:');
    lines.push('');
    if (changelog.newSpells.length > 0) {
        lines.push('  ✨ New Spells:');
        for (const spell of changelog.newSpells) {
            const badge = spell.type === 'universal' ? '🌍' : spell.type === 'code' ? '💻' : '✍️';
            lines.push(`     ${badge} ${spell.name}`);
        }
        lines.push('');
    }
    if (changelog.modifiedSpells.length > 0) {
        lines.push('  ⚡ Enhanced Spells:');
        for (const spell of changelog.modifiedSpells) {
            const badge = spell.type === 'universal' ? '🌍' : spell.type === 'code' ? '💻' : '✍️';
            lines.push(`     ${badge} ${spell.name}`);
        }
        lines.push('');
    }
    return lines;
}
/**
 * Get the most recent git tag (for version comparison)
 */
function getLastTag() {
    try {
        return (0, child_process_1.execSync)('git describe --tags --abbrev=0', {
            encoding: 'utf8',
            stdio: ['pipe', 'pipe', 'ignore']
        }).trim();
    }
    catch {
        return null;
    }
}
/**
 * Get tag for a specific version
 */
function getTagForVersion(version) {
    try {
        const tags = (0, child_process_1.execSync)('git tag -l', {
            encoding: 'utf8',
            stdio: ['pipe', 'pipe', 'ignore']
        }).trim().split('\n');
        // Try exact match first
        const exactMatch = tags.find(tag => tag === `v${version}` || tag === version);
        if (exactMatch)
            return exactMatch;
        // Try fuzzy match (e.g., "2.5.0" matches "v2.5.0-rc.1")
        const fuzzyMatch = tags.find(tag => tag.includes(version));
        return fuzzyMatch || null;
    }
    catch {
        return null;
    }
}
