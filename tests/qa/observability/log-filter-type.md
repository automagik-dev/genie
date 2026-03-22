# Test: Log filters by event type

## Setup
- spawn engineer (provider: claude)

## Actions
1. send "run echo FILTER_TEST in bash" to engineer
2. wait 20s
3. run genie log engineer --ndjson --type message
4. run genie log engineer --ndjson --last 5

## Expect
- [ ] output contains message
- [ ] output contains FILTER_TEST
