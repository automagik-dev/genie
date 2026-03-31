# Test: Mailbox delivery with NATS event

## Setup
- start follow on team

## Actions
1. send "please review PR #42" to reviewer
2. wait 2s

## Expect
- [ ] follow stream contains event kind=message peer=reviewer
- [ ] follow stream contains event source=mailbox text~=review PR
