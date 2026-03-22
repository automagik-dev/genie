# Test: QA specs are read from repo .genie/qa/ directory

## Setup
- start follow on team

## Actions
1. run mkdir -p /tmp/qa-test-repo/.genie/qa/smoke && echo '# Test: dummy' > /tmp/qa-test-repo/.genie/qa/smoke/dummy.md && cd /tmp/qa-test-repo && genie qa status 2>&1
2. wait 2s

## Expect
- [ ] output contains dummy
- [ ] output contains smoke
