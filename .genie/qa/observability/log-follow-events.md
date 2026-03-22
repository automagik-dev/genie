# Test: Follow mode captures tool calls and messages

## Setup
- start follow on team
- spawn engineer (provider: claude)

## Actions
1. send "echo HELLO_QA_FOLLOW and send me done" to engineer
2. wait 30s

## Expect
- [ ] follow stream contains event kind=tool_call text~=HELLO_QA_FOLLOW
- [ ] follow stream contains event kind=message text~=HELLO_QA_FOLLOW
