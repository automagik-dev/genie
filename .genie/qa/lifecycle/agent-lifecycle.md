# Test: Agent spawn completes and responds to task

## Setup
- start follow on team
- spawn engineer (provider: claude)

## Actions
1. send "echo LIFECYCLE_TEST and tell me done" to engineer
2. wait 30s

## Expect
- [ ] follow stream contains event kind=tool_call text~=LIFECYCLE_TEST
- [ ] follow stream contains event kind=message text~=LIFECYCLE_TEST
