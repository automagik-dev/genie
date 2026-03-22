# Test: QA discovers specs organized by domain

## Setup
- start follow on team

## Actions
1. run mkdir -p /tmp/qa-domain-test/.genie/qa/api /tmp/qa-domain-test/.genie/qa/auth && echo '# Test: health' > /tmp/qa-domain-test/.genie/qa/api/health.md && echo '# Test: login' > /tmp/qa-domain-test/.genie/qa/auth/login.md && echo 'not-a-spec.txt' > /tmp/qa-domain-test/.genie/qa/api/readme.txt && cd /tmp/qa-domain-test && genie qa status 2>&1
2. wait 2s

## Expect
- [ ] output contains api
- [ ] output contains auth
- [ ] output contains health
- [ ] output contains login
