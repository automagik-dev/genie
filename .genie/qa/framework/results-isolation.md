# Test: QA results are isolated per repo

## Setup
- start follow on team

## Actions
1. run mkdir -p /tmp/qa-repo-a/.genie/qa && echo '# Test: repo-a test' > /tmp/qa-repo-a/.genie/qa/test-a.md && mkdir -p /tmp/qa-repo-b/.genie/qa && echo '# Test: repo-b test' > /tmp/qa-repo-b/.genie/qa/test-b.md && cd /tmp/qa-repo-a && genie qa status 2>&1 && echo "---SEPARATOR---" && cd /tmp/qa-repo-b && genie qa status 2>&1
2. wait 2s

## Expect
- [ ] output contains test-a
- [ ] output contains test-b
- [ ] output contains SEPARATOR
