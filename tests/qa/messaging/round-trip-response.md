# Test: Agent receives message and responds

## Setup
- start follow on team
- spawn engineer (provider: claude)

## Actions
1. send "respond with exactly: PONG_QA_TEST" to engineer
2. wait 30s

## Expect
- [ ] follow stream contains event kind=message text~=PONG_QA_TEST
- [ ] follow stream contains event kind=tool_call text~=SendMessage
