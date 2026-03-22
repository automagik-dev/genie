# Test: Follow mode captures user prompts and assistant responses

## Setup
- start follow on team
- spawn engineer (provider: claude)

## Actions
1. send "say exactly: HELLO_QA_FOLLOW" to engineer
2. wait 30s

## Expect
- [ ] follow stream contains event kind=user text~=HELLO_QA_FOLLOW
- [ ] follow stream contains event kind=assistant
- [ ] follow stream contains event kind=tool_call
