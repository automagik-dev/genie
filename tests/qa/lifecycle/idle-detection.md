# Test: Agent completes task and tool calls are captured

## Setup
- start follow on team
- spawn engineer (provider: claude)

## Actions
1. send "echo IDLE_QA_TEST and send me done" to engineer
2. wait 30s

## Expect
- [ ] follow stream contains event kind=tool_call text~=IDLE_QA_TEST
- [ ] follow stream contains event kind=tool_call text~=SendMessage
