"use strict";
/**
 * Stats Service - Real-time engagement statistics tracking
 *
 * Tracks session duration, token usage, task completions, and streaks.
 * Provides gamified metrics for the Genie dashboard.
 *
 * Data Storage: .genie/state/stats.json (gitignored, local only)
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.StatsService = void 0;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
// ============================================================================
// Stats Service
// ============================================================================
class StatsService {
    constructor(workspaceRoot) {
        this.data = null;
        this.currentSessionId = null;
        this.statsPath = path_1.default.join(workspaceRoot, '.genie/state/stats.json');
    }
    // ============================================================================
    // Recording Methods
    // ============================================================================
    /**
     * Record token usage for a session
     */
    recordTokenUsage(sessionId, inputTokens, outputTokens) {
        const data = this.load();
        const session = this.findOrCreateSession(sessionId, data);
        session.tokenCount.input += inputTokens;
        session.tokenCount.output += outputTokens;
        session.tokenCount.total = session.tokenCount.input + session.tokenCount.output;
        // Update monthly stats
        const month = this.getMonthKey(new Date());
        const monthlyStats = this.getOrCreateMonthlyStats(month, data);
        monthlyStats.tokenTotal += inputTokens + outputTokens;
        // Update all-time stats
        data.allTime.totalTokens += inputTokens + outputTokens;
        // Check for milestones
        this.checkTokenMilestones(session, data);
        this.save(data);
    }
    /**
     * Record session start
     */
    recordSessionStart(sessionId, projectId) {
        const data = this.load();
        this.currentSessionId = sessionId;
        // Check if session already exists
        const existingSession = data.sessions.find(s => s.id === sessionId);
        if (existingSession) {
            // Session resuming
            return;
        }
        // Create new session
        const session = {
            id: sessionId,
            startTime: new Date(),
            tokenCount: { input: 0, output: 0, total: 0 },
            tasksCompleted: [],
            projectId,
            agentsInvoked: []
        };
        data.sessions.push(session);
        // Update first session tracking
        if (!data.allTime.firstSession) {
            data.allTime.firstSession = new Date();
        }
        // Mark day as active
        const today = this.getDateKey(new Date());
        const month = this.getMonthKey(new Date());
        const monthlyStats = this.getOrCreateMonthlyStats(month, data);
        const dayActivity = monthlyStats.dailyActivity.find(d => d.date === today);
        if (dayActivity) {
            dayActivity.active = true;
        }
        else {
            monthlyStats.dailyActivity.push({ date: today, active: true });
        }
        this.save(data);
    }
    /**
     * Record session end
     */
    recordSessionEnd(sessionId) {
        const data = this.load();
        const session = data.sessions.find(s => s.id === sessionId);
        if (!session)
            return;
        session.endTime = new Date();
        // Update total time
        const duration = session.endTime.getTime() - new Date(session.startTime).getTime();
        const month = this.getMonthKey(new Date(session.startTime));
        const monthlyStats = this.getOrCreateMonthlyStats(month, data);
        monthlyStats.timeTotal += duration;
        data.allTime.totalTime += duration;
        // Update peak session if this is a new record
        if (session.tokenCount.total > monthlyStats.peakSession.tokens) {
            monthlyStats.peakSession = {
                date: this.getDateKey(new Date(session.startTime)),
                tokens: session.tokenCount.total,
                sessionId: session.id
            };
        }
        this.save(data);
        if (this.currentSessionId === sessionId) {
            this.currentSessionId = null;
        }
    }
    /**
     * Record task completion
     */
    recordTaskCompletion(sessionId, taskId, projectId) {
        const data = this.load();
        const session = this.findOrCreateSession(sessionId, data);
        if (!session.tasksCompleted.includes(taskId)) {
            session.tasksCompleted.push(taskId);
        }
        // Update monthly stats
        const month = this.getMonthKey(new Date());
        const monthlyStats = this.getOrCreateMonthlyStats(month, data);
        monthlyStats.taskCount++;
        // Update all-time stats
        data.allTime.totalTasks++;
        // Update peak day if this is a new record
        const today = this.getDateKey(new Date());
        const tasksToday = this.countTasksOnDate(today, data);
        if (tasksToday > monthlyStats.peakDay.tasks) {
            monthlyStats.peakDay = {
                date: today,
                tasks: tasksToday
            };
        }
        this.save(data);
    }
    /**
     * Record wish fulfillment
     */
    recordWishFulfillment(sessionId) {
        const data = this.load();
        const month = this.getMonthKey(new Date());
        const monthlyStats = this.getOrCreateMonthlyStats(month, data);
        monthlyStats.wishCount++;
        this.save(data);
    }
    /**
     * Record agent invocation
     */
    recordAgentInvocation(sessionId, agentId) {
        const data = this.load();
        const session = this.findOrCreateSession(sessionId, data);
        if (!session.agentsInvoked.includes(agentId)) {
            session.agentsInvoked.push(agentId);
        }
        this.save(data);
    }
    // ============================================================================
    // Querying Methods
    // ============================================================================
    /**
     * Get current session stats
     */
    getCurrentSession(sessionId) {
        const data = this.load();
        const sid = sessionId || this.currentSessionId;
        if (!sid)
            return null;
        return data.sessions.find(s => s.id === sid) || null;
    }
    /**
     * Get monthly stats
     */
    getMonthlyStats(month) {
        const data = this.load();
        return this.getOrCreateMonthlyStats(month, data);
    }
    /**
     * Get all-time stats
     */
    getAllTimeStats() {
        const data = this.load();
        // Calculate longest streak dynamically
        const streak = this.calculateStreak();
        data.allTime.longestStreak = streak.longest;
        return data.allTime;
    }
    /**
     * Calculate current and longest streaks
     */
    calculateStreak() {
        const data = this.load();
        const today = this.getDateKey(new Date());
        // Collect all active days across all months, sorted descending
        const allDays = Object.values(data.monthly)
            .flatMap(m => m.dailyActivity)
            .filter(d => d.active)
            .map(d => d.date)
            .sort((a, b) => b.localeCompare(a)); // Descending order
        if (allDays.length === 0) {
            return {
                current: { days: 0, start: '' },
                longest: { days: 0, start: '', end: '' }
            };
        }
        // Calculate current streak (must include today or yesterday)
        let currentStreak = 0;
        let currentStart = '';
        let checkDate = new Date(today);
        // Check if today or yesterday has activity (allow 1-day gap)
        const hasRecentActivity = allDays.includes(today) ||
            allDays.includes(this.getDateKey(new Date(Date.now() - 86400000)));
        if (hasRecentActivity) {
            for (let i = 0; i < allDays.length; i++) {
                const dayStr = this.getDateKey(checkDate);
                if (allDays.includes(dayStr)) {
                    currentStreak++;
                    currentStart = dayStr;
                }
                else {
                    // Allow 1-day gap
                    const prevDay = new Date(checkDate.getTime() - 86400000);
                    const prevDayStr = this.getDateKey(prevDay);
                    if (allDays.includes(prevDayStr)) {
                        checkDate = prevDay;
                        currentStreak++;
                        currentStart = prevDayStr;
                    }
                    else {
                        break;
                    }
                }
                checkDate = new Date(checkDate.getTime() - 86400000);
            }
        }
        // Calculate longest streak ever
        let longestStreak = 0;
        let longestStart = '';
        let longestEnd = '';
        let tempStreak = 0;
        let tempStart = '';
        // Sort ascending for longest streak calculation
        const sortedAscending = [...allDays].sort();
        for (let i = 0; i < sortedAscending.length; i++) {
            const currentDay = new Date(sortedAscending[i]);
            if (tempStreak === 0) {
                tempStreak = 1;
                tempStart = sortedAscending[i];
            }
            else {
                const prevDay = new Date(sortedAscending[i - 1]);
                const dayDiff = Math.floor((currentDay.getTime() - prevDay.getTime()) / 86400000);
                if (dayDiff <= 1) {
                    // Consecutive or 1-day gap
                    tempStreak++;
                }
                else {
                    // Streak broken
                    if (tempStreak > longestStreak) {
                        longestStreak = tempStreak;
                        longestStart = tempStart;
                        longestEnd = sortedAscending[i - 1];
                    }
                    tempStreak = 1;
                    tempStart = sortedAscending[i];
                }
            }
        }
        // Check final streak
        if (tempStreak > longestStreak) {
            longestStreak = tempStreak;
            longestStart = tempStart;
            longestEnd = sortedAscending[sortedAscending.length - 1];
        }
        return {
            current: { days: currentStreak, start: currentStart },
            longest: { days: longestStreak, start: longestStart, end: longestEnd }
        };
    }
    /**
     * Get stats for today
     */
    getTodayStats() {
        const data = this.load();
        const today = this.getDateKey(new Date());
        // Find all sessions that started today
        const todaySessions = data.sessions.filter(s => {
            const sessionDate = this.getDateKey(new Date(s.startTime));
            return sessionDate === today;
        });
        const tokens = todaySessions.reduce((sum, s) => sum + s.tokenCount.total, 0);
        const tasks = todaySessions.reduce((sum, s) => sum + s.tasksCompleted.length, 0);
        const duration = todaySessions.reduce((sum, s) => {
            if (s.endTime) {
                return sum + (new Date(s.endTime).getTime() - new Date(s.startTime).getTime());
            }
            // Ongoing session
            return sum + (Date.now() - new Date(s.startTime).getTime());
        }, 0);
        return { tokens, tasks, duration };
    }
    // ============================================================================
    // Milestone Detection
    // ============================================================================
    checkTokenMilestones(session, data) {
        const milestones = [
            { type: 'tokens', value: 100000, title: '100k tokens!' },
            { type: 'tokens', value: 500000, title: '500k tokens!' },
            { type: 'tokens', value: 1000000, title: 'Million token club!' },
            { type: 'tokens', value: 5000000, title: '5M tokens!' },
            { type: 'tokens', value: 10000000, title: '10M tokens!' }
        ];
        for (const milestone of milestones) {
            const alreadyReached = data.milestones.some(m => m.type === milestone.type &&
                m.value === milestone.value &&
                m.sessionId === session.id);
            if (!alreadyReached && session.tokenCount.total >= milestone.value) {
                data.milestones.push({
                    type: milestone.type,
                    value: milestone.value,
                    sessionId: session.id,
                    reached: new Date()
                });
            }
        }
    }
    /**
     * Get milestones for a session
     */
    getMilestonesForSession(sessionId) {
        const data = this.load();
        return data.milestones
            .filter(m => m.sessionId === sessionId)
            .map(m => ({
            type: m.type,
            value: m.value,
            title: this.getMilestoneTitle(m.type, m.value)
        }));
    }
    getMilestoneTitle(type, value) {
        if (type === 'tokens') {
            if (value >= 1000000)
                return `${value / 1000000}M token${value === 1000000 ? '' : 's'}!`;
            if (value >= 1000)
                return `${value / 1000}k tokens!`;
            return `${value} tokens!`;
        }
        return `Milestone: ${value}`;
    }
    // ============================================================================
    // Persistence
    // ============================================================================
    load() {
        if (this.data)
            return this.data;
        if (!fs_1.default.existsSync(this.statsPath)) {
            // Initialize with empty data
            this.data = {
                sessions: [],
                monthly: {},
                allTime: {
                    totalTokens: 0,
                    totalTime: 0,
                    totalTasks: 0,
                    longestStreak: { days: 0, start: '', end: '' },
                    firstSession: new Date()
                },
                milestones: []
            };
            return this.data;
        }
        try {
            const content = fs_1.default.readFileSync(this.statsPath, 'utf-8');
            this.data = JSON.parse(content);
            // Migrate dates from strings to Date objects
            if (this.data) {
                this.data.sessions.forEach(s => {
                    s.startTime = new Date(s.startTime);
                    if (s.endTime)
                        s.endTime = new Date(s.endTime);
                });
                this.data.allTime.firstSession = new Date(this.data.allTime.firstSession);
                this.data.milestones.forEach(m => {
                    m.reached = new Date(m.reached);
                });
            }
            return this.data;
        }
        catch (error) {
            console.error('Failed to load stats:', error);
            // Return fresh data on error
            this.data = {
                sessions: [],
                monthly: {},
                allTime: {
                    totalTokens: 0,
                    totalTime: 0,
                    totalTasks: 0,
                    longestStreak: { days: 0, start: '', end: '' },
                    firstSession: new Date()
                },
                milestones: []
            };
            return this.data;
        }
    }
    save(data) {
        // Ensure directory exists
        const dir = path_1.default.dirname(this.statsPath);
        if (!fs_1.default.existsSync(dir)) {
            fs_1.default.mkdirSync(dir, { recursive: true });
        }
        // Atomic write: write to temp file, then rename
        const tempPath = `${this.statsPath}.tmp`;
        const content = JSON.stringify(data, null, 2);
        fs_1.default.writeFileSync(tempPath, content, 'utf-8');
        fs_1.default.renameSync(tempPath, this.statsPath);
        this.data = data;
    }
    // ============================================================================
    // Helper Methods
    // ============================================================================
    findOrCreateSession(sessionId, data) {
        let session = data.sessions.find(s => s.id === sessionId);
        if (!session) {
            session = {
                id: sessionId,
                startTime: new Date(),
                tokenCount: { input: 0, output: 0, total: 0 },
                tasksCompleted: [],
                projectId: 'unknown',
                agentsInvoked: []
            };
            data.sessions.push(session);
        }
        return session;
    }
    getOrCreateMonthlyStats(month, data) {
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
    countTasksOnDate(date, data) {
        return data.sessions
            .filter(s => this.getDateKey(new Date(s.startTime)) === date)
            .reduce((sum, s) => sum + s.tasksCompleted.length, 0);
    }
    /**
     * Clear all stats (for testing)
     */
    clear() {
        if (fs_1.default.existsSync(this.statsPath)) {
            fs_1.default.unlinkSync(this.statsPath);
        }
        this.data = null;
        this.currentSessionId = null;
    }
}
exports.StatsService = StatsService;
