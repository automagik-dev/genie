# Test: Agent spawn and kill lifecycle

## Setup
- start follow on team

## Actions
1. spawn engineer (provider: claude)
2. wait 5s
3. run genie ls --json
4. run genie kill engineer

## Expect
- [ ] output contains engineer
- [ ] output contains working
