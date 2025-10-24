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

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

// ============================================================================
// Data Models (Complete from Wish)
// ============================================================================

export interface SessionStats {
  id: string;
  startTime: string; // ISO timestamp
  endTime?: string;
  tokenCount: { input: number; output: number; total: number };
  tasksCompleted: string[]; // Task IDs
  projectId: string;
  projectName: string;
  agentsInvoked: string[];
}

export interface DailyActivity {
  date: string; // YYYY-MM-DD
  tokenCount: number;
  taskCount: number;
  sessionCount: number;
  active: boolean;
}

export interface MonthlyStats {
  month: string; // YYYY-MM
  tokenTotal: number;
  timeTotal: number; // milliseconds
  taskCount: number;
  wishCount: number;
  dailyActivity: DailyActivity[];
  peakSession: { date: string; tokens: number; sessionId: string };
  peakDay: { date: string; tasks: number };
}

export interface AllTimeStats {
  totalTokens: number;
  totalTime: number; // milliseconds
  totalTasks: number;
  totalSessions: number;
  longestStreak: { days: number; start: string; end: string };
  firstSession: string; // ISO timestamp
}

export interface Milestone {
  type: 'tokens' | 'streak' | 'tasks';
  value: number;
  title: string;
  reached: string; // ISO timestamp
  sessionId: string;
}

export interface StatsData {
  currentSession: SessionStats | null;
  sessions: SessionStats[]; // Last 100 sessions
  monthly: Record<string, MonthlyStats>;
  allTime: AllTimeStats;
  milestones: Milestone[];
  lastUpdated: string;
}

// ============================================================================
// Stats Tracker Class
// ============================================================================

export class StatsTracker {
  private dataPath: string;
  private currentSessionPath: string;
  private workspaceRoot: string;

  constructor(workspaceRoot: string) {
    this.workspaceRoot = workspaceRoot;
    this.dataPath = path.join(workspaceRoot, '.genie/state/stats-history.json');
    this.currentSessionPath = path.join(workspaceRoot, '.genie/state/current-session.json');
  }

  // ============================================================================
  // Session Management
  // ============================================================================

  startSession(projectId: string, projectName: string): SessionStats {
    const session: SessionStats = {
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

  endSession(sessionId: string): void {
    const current = this.loadCurrentSession();
    if (!current || current.id !== sessionId) return;

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

  getCurrentSession(): SessionStats | null {
    return this.loadCurrentSession();
  }

  // ============================================================================
  // Token Tracking
  // ============================================================================

  recordTokens(sessionId: string, inputTokens: number, outputTokens: number): void {
    const current = this.loadCurrentSession();
    if (!current || current.id !== sessionId) return;

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

  recordTaskCompletion(sessionId: string, taskId: string, taskTitle: string): void {
    const current = this.loadCurrentSession();
    if (!current || current.id !== sessionId) return;

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

  recordWishFulfillment(sessionId: string): void {
    const data = this.load();
    const month = this.getMonthKey(new Date());
    const monthly = this.getOrCreateMonthly(data, month);
    monthly.wishCount++;
    this.save(data);
  }

  recordAgentInvocation(sessionId: string, agentId: string): void {
    const current = this.loadCurrentSession();
    if (!current || current.id !== sessionId) return;

    if (!current.agentsInvoked.includes(agentId)) {
      current.agentsInvoked.push(agentId);
    }

    this.saveCurrentSession(current);
  }

  // ============================================================================
  // Query Methods
  // ============================================================================

  getMonthlyStats(month: string): MonthlyStats {
    const data = this.load();
    return this.getOrCreateMonthly(data, month);
  }

  getMonthlyComparison(month: string): { current: MonthlyStats; previous: MonthlyStats | null; changes: any } {
    const data = this.load();
    const current = this.getOrCreateMonthly(data, month);

    // Get previous month
    const [year, monthNum] = month.split('-').map(Number);
    const prevDate = new Date(year, monthNum - 2, 1); // monthNum is 1-based, subtract 2 to get previous
    const prevMonth = this.getMonthKey(prevDate);
    const previous = data.monthly[prevMonth] || null;

    let changes: any = {};
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

  getAllTimeStats(): AllTimeStats {
    const data = this.load();
    const streak = this.calculateStreak();
    data.allTime.longestStreak = streak.longest;
    return data.allTime;
  }

  calculateStreak(): { current: { days: number; start: string }; longest: { days: number; start: string; end: string } } {
    const data = this.load();
    const today = this.getDateKey(new Date());

    // Collect all active days sorted descending
    const allDays: DailyActivity[] = [];
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
      } else if (currentStreak > 0) {
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
      } else {
        const prevDate = new Date(sortedAsc[i - 1].date);
        const currDate = new Date(sortedAsc[i].date);
        const dayDiff = Math.floor((currDate.getTime() - prevDate.getTime()) / 86400000);

        if (dayDiff === 1) {
          tempStreak++;
        } else {
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

  getTodayStats(): { tokens: number; tasks: number; sessions: number } {
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

  getRecentMilestones(count: number = 5): Milestone[] {
    const data = this.load();
    return data.milestones
      .sort((a, b) => new Date(b.reached).getTime() - new Date(a.reached).getTime())
      .slice(0, count);
  }

  // ============================================================================
  // Milestone Detection
  // ============================================================================

  private checkMilestones(data: StatsData, session: SessionStats): void {
    const milestones: Array<{ type: 'tokens'; value: number; title: string }> = [
      { type: 'tokens', value: 100000, title: '🎉 100k tokens!' },
      { type: 'tokens', value: 500000, title: '🚀 500k tokens!' },
      { type: 'tokens', value: 1000000, title: '🏆 Million token club!' },
      { type: 'tokens', value: 5000000, title: '💎 5M tokens!' },
      { type: 'tokens', value: 10000000, title: '🌟 10M tokens!' }
    ];

    for (const m of milestones) {
      const alreadyReached = data.milestones.some(
        milestone => milestone.type === m.type && milestone.value === m.value && milestone.sessionId === session.id
      );

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

  private storeInGitNotes(session: SessionStats): void {
    try {
      // Get current HEAD commit
      const commit = execSync('git rev-parse HEAD', { cwd: this.workspaceRoot, encoding: 'utf-8' }).trim();

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
      execSync(`git notes --ref=genie/stats add -f -m '${notesContent.replace(/'/g, "'\\''")}'${commit}`, {
        cwd: this.workspaceRoot,
        encoding: 'utf-8'
      });

      console.error(`📝 Stats stored in git notes for commit ${commit.slice(0, 7)}`);
    } catch (error) {
      // Silently fail if not in git repo or git notes fail
      console.error(`⚠️  Could not store stats in git notes: ${(error as Error).message}`);
    }
  }

  // ============================================================================
  // Persistence
  // ============================================================================

  private load(): StatsData {
    if (!fs.existsSync(this.dataPath)) {
      return this.createEmpty();
    }

    try {
      const content = fs.readFileSync(this.dataPath, 'utf-8');
      return JSON.parse(content);
    } catch {
      return this.createEmpty();
    }
  }

  private save(data: StatsData): void {
    data.lastUpdated = new Date().toISOString();

    const dir = path.dirname(this.dataPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    fs.writeFileSync(this.dataPath, JSON.stringify(data, null, 2));
  }

  private loadCurrentSession(): SessionStats | null {
    if (!fs.existsSync(this.currentSessionPath)) return null;

    try {
      const content = fs.readFileSync(this.currentSessionPath, 'utf-8');
      return JSON.parse(content);
    } catch {
      return null;
    }
  }

  private saveCurrentSession(session: SessionStats): void {
    const dir = path.dirname(this.currentSessionPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    fs.writeFileSync(this.currentSessionPath, JSON.stringify(session, null, 2));
  }

  private clearCurrentSession(): void {
    if (fs.existsSync(this.currentSessionPath)) {
      fs.unlinkSync(this.currentSessionPath);
    }
  }

  private createEmpty(): StatsData {
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

  private generateSessionId(): string {
    const now = new Date();
    const dateStr = now.toISOString().slice(0, 16).replace(/[-:T]/g, '');
    const random = Math.random().toString(36).substring(2, 6);
    return `session-${dateStr}-${random}`;
  }

  private getMonthKey(date: Date): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    return `${year}-${month}`;
  }

  private getDateKey(date: Date): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  private getOrCreateMonthly(data: StatsData, month: string): MonthlyStats {
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

  private markDayActive(data: StatsData): void {
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

  private countTasksToday(data: StatsData): number {
    const today = this.getDateKey(new Date());
    const month = this.getMonthKey(new Date());
    const monthly = data.monthly[month];

    if (!monthly) return 0;

    const day = monthly.dailyActivity.find(d => d.date === today);
    return day ? day.taskCount : 0;
  }

  private calculatePercentChange(oldValue: number, newValue: number): number {
    if (oldValue === 0) return newValue > 0 ? 100 : 0;
    return ((newValue - oldValue) / oldValue) * 100;
  }
}
