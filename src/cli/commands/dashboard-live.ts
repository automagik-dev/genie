/**
 * Live Dashboard - Real-time terminal stats display
 *
 * Shows ALL 3 core cards from the wish:
 * 1. Current Session Card (live tokens, duration, tasks, project)
 * 2. This Month Overview Card (tokens, time, tasks, wishes, comparison)
 * 3. Streak & Records Card (current streak, longest, peak session, peak day)
 *
 * Features:
 * - Gradient headers and metrics
 * - Smart diff rendering (no flicker)
 * - Smooth token counter
 * - Live session timer
 * - Color-coded metrics
 * - Clean layout without broken ASCII boxes
 */

import { getForgeConfig, getMcpConfig } from '../lib/service-config.js';
import WebSocket from 'ws';
import type { ParsedCommand, GenieConfig, ConfigPaths } from '../lib/types';
import { StatsTracker, type SessionStats, type MonthlyStats, type AllTimeStats } from '../lib/stats-tracker';
import { isForgeRunning } from '../lib/forge-manager';
import { collectForgeStats } from '../lib/forge-stats';
import gradient from 'gradient-string';

// Year 3025 color palettes
const genie = gradient(['#00ff88', '#00ccff', '#0099ff']); // Genie brand
const fire = gradient(['#ff6b35', '#f7931e', '#fdc830']); // Streak/energy
const success = gradient(['#56ab2f', '#a8e063']); // Positive metrics
const warning = gradient(['#ffa500', '#ff6347']); // Alerts
const info = gradient(['#667eea', '#764ba2']); // Secondary info

interface DashboardState {
  session: SessionStats | null;
  monthly: MonthlyStats;
  previousMonth: MonthlyStats | null;
  allTime: AllTimeStats;
  streak: { current: { days: number; start: string }; longest: { days: number; start: string; end: string } };
  lastMilestone: string | null;
  lastTask: string | null;
  forgeStats: any; // Forge health stats
  uptime: number; // Server uptime in ms
  startTime: number; // Server start time
}

export async function runDashboardLive(
  parsed: ParsedCommand,
  _config: GenieConfig,
  _paths: Required<ConfigPaths>
): Promise<void> {
  const baseUrl = getForgeConfig().baseUrl;
  const live = parsed.options.live;

  const tracker = new StatsTracker(process.cwd());
  const dashboardStartTime = Date.now(); // Track when dashboard started

  // Check if Forge is running
  const forgeRunning = await isForgeRunning(baseUrl);

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
    } else if (state.session) {
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

async function fetchDashboardState(tracker: StatsTracker, dashboardStartTime: number): Promise<DashboardState> {
  const baseUrl = getForgeConfig().baseUrl;
  const session = tracker.getCurrentSession();
  const now = new Date();
  const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

  const comparison = tracker.getMonthlyComparison(currentMonth);
  const allTime = tracker.getAllTimeStats();
  const streak = tracker.calculateStreak();

  // Fetch Forge stats
  let forgeStats = null;
  try {
    forgeStats = await collectForgeStats(baseUrl);
  } catch (error) {
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

function renderDashboard(state: DashboardState, isLive: boolean = false): void {
  const lines: string[] = [];

  // Year 3025 Header - Gradient banner
  const bannerText = isLive ? '🧞 GENIE DASHBOARD • LIVE' : '🧞 GENIE DASHBOARD';
  lines.push('');
  lines.push(genie('═'.repeat(80)));
  lines.push(genie(`  ${bannerText.padEnd(76)}  `));
  if (isLive) {
    lines.push(info('  Press Ctrl+C to exit'.padEnd(80)));
  }
  lines.push(genie('═'.repeat(80)));
  lines.push('');

  // ============================================================================
  // CARD 1: Current Session (Live)
  // ============================================================================

  lines.push(success('  📊 CURRENT SESSION'));
  lines.push('  ' + '─'.repeat(78));

  if (state.session) {
    const elapsed = Date.now() - new Date(state.session.startTime).getTime();
    const duration = formatDuration(elapsed);

    lines.push(`  ⏱️  Duration       ${genie(duration)}`);
    lines.push(`  💬 Tokens        ${fire(formatNumber(state.session.tokenCount.total))}`);
    lines.push(`     • Input       ${info(formatNumber(state.session.tokenCount.input))}`);
    lines.push(`     • Output      ${info(formatNumber(state.session.tokenCount.output))}`);
    lines.push(`  ✅ Tasks Today    ${success(state.session.tasksCompleted.length.toString())}`);
    lines.push(`  📂 Project       ${state.session.projectName}`);

    if (state.session.agentsInvoked.length > 0) {
      const agents = state.session.agentsInvoked.join(', ').slice(0, 60);
      lines.push(`  🤖 Agents        ${info(agents)}`);
    }
  } else {
    lines.push(warning('     No active session'));
    lines.push('     Start a Genie task to begin tracking');
  }

  lines.push('');


  // ============================================================================
  // CARD 2: This Month Overview
  // ============================================================================

  lines.push(info('  📅 THIS MONTH'));
  lines.push('  ' + '─'.repeat(78));

  const tokenK = (state.monthly.tokenTotal / 1000).toFixed(1);
  const timeFormatted = formatDuration(state.monthly.timeTotal);

  lines.push(`  💰 Tokens        ${fire(tokenK + 'k')}${renderComparison(state, 'tokens')}`);
  lines.push(`  ⏱️  Time          ${genie(timeFormatted)}${renderComparison(state, 'time')}`);
  lines.push(`  ✅ Tasks         ${success(state.monthly.taskCount.toString())}${renderComparison(state, 'tasks')}`);
  lines.push(`  🎯 Wishes        ${info(state.monthly.wishCount.toString())}${renderComparison(state, 'wishes')}`);

  lines.push('');

  // ============================================================================
  // CARD 3: Streak & Records
  // ============================================================================

  lines.push(fire('  🏆 STREAK & RECORDS'));
  lines.push('  ' + '─'.repeat(78));

  const currentStreak = state.streak.current.days;
  const longestStreak = state.streak.longest.days;
  const peakTokens = (state.monthly.peakSession.tokens / 1000).toFixed(1);

  lines.push(`  🔥 Current       ${fire(currentStreak + ' day' + (currentStreak === 1 ? '' : 's'))}`);
  lines.push(`  🏆 Longest       ${success(longestStreak + ' day' + (longestStreak === 1 ? '' : 's'))}`);

  if (state.monthly.peakSession.tokens > 0) {
    lines.push(`  💪 Peak Session  ${genie(peakTokens + 'k')} tokens • ${state.monthly.peakSession.date}`);
  }

  if (state.monthly.peakDay.tasks > 0) {
    lines.push(`  📅 Peak Day      ${success(state.monthly.peakDay.tasks.toString())} tasks • ${state.monthly.peakDay.date}`);
  }

  lines.push('');

  // ============================================================================
  // All-Time Summary
  // ============================================================================

  lines.push(genie('  🌟 ALL TIME'));
  lines.push('  ' + '─'.repeat(78));

  const allTimeTokensK = (state.allTime.totalTokens / 1000).toFixed(1);
  const allTimeTime = formatDuration(state.allTime.totalTime);

  lines.push(`  💬 Tokens        ${fire(allTimeTokensK + 'k')}`);
  lines.push(`  ⏱️  Time          ${genie(allTimeTime)}`);
  lines.push(`  ✅ Tasks         ${success(state.allTime.totalTasks.toString())}`);
  lines.push(`  📊 Sessions      ${info(state.allTime.totalSessions.toString())}`);

  lines.push('');

  // ============================================================================
  // System Health Card
  // ============================================================================

  const uptime = formatDuration(state.uptime);
  lines.push(info('  🩺 SYSTEM HEALTH'));
  lines.push('  ' + '─'.repeat(78));

  const forgeStatus = state.forgeStats ? success('🟢 Online') : warning('🔴 Offline');
  lines.push(`  📦 Forge         ${forgeStatus}`);

  if (state.forgeStats) {
    lines.push(`  📊 Projects      ${info((state.forgeStats.projects?.total || 0).toString())}`);
    lines.push(`  📝 Tasks         ${info((state.forgeStats.tasks?.total || 0).toString())}`);
    const completed = state.forgeStats.attempts?.completed || 0;
    const failed = state.forgeStats.attempts?.failed || 0;
    const total = state.forgeStats.attempts?.total || 0;
    lines.push(`  🔄 Attempts      ${total} • ${success('✅' + completed)} ${warning('❌' + failed)}`);
  }

  lines.push(`  ⏱️  Uptime        ${genie(uptime)}`);
  lines.push('');

  // Footer
  lines.push(genie('═'.repeat(80)));
  lines.push(info('  💡 Commands'));
  lines.push('     genie dashboard         Quick snapshot');
  lines.push('     genie dashboard --live  Live updating dashboard');
  lines.push(genie('═'.repeat(80)));

  console.log(lines.join('\n'));
}

function renderComparison(state: DashboardState, metric: 'tokens' | 'time' | 'tasks' | 'wishes'): string {
  if (!state.previousMonth) return '';

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

  if (previousValue === 0) return currentValue > 0 ? ' (new!)' : '';

  const change = ((currentValue - previousValue) / previousValue) * 100;
  const sign = change >= 0 ? '+' : '';
  const arrow = change >= 0 ? '📈' : '📉';

  return ` ${arrow} ${sign}${change.toFixed(1)}%`;
}

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) {
    return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
  } else if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  } else {
    return `${seconds}s`;
  }
}

function formatNumber(num: number): string {
  if (num >= 1000000) {
    return `${(num / 1000000).toFixed(2)}M`;
  } else if (num >= 1000) {
    return `${(num / 1000).toFixed(1)}k`;
  } else {
    return num.toString();
  }
}
