# Brainstorm: /report skill + plugin rename + debug rename

## Problem
1. Plugin name "automagik-genie" is verbose — should be just "genie"
2. `/debug` skill conflicts with Claude Code's built-in debug
3. Need a comprehensive `/report` skill that investigates bugs using all available tools (browser screenshots, video, console, network, perf, Sentry) and produces a GitHub-ready issue

## Context gathered
- Plugin name lives in `plugins/genie/.claude-plugin/plugin.json` line 2
- OpenClaw id is already "genie" in `openclaw.plugin.json`
- agent-browser has: screenshots, video recording, console capture, error capture, network monitoring, performance profiling, visual diffing
- No Sentry MCP/integration currently installed — would need to be optional/discoverable
- 13 skills total in the plugin

## Debug rename candidates
- TBD (user choosing)

## /report skill design
- TBD
