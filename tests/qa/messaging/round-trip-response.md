# Test: Agent receives message and responds via SendMessage

## Setup
- start follow on team
- spawn engineer (provider: claude)

## Actions
1. send "send me a message saying PONG_QA_TEST using SendMessage" to engineer
2. wait 30s

## Expect
- [ ] follow stream contains event kind=tool_call text~=PONG_QA_TEST
- [ ] follow stream contains event kind=message text~=PONG_QA_TEST
