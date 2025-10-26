"use strict";
/**
 * Live Dashboard - Real-time terminal stats display
 *
 * Shows ALL 3 core cards from the wish:
 * 1. Current Session Card (live tokens, duration, tasks, project)
 * 2. This Month Overview Card (tokens, time, tasks, wishes, comparison)
 * 3. Streak & Records Card (current streak, longest, peak session, peak day)
 *
 * Features:
 * - Animated token counter
 * - Live session timer
 * - Milestone flash notifications
 * - Task completion notifications
 * - Monthly comparison with % indicators
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.runDashboardLive = runDashboardLive;
const stats_tracker_1 = require("../lib/stats-tracker");
const forge_manager_1 = require("../lib/forge-manager");
const forge_stats_1 = require("../lib/forge-stats");
async function runDashboardLive(parsed, _config, _paths) {
    const baseUrl = process.env.FORGE_BASE_URL || 'http://localhost:8887';
    const live = parsed.options.live;
    const tracker = new stats_tracker_1.StatsTracker(process.cwd());
    const dashboardStartTime = Date.now(); // Track when dashboard started
    // Check if Forge is running
    const forgeRunning = await (0, forge_manager_1.isForgeRunning)(baseUrl);
    if (!forgeRunning) {
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('🧞 GENIE DASHBOARD');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('');
        console.log('🔴 Forge backend is offline');
        console.log('');
        console.log('💡 Start Forge: npx automagik-genie');
        console.log('');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        return;
    }
    if (!live) {
        // One-time snapshot
        const state = await fetchDashboardState(tracker, dashboardStartTime);
        renderDashboard(state);
        return;
    }
    // Live mode - updates every second
    console.clear();
    let state = await fetchDashboardState(tracker, dashboardStartTime);
    let sessionStartTime = state.session ? new Date(state.session.startTime).getTime() : null;
    const renderLoop = setInterval(async () => {
        console.clear();
        // Update state
        state = await fetchDashboardState(tracker, dashboardStartTime);
        // Update session timer
        if (state.session && sessionStartTime) {
            const elapsed = Date.now() - sessionStartTime;
            state.session = { ...state.session, startTime: new Date(sessionStartTime).toISOString() };
        }
        else if (state.session) {
            sessionStartTime = new Date(state.session.startTime).getTime();
        }
        renderDashboard(state, true);
    }, 1000); // Update every second
    // Handle Ctrl+C gracefully
    process.on('SIGINT', () => {
        clearInterval(renderLoop);
        console.log('\n\n👋 Dashboard closed');
        process.exit(0);
    });
}
async function fetchDashboardState(tracker, dashboardStartTime) {
    const baseUrl = process.env.FORGE_BASE_URL || 'http://localhost:8887';
    const session = tracker.getCurrentSession();
    const now = new Date();
    const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const comparison = tracker.getMonthlyComparison(currentMonth);
    const allTime = tracker.getAllTimeStats();
    const streak = tracker.calculateStreak();
    // Fetch Forge stats
    let forgeStats = null;
    try {
        forgeStats = await (0, forge_stats_1.collectForgeStats)(baseUrl);
    }
    catch (error) {
        // Forge might be unavailable, continue without stats
    }
    return {
        session,
        monthly: comparison.current,
        previousMonth: comparison.previous,
        allTime,
        streak,
        lastMilestone: null, // TODO: Fetch from tracker
        lastTask: null,
        forgeStats,
        uptime: Date.now() - dashboardStartTime,
        startTime: dashboardStartTime
    };
}
function renderDashboard(state, isLive = false) {
    const lines = [];
    // Header
    lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    lines.push(`🧞 GENIE DASHBOARD ${isLive ? '(LIVE)' : ''}`);
    if (isLive) {
        lines.push('Press Ctrl+C to exit');
    }
    lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    lines.push('');
    // ============================================================================
    // CARD 1: Current Session (Live)
    // ============================================================================
    lines.push('┌─ 📊 CURRENT SESSION ─────────────────────────────────────────────────┐');
    if (state.session) {
        const elapsed = Date.now() - new Date(state.session.startTime).getTime();
        const duration = formatDuration(elapsed);
        lines.push(`│ ⏱️  Duration: ${duration.padEnd(54)} │`);
        lines.push(`│ 💬 Tokens: ${formatNumber(state.session.tokenCount.total).padEnd(56)} │`);
        lines.push(`│    ├─ 📥 Input: ${formatNumber(state.session.tokenCount.input).padEnd(49)} │`);
        lines.push(`│    └─ 📤 Output: ${formatNumber(state.session.tokenCount.output).padEnd(48)} │`);
        lines.push(`│ 📝 Tasks Completed Today: ${state.session.tasksCompleted.length.toString().padEnd(38)} │`);
        lines.push(`│ 📂 Project: ${state.session.projectName.padEnd(53)} │`);
        if (state.session.agentsInvoked.length > 0) {
            lines.push(`│ 🤖 Agents: ${state.session.agentsInvoked.join(', ').slice(0, 52).padEnd(54)} │`);
        }
    }
    else {
        lines.push(`│ ${' No active session'.padEnd(70)} │`);
        lines.push(`│ ${' Start a Genie task to begin tracking'.padEnd(70)} │`);
    }
    lines.push('└──────────────────────────────────────────────────────────────────────┘');
    lines.push('');
    // ============================================================================
    // CARD 2: This Month Overview
    // ============================================================================
    lines.push('┌─ 📅 THIS MONTH ──────────────────────────────────────────────────────┐');
    const tokenK = (state.monthly.tokenTotal / 1000).toFixed(1);
    const timeFormatted = formatDuration(state.monthly.timeTotal);
    lines.push(`│ 💰 Tokens: ${tokenK}k${renderComparison(state, 'tokens').padEnd(54)} │`);
    lines.push(`│ ⏱️  Time: ${timeFormatted}${renderComparison(state, 'time').padEnd(62 - timeFormatted.length)} │`);
    lines.push(`│ ✅ Tasks: ${state.monthly.taskCount}${renderComparison(state, 'tasks').padEnd(60)} │`);
    lines.push(`│ 🎯 Wishes: ${state.monthly.wishCount}${renderComparison(state, 'wishes').padEnd(59)} │`);
    lines.push('└──────────────────────────────────────────────────────────────────────┘');
    lines.push('');
    // ============================================================================
    // CARD 3: Streak & Records
    // ============================================================================
    lines.push('┌─ 🏆 STREAK & RECORDS ────────────────────────────────────────────────┐');
    const currentStreak = state.streak.current.days;
    const longestStreak = state.streak.longest.days;
    const peakTokens = (state.monthly.peakSession.tokens / 1000).toFixed(1);
    lines.push(`│ 🔥 Current Streak: ${currentStreak} day${currentStreak === 1 ? '' : 's'}`.padEnd(73) + '│');
    lines.push(`│ 🏆 Longest Streak: ${longestStreak} day${longestStreak === 1 ? '' : 's'}`.padEnd(73) + '│');
    if (state.monthly.peakSession.tokens > 0) {
        lines.push(`│ 💪 Peak Session: ${peakTokens}k tokens (${state.monthly.peakSession.date})`.padEnd(73) + '│');
    }
    if (state.monthly.peakDay.tasks > 0) {
        lines.push(`│ 📅 Peak Day: ${state.monthly.peakDay.tasks} tasks (${state.monthly.peakDay.date})`.padEnd(73) + '│');
    }
    lines.push('└──────────────────────────────────────────────────────────────────────┘');
    lines.push('');
    // ============================================================================
    // All-Time Summary
    // ============================================================================
    lines.push('┌─ 🌟 ALL TIME ────────────────────────────────────────────────────────┐');
    const allTimeTokensK = (state.allTime.totalTokens / 1000).toFixed(1);
    const allTimeTime = formatDuration(state.allTime.totalTime);
    lines.push(`│ 💬 Total Tokens: ${allTimeTokensK}k`.padEnd(73) + '│');
    lines.push(`│ ⏱️  Total Time: ${allTimeTime}`.padEnd(73) + '│');
    lines.push(`│ ✅ Total Tasks: ${state.allTime.totalTasks}`.padEnd(73) + '│');
    lines.push(`│ 📊 Total Sessions: ${state.allTime.totalSessions}`.padEnd(73) + '│');
    lines.push('└──────────────────────────────────────────────────────────────────────┘');
    lines.push('');
    // ============================================================================
    // System Health Card
    // ============================================================================
    const uptime = formatDuration(state.uptime);
    lines.push('┌─ 🩺 SYSTEM HEALTH ────────────────────────────────────────────────────┐');
    lines.push(`│ 📦 Forge Backend: ${state.forgeStats ? '🟢 Online' : '🔴 Offline'}`.padEnd(73) + '│');
    if (state.forgeStats) {
        lines.push(`│ 📊 Projects: ${state.forgeStats.projects?.total || 0}${' │'.padStart(57 - ('📊 Projects: ' + (state.forgeStats.projects?.total || 0)).length)} │`);
        lines.push(`│ 📝 Tasks: ${state.forgeStats.tasks?.total || 0}${' │'.padStart(61 - ('📝 Tasks: ' + (state.forgeStats.tasks?.total || 0)).length)} │`);
        lines.push(`│ 🔄 Attempts: ${state.forgeStats.attempts?.total || 0} (✅${state.forgeStats.attempts?.completed || 0} ❌${state.forgeStats.attempts?.failed || 0})`.padEnd(73) + '│');
    }
    lines.push(`│ ⏱️  Dashboard Uptime: ${uptime}`.padEnd(73) + '│');
    lines.push('└──────────────────────────────────────────────────────────────────────┘');
    lines.push('');
    // Footer
    lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    lines.push('💡 Commands:');
    lines.push('   genie dashboard         - Quick snapshot');
    lines.push('   genie dashboard --live  - Live updating dashboard');
    if (isLive) {
        lines.push('   Press Ctrl+C to exit');
    }
    lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(lines.join('\n'));
}
function renderComparison(state, metric) {
    if (!state.previousMonth)
        return '';
    const current = state.monthly;
    const previous = state.previousMonth;
    let currentValue = 0;
    let previousValue = 0;
    switch (metric) {
        case 'tokens':
            currentValue = current.tokenTotal;
            previousValue = previous.tokenTotal;
            break;
        case 'time':
            currentValue = current.timeTotal;
            previousValue = previous.timeTotal;
            break;
        case 'tasks':
            currentValue = current.taskCount;
            previousValue = previous.taskCount;
            break;
        case 'wishes':
            currentValue = current.wishCount;
            previousValue = previous.wishCount;
            break;
    }
    if (previousValue === 0)
        return currentValue > 0 ? ' (new!)' : '';
    const change = ((currentValue - previousValue) / previousValue) * 100;
    const sign = change >= 0 ? '+' : '';
    const arrow = change >= 0 ? '📈' : '📉';
    return ` ${arrow} ${sign}${change.toFixed(1)}%`;
}
function formatDuration(ms) {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    if (hours > 0) {
        return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
    }
    else if (minutes > 0) {
        return `${minutes}m ${seconds % 60}s`;
    }
    else {
        return `${seconds}s`;
    }
}
function formatNumber(num) {
    if (num >= 1000000) {
        return `${(num / 1000000).toFixed(2)}M`;
    }
    else if (num >= 1000) {
        return `${(num / 1000).toFixed(1)}k`;
    }
    else {
        return num.toString();
    }
}
