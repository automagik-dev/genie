# MCP Performance Benchmarks

**Date:** 2025-10-01T18:53:06.621Z
**Iterations:** 10 per tool
**Target:** <500ms for list operations

## Summary

| Tool | Avg (ms) | P95 (ms) | P99 (ms) | Target | Status |
|------|----------|----------|----------|--------|--------|
| list_agents | 2 | 4 | 4 | <500ms | ✅ PASS |
| list_sessions | 2 | 2 | 2 | <500ms | ✅ PASS |
| run | 5 | 7 | 7 | baseline | N/A |
| view | 5 | 5 | 5 | baseline | N/A |
| resume | 5 | 6 | 6 | baseline | N/A |
| stop | 4 | 4 | 4 | baseline | N/A |

## Detailed Results

### list_agents

- **Iterations:** 10
- **Average:** 2ms
- **Median:** 2ms
- **P95:** 4ms
- **P99:** 4ms
- **Min/Max:** 1ms / 4ms

### list_sessions

- **Iterations:** 10
- **Average:** 2ms
- **Median:** 2ms
- **P95:** 2ms
- **P99:** 2ms
- **Min/Max:** 1ms / 2ms

### run

- **Iterations:** 10
- **Average:** 5ms
- **Median:** 5ms
- **P95:** 7ms
- **P99:** 7ms
- **Min/Max:** 4ms / 7ms

### view

- **Iterations:** 10
- **Average:** 5ms
- **Median:** 5ms
- **P95:** 5ms
- **P99:** 5ms
- **Min/Max:** 4ms / 5ms

### resume

- **Iterations:** 10
- **Average:** 5ms
- **Median:** 5ms
- **P95:** 6ms
- **P99:** 6ms
- **Min/Max:** 4ms / 6ms

### stop

- **Iterations:** 1
- **Average:** 4ms
- **Median:** 4ms
- **P95:** 4ms
- **P99:** 4ms
- **Min/Max:** 4ms / 4ms

## Validation

✅ list_agents: PASS (<500ms target)
✅ list_sessions: PASS (<500ms target)
📊 Other tools: Baseline measurements captured for future optimization

## Environment

- Platform: linux
- Node.js: v22.16.0
- Transport: stdio
