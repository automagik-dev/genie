# Test: Agent becomes idle after completing task

## Setup
- start follow on team
- spawn engineer (provider: claude)

## Actions
1. send "echo IDLE_QA_TEST" to engineer
2. wait 30s

## Expect
- [ ] follow stream contains event kind=assistant
- [ ] follow stream contains event kind=tool_call text~=IDLE_QA_TEST
