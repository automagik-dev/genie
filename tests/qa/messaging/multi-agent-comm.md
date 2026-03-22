# Test: Two agents communicate within same team

## Setup
- start follow on team
- spawn engineer (provider: claude)
- spawn reviewer (provider: claude)

## Actions
1. send "send a message to reviewer saying CROSS_AGENT_QA" to engineer
2. wait 30s

## Expect
- [ ] follow stream contains event kind=tool_call text~=SendMessage
- [ ] follow stream contains event kind=message text~=CROSS_AGENT_QA
- [ ] inbox has event peer=engineer text~=CROSS_AGENT_QA
