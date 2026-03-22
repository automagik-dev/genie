# Test: NATS streaming delivers tool calls from real agent

## Setup
- start follow on team
- spawn engineer (provider: claude)

## Actions
1. send "run echo NATS_QA_TEST in bash and send me 'done'" to engineer
2. wait 30s

## Expect
- [ ] follow stream contains event kind=tool_call text~=NATS_QA_TEST
- [ ] follow stream contains event kind=message text~=done
