# Test: Static log reads all sources

## Setup
- spawn engineer (team: log-test)

## Actions
1. send "implement feature X" to engineer
2. wait 1s
3. run genie log engineer --ndjson --last 10

## Expect
- [ ] output contains kind=message
- [ ] output contains text~=implement feature
