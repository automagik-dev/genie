"use strict";
/**
 * Stats Tracker - Comprehensive engagement statistics
 *
 * Tracks ALL user activity for the dashboard:
 * - Session stats (tokens, duration, tasks, project)
 * - Monthly aggregations
 * - All-time records
 * - Streak tracking
 * - Milestone detection
 *
 * Storage Strategy:
 * - Live sessions: .genie/state/current-session.json
 * - Historical: .genie/state/stats-history.json
 * - Git metadata: git notes for commit-level tracking
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.StatsTracker = void 0;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const child_process_1 = require("child_process");
// ============================================================================
// Stats Tracker Class
// ============================================================================
class StatsTracker {
    constructor(workspaceRoot) {
        this.workspaceRoot = workspaceRoot;
        this.dataPath = path_1.default.join(workspaceRoot, '.genie/state/stats-history.json');
        this.currentSessionPath = path_1.default.join(workspaceRoot, '.genie/state/current-session.json');
    }
    // ============================================================================
    // Session Management
    // ============================================================================
    startSession(projectId, projectName) {
        const session = {
            id: this.generateSessionId(),
            startTime: new Date().toISOString(),
            tokenCount: { input: 0, output: 0, total: 0 },
            tasksCompleted: [],
            projectId,
            projectName,
            agentsInvoked: []
        };
        // Save as current session
        this.saveCurrentSession(session);
        // Mark day active
        const data = this.load();
        this.markDayActive(data);
        this.save(data);
        return session;
    }
    endSession(sessionId) {
        const current = this.loadCurrentSession();
        if (!current || current.id !== sessionId)
            return;
        current.endTime = new Date().toISOString();
        // Archive to history
        const data = this.load();
        data.sessions.unshift(current);
        data.sessions = data.sessions.slice(0, 100); // Keep last 100
        // Update monthly stats
        const duration = new Date(current.endTime).getTime() - new Date(current.startTime).getTime();
        const month = this.getMonthKey(new Date(current.startTime));
        const monthly = this.getOrCreateMonthly(data, month);
        monthly.timeTotal += duration;
        data.allTime.totalTime += duration;
        data.allTime.totalSessions++;
        // Update peak session
        if (current.tokenCount.total > monthly.peakSession.tokens) {
            monthly.peakSession = {
                date: this.getDateKey(new Date(current.startTime)),
                tokens: current.tokenCount.total,
                sessionId: current.id
            };
        }
        this.save(data);
        // Store in git notes
        this.storeInGitNotes(current);
        // Clear current session
        this.clearCurrentSession();
    }
    getCurrentSession() {
        return this.loadCurrentSession();
    }
    // ============================================================================
    // Token Tracking
    // ============================================================================
    recordTokens(sessionId, inputTokens, outputTokens) {
        const current = this.loadCurrentSession();
        if (!current || current.id !== sessionId)
            return;
        current.tokenCount.input += inputTokens;
        current.tokenCount.output += outputTokens;
        current.tokenCount.total = current.tokenCount.input + current.tokenCount.output;
        this.saveCurrentSession(current);
        // Update aggregates
        const data = this.load();
        const month = this.getMonthKey(new Date());
        const monthly = this.getOrCreateMonthly(data, month);
        monthly.tokenTotal += (inputTokens + outputTokens);
        data.allTime.totalTokens += (inputTokens + outputTokens);
        // Update daily activity
        const today = this.getDateKey(new Date());
        const day = monthly.dailyActivity.find(d => d.date === today);
        if (day) {
            day.tokenCount += (inputTokens + outputTokens);
        }
        // Check milestones
        this.checkMilestones(data, current);
        this.save(data);
    }
    // ============================================================================
    // Task Tracking
    // ============================================================================
    recordTaskCompletion(sessionId, taskId, taskTitle) {
        const current = this.loadCurrentSession();
        if (!current || current.id !== sessionId)
            return;
        if (!current.tasksCompleted.includes(taskId)) {
            current.tasksCompleted.push(taskId);
        }
        this.saveCurrentSession(current);
        // Update aggregates
        const data = this.load();
        const month = this.getMonthKey(new Date());
        const monthly = this.getOrCreateMonthly(data, month);
        monthly.taskCount++;
        data.allTime.totalTasks++;
        // Update daily activity
        const today = this.getDateKey(new Date());
        const day = monthly.dailyActivity.find(d => d.date === today);
        if (day) {
            day.taskCount++;
        }
        // Update peak day
        const tasksToday = this.countTasksToday(data);
        if (tasksToday > monthly.peakDay.tasks) {
            monthly.peakDay = { date: today, tasks: tasksToday };
        }
        this.save(data);
    }
    recordWishFulfillment(sessionId) {
        const data = this.load();
        const month = this.getMonthKey(new Date());
        const monthly = this.getOrCreateMonthly(data, month);
        monthly.wishCount++;
        this.save(data);
    }
    recordAgentInvocation(sessionId, agentId) {
        const current = this.loadCurrentSession();
        if (!current || current.id !== sessionId)
            return;
        if (!current.agentsInvoked.includes(agentId)) {
            current.agentsInvoked.push(agentId);
        }
        this.saveCurrentSession(current);
    }
    // ============================================================================
    // Query Methods
    // ============================================================================
    getMonthlyStats(month) {
        const data = this.load();
        return this.getOrCreateMonthly(data, month);
    }
    getMonthlyComparison(month) {
        const data = this.load();
        const current = this.getOrCreateMonthly(data, month);
        // Get previous month
        const [year, monthNum] = month.split('-').map(Number);
        const prevDate = new Date(year, monthNum - 2, 1); // monthNum is 1-based, subtract 2 to get previous
        const prevMonth = this.getMonthKey(prevDate);
        const previous = data.monthly[prevMonth] || null;
        let changes = {};
        if (previous) {
            changes = {
                tokens: this.calculatePercentChange(previous.tokenTotal, current.tokenTotal),
                time: this.calculatePercentChange(previous.timeTotal, current.timeTotal),
                tasks: this.calculatePercentChange(previous.taskCount, current.taskCount),
                wishes: this.calculatePercentChange(previous.wishCount, current.wishCount)
            };
        }
        return { current, previous, changes };
    }
    getAllTimeStats() {
        const data = this.load();
        const streak = this.calculateStreak();
        data.allTime.longestStreak = streak.longest;
        return data.allTime;
    }
    calculateStreak() {
        const data = this.load();
        const today = this.getDateKey(new Date());
        // Collect all active days sorted descending
        const allDays = [];
        Object.values(data.monthly).forEach(m => {
            allDays.push(...m.dailyActivity.filter(d => d.active));
        });
        allDays.sort((a, b) => b.date.localeCompare(a.date));
        if (allDays.length === 0) {
            return {
                current: { days: 0, start: '' },
                longest: { days: 0, start: '', end: '' }
            };
        }
        // Calculate current streak
        let currentStreak = 0;
        let currentStart = '';
        let checkDate = new Date(today);
        for (let i = 0; i < 365; i++) { // Check up to 1 year
            const dayStr = this.getDateKey(checkDate);
            const found = allDays.find(d => d.date === dayStr);
            if (found) {
                currentStreak++;
                currentStart = dayStr;
            }
            else if (currentStreak > 0) {
                break; // Streak ended
            }
            checkDate = new Date(checkDate.getTime() - 86400000);
        }
        // Calculate longest streak
        let longestStreak = 0;
        let longestStart = '';
        let longestEnd = '';
        let tempStreak = 0;
        let tempStart = '';
        const sortedAsc = [...allDays].sort((a, b) => a.date.localeCompare(b.date));
        for (let i = 0; i < sortedAsc.length; i++) {
            if (tempStreak === 0) {
                tempStreak = 1;
                tempStart = sortedAsc[i].date;
            }
            else {
                const prevDate = new Date(sortedAsc[i - 1].date);
                const currDate = new Date(sortedAsc[i].date);
                const dayDiff = Math.floor((currDate.getTime() - prevDate.getTime()) / 86400000);
                if (dayDiff === 1) {
                    tempStreak++;
                }
                else {
                    if (tempStreak > longestStreak) {
                        longestStreak = tempStreak;
                        longestStart = tempStart;
                        longestEnd = sortedAsc[i - 1].date;
                    }
                    tempStreak = 1;
                    tempStart = sortedAsc[i].date;
                }
            }
        }
        if (tempStreak > longestStreak) {
            longestStreak = tempStreak;
            longestStart = tempStart;
            longestEnd = sortedAsc[sortedAsc.length - 1].date;
        }
        return {
            current: { days: currentStreak, start: currentStart },
            longest: { days: longestStreak, start: longestStart, end: longestEnd }
        };
    }
    getTodayStats() {
        const data = this.load();
        const today = this.getDateKey(new Date());
        const month = this.getMonthKey(new Date());
        const monthly = data.monthly[month];
        if (!monthly) {
            return { tokens: 0, tasks: 0, sessions: 0 };
        }
        const day = monthly.dailyActivity.find(d => d.date === today);
        if (!day) {
            return { tokens: 0, tasks: 0, sessions: 0 };
        }
        return {
            tokens: day.tokenCount,
            tasks: day.taskCount,
            sessions: day.sessionCount
        };
    }
    getRecentMilestones(count = 5) {
        const data = this.load();
        return data.milestones
            .sort((a, b) => new Date(b.reached).getTime() - new Date(a.reached).getTime())
            .slice(0, count);
    }
    // ============================================================================
    // Milestone Detection
    // ============================================================================
    checkMilestones(data, session) {
        const milestones = [
            { type: 'tokens', value: 100000, title: '🎉 100k tokens!' },
            { type: 'tokens', value: 500000, title: '🚀 500k tokens!' },
            { type: 'tokens', value: 1000000, title: '🏆 Million token club!' },
            { type: 'tokens', value: 5000000, title: '💎 5M tokens!' },
            { type: 'tokens', value: 10000000, title: '🌟 10M tokens!' }
        ];
        for (const m of milestones) {
            const alreadyReached = data.milestones.some(milestone => milestone.type === m.type && milestone.value === m.value && milestone.sessionId === session.id);
            if (!alreadyReached && session.tokenCount.total >= m.value) {
                data.milestones.push({
                    type: m.type,
                    value: m.value,
                    title: m.title,
                    reached: new Date().toISOString(),
                    sessionId: session.id
                });
            }
        }
    }
    // ============================================================================
    // Git Notes Integration (Store in Commit Metadata)
    // ============================================================================
    storeInGitNotes(session) {
        try {
            // Get current HEAD commit
            const commit = (0, child_process_1.execSync)('git rev-parse HEAD', { cwd: this.workspaceRoot, encoding: 'utf-8' }).trim();
            // Create notes content
            const notes = {
                sessionId: session.id,
                tokens: session.tokenCount,
                tasks: session.tasksCompleted.length,
                duration: session.endTime
                    ? new Date(session.endTime).getTime() - new Date(session.startTime).getTime()
                    : 0,
                agents: session.agentsInvoked,
                timestamp: session.endTime || session.startTime
            };
            const notesContent = JSON.stringify(notes, null, 2);
            // Store in git notes (namespace: genie/stats)
            (0, child_process_1.execSync)(`git notes --ref=genie/stats add -f -m '${notesContent.replace(/'/g, "'\\''")}'${commit}`, {
                cwd: this.workspaceRoot,
                encoding: 'utf-8'
            });
            console.error(`📝 Stats stored in git notes for commit ${commit.slice(0, 7)}`);
        }
        catch (error) {
            // Silently fail if not in git repo or git notes fail
            console.error(`⚠️  Could not store stats in git notes: ${error.message}`);
        }
    }
    // ============================================================================
    // Persistence
    // ============================================================================
    load() {
        if (!fs_1.default.existsSync(this.dataPath)) {
            return this.createEmpty();
        }
        try {
            const content = fs_1.default.readFileSync(this.dataPath, 'utf-8');
            return JSON.parse(content);
        }
        catch {
            return this.createEmpty();
        }
    }
    save(data) {
        data.lastUpdated = new Date().toISOString();
        const dir = path_1.default.dirname(this.dataPath);
        if (!fs_1.default.existsSync(dir)) {
            fs_1.default.mkdirSync(dir, { recursive: true });
        }
        fs_1.default.writeFileSync(this.dataPath, JSON.stringify(data, null, 2));
    }
    loadCurrentSession() {
        if (!fs_1.default.existsSync(this.currentSessionPath))
            return null;
        try {
            const content = fs_1.default.readFileSync(this.currentSessionPath, 'utf-8');
            return JSON.parse(content);
        }
        catch {
            return null;
        }
    }
    saveCurrentSession(session) {
        const dir = path_1.default.dirname(this.currentSessionPath);
        if (!fs_1.default.existsSync(dir)) {
            fs_1.default.mkdirSync(dir, { recursive: true });
        }
        fs_1.default.writeFileSync(this.currentSessionPath, JSON.stringify(session, null, 2));
    }
    clearCurrentSession() {
        if (fs_1.default.existsSync(this.currentSessionPath)) {
            fs_1.default.unlinkSync(this.currentSessionPath);
        }
    }
    createEmpty() {
        return {
            currentSession: null,
            sessions: [],
            monthly: {},
            allTime: {
                totalTokens: 0,
                totalTime: 0,
                totalTasks: 0,
                totalSessions: 0,
                longestStreak: { days: 0, start: '', end: '' },
                firstSession: new Date().toISOString()
            },
            milestones: [],
            lastUpdated: new Date().toISOString()
        };
    }
    // ============================================================================
    // Helper Methods
    // ============================================================================
    generateSessionId() {
        const now = new Date();
        const dateStr = now.toISOString().slice(0, 16).replace(/[-:T]/g, '');
        const random = Math.random().toString(36).substring(2, 6);
        return `session-${dateStr}-${random}`;
    }
    getMonthKey(date) {
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        return `${year}-${month}`;
    }
    getDateKey(date) {
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
    }
    getOrCreateMonthly(data, month) {
        if (!data.monthly[month]) {
            data.monthly[month] = {
                month,
                tokenTotal: 0,
                timeTotal: 0,
                taskCount: 0,
                wishCount: 0,
                dailyActivity: [],
                peakSession: { date: '', tokens: 0, sessionId: '' },
                peakDay: { date: '', tasks: 0 }
            };
        }
        return data.monthly[month];
    }
    markDayActive(data) {
        const today = this.getDateKey(new Date());
        const month = this.getMonthKey(new Date());
        const monthly = this.getOrCreateMonthly(data, month);
        let day = monthly.dailyActivity.find(d => d.date === today);
        if (!day) {
            day = {
                date: today,
                tokenCount: 0,
                taskCount: 0,
                sessionCount: 0,
                active: true
            };
            monthly.dailyActivity.push(day);
        }
        day.sessionCount++;
        day.active = true;
    }
    countTasksToday(data) {
        const today = this.getDateKey(new Date());
        const month = this.getMonthKey(new Date());
        const monthly = data.monthly[month];
        if (!monthly)
            return 0;
        const day = monthly.dailyActivity.find(d => d.date === today);
        return day ? day.taskCount : 0;
    }
    calculatePercentChange(oldValue, newValue) {
        if (oldValue === 0)
            return newValue > 0 ? 100 : 0;
        return ((newValue - oldValue) / oldValue) * 100;
    }
}
exports.StatsTracker = StatsTracker;
