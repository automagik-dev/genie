# Test: Send message works with full worker ID

## Setup
- start follow on team
- spawn engineer (provider: claude)

## Actions
1. send "reply with FULLID_QA_OK" to engineer
2. wait 30s

## Expect
- [ ] follow stream contains event kind=message text~=FULLID_QA_OK
