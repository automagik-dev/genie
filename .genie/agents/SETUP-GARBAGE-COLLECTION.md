# Garbage Collection Setup Guide

Setup instructions for autonomous garbage collection system (collector + cleaner agents).

## Prerequisites

- Genie installed globally: `npm install -g automagik-genie@next`
- GitHub CLI configured: `gh auth login`
- Local cron access

## 1. Configure Local Cron

### Add Cron Job

```bash
# Edit crontab
crontab -e

# Add this line (replace /path/to/ with your actual repo path):
0 0 * * * cd /home/namastex/workspace/automagik-genie && genie run garbage-collector "Daily sweep" >> /tmp/garbage-collector.log 2>&1
```

**Breakdown:**
- `0 0 * * *` = Run daily at midnight (0:00)
- `cd /home/namastex/workspace/automagik-genie` = Navigate to repo
- `genie run garbage-collector "Daily sweep"` = Execute collector agent
- `>> /tmp/garbage-collector.log 2>&1` = Log output to /tmp/

### Verify Cron Job

```bash
# List cron jobs
crontab -l

# Check logs after first run
tail -f /tmp/garbage-collector.log
```

## 2. Initial Test Run (Manual)

Before waiting for cron, test manually:

```bash
cd /home/namastex/workspace/automagik-genie
genie run garbage-collector "Initial test sweep"
```

**Expected Output:**
- Scans all .md files in repo
- Creates GitHub issues for each quality issue found
- Generates report: `.genie/reports/garbage-collection-YYYY-MM-DD.md`
- Commits report to repo

## 3. Review Issues

After collector runs:

```bash
# List all garbage-collection issues
gh issue list --label garbage-collection

# View specific issue
gh issue view 123
```

## 4. Run Cleaner (After Review)

Once you've reviewed the issues and confirmed they're valid:

```bash
# Execute batch cleanup
genie run garbage-cleaner "Process all garbage-collection issues"
```

**Expected Output:**
- Fetches all open `garbage-collection` issues
- Implements fixes for each issue
- Creates cleanup branch: `chore/garbage-collection-YYYY-MM-DD`
- Generates PR with all changes
- Auto-closes issues when PR merges

## 5. PR Review & Merge

```bash
# List open PRs
gh pr list

# Review the cleanup PR
gh pr view <pr-number>

# Merge after review
gh pr merge <pr-number> --squash
```

## Workflow Summary

```
1. Cron triggers garbage-collector (0:00 daily)
   └─> Scans .md files
   └─> Creates GitHub issues
   └─> Generates daily report

2. Human reviews issues (when convenient)
   └─> Check gh issue list --label garbage-collection
   └─> Validate findings

3. Human triggers garbage-cleaner (manual)
   └─> genie run garbage-cleaner "Process all"
   └─> Implements fixes
   └─> Creates PR

4. Human reviews & merges PR
   └─> gh pr merge <number>
   └─> Issues auto-close
```

## Configuration Options

### Change Schedule

```bash
# Edit crontab
crontab -e

# Run twice daily (0:00 and 12:00):
0 0,12 * * * cd /path/to/repo && genie run garbage-collector "Daily sweep" >> /tmp/garbage-collector.log 2>&1

# Run weekly on Sunday:
0 0 * * 0 cd /path/to/repo && genie run garbage-collector "Weekly sweep" >> /tmp/garbage-collector.log 2>&1
```

### Change Log Location

```bash
# Use repo-local logs instead of /tmp/
0 0 * * * cd /path/to/repo && genie run garbage-collector "Daily sweep" >> .genie/logs/garbage-collector.log 2>&1
```

### Disable Automatic Report Commits

If you don't want reports auto-committed to repo, modify collector agent's "Daily Report Format" section to output to `/tmp/` instead of `.genie/reports/`.

## Troubleshooting

### Cron Not Running

```bash
# Check cron service status
systemctl status cron  # Ubuntu/Debian
systemctl status crond # RHEL/CentOS

# Check cron logs
grep CRON /var/log/syslog  # Ubuntu/Debian
grep CRON /var/log/cron    # RHEL/CentOS
```

### Genie Command Not Found

```bash
# Verify genie installed globally
which genie

# If not found, install:
npm install -g automagik-genie@next

# Or use full path in crontab:
0 0 * * * cd /path/to/repo && /usr/local/bin/genie run garbage-collector "Daily sweep"
```

### GitHub Issues Not Created

```bash
# Check GitHub CLI auth
gh auth status

# Re-authenticate if needed
gh auth login
```

### Permissions Issues

```bash
# Ensure repo directory is accessible by cron user
ls -la /path/to/automagik-genie

# Make cron log writable
touch /tmp/garbage-collector.log
chmod 666 /tmp/garbage-collector.log
```

## Advanced: GitHub Actions Alternative

If you prefer GitHub Actions over local cron:

**`.github/workflows/garbage-collector.yml`:**
```yaml
name: Garbage Collector
on:
  schedule:
    - cron: '0 0 * * *'  # Daily at 0:00 UTC
  workflow_dispatch:      # Manual trigger

jobs:
  collect:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
      - run: npm install -g automagik-genie@next
      - run: genie run garbage-collector "Daily sweep"
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
      - run: |
          git config user.name "github-actions[bot]"
          git config user.email "github-actions[bot]@users.noreply.github.com"
          git add .genie/reports/
          git commit -m "chore: Add garbage collection report" || true
          git push
```

**Note:** GitHub Actions approach requires CI setup and uses Actions minutes.

## Monitoring

### Daily Report Location

```bash
# View latest report
ls -lt .genie/reports/garbage-collection-*.md | head -1 | xargs cat

# Compare token savings over time
grep "Estimated token waste" .genie/reports/garbage-collection-*.md
```

### Issue Metrics

```bash
# Count open garbage-collection issues
gh issue list --label garbage-collection --state open --json number | jq length

# Count closed issues (fixed)
gh issue list --label garbage-collection --state closed --json number | jq length
```

## Maintenance

### Update Detection Rules

If false positives occur, update `.genie/agents/garbage-collector.md` detection rules and mark issue with `false-positive` label:

```bash
gh issue edit 123 --add-label false-positive
```

Garbage-cleaner will skip issues labeled `false-positive`.

### Pause Collection

```bash
# Remove cron job temporarily
crontab -e
# Comment out the line with #

# Re-enable later by uncommenting
```
