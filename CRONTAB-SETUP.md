# Crontab Setup - Daily Standup Automation

## Quick Setup

### 1. Open Crontab Editor
```bash
crontab -e
```

### 2. Add This Line

```cron
# Genie Daily Standup - Runs at 9:05 AM every day
5 9 * * * cd /home/namastex/workspace/automagik-genie && genie task daily-standup "Generate 24h summary for dev branch" >> /tmp/genie-standup.log 2>&1
```

### 3. Save and Exit
- **Nano:** `Ctrl+X`, then `Y`, then `Enter`
- **Vim:** `:wq`

### 4. Verify Installation
```bash
crontab -l
```

You should see the entry listed.

---

## What This Does

**Schedule:** 9:05 AM every day (system timezone)

**Actions:**
1. Changes to Genie repository directory
2. Runs `genie task daily-standup` in headless mode
3. Agent analyzes past 24h git activity on `dev` branch
4. Formats summary with commits grouped by type (feat, fix, chore)
5. Sends WhatsApp message to **Namastexers** group via Omni MCP
6. Logs output to `/tmp/genie-standup.log`

**Target Group:** Namastexers (`120363345897732032@g.us`)

**Omni Instance:** `genie`

---

## Crontab Format Explained

```
5 9 * * *
│ │ │ │ │
│ │ │ │ └─── Day of week (0-7, Sunday = 0 or 7)
│ │ │ └───── Month (1-12)
│ │ └─────── Day of month (1-31)
│ └───────── Hour (0-23)
└─────────── Minute (0-59)
```

**Our entry:** `5 9 * * *`
- Minute: 5
- Hour: 9 (9 AM)
- Every day of month (*)
- Every month (*)
- Every day of week (*)

Result: **9:05 AM every single day**

---

## Monitoring and Debugging

### Check Logs
```bash
# View latest logs
tail -f /tmp/genie-standup.log

# View full log history
cat /tmp/genie-standup.log

# Clear logs
> /tmp/genie-standup.log
```

### Test Manually (Before Crontab)
```bash
# Headless test (same as cron will run)
genie task daily-standup "Generate 24h summary for dev branch"

# Browser test (see it work visually)
genie run daily-standup "Generate 24h summary for dev branch"
```

### Check Crontab Status
```bash
# List all cron jobs
crontab -l

# Check if cron service is running (WSL2/Linux)
service cron status

# Restart cron service if needed
sudo service cron restart
```

### Remove/Disable Crontab Entry
```bash
# Option 1: Edit and delete the line
crontab -e

# Option 2: Remove all cron jobs (CAREFUL!)
crontab -r
```

---

## Timezone Considerations

**WSL2/Linux:** Uses system timezone

Check current timezone:
```bash
timedatectl
```

If timezone is wrong, update:
```bash
sudo timedatectl set-timezone America/Sao_Paulo  # Example
```

---

## Common Issues

### Issue: Crontab doesn't run
**Solution:** Check cron service is running
```bash
sudo service cron start
sudo service cron status
```

### Issue: No WhatsApp message sent
**Solutions:**
1. Check Omni `genie` instance is connected:
   ```bash
   genie task code/explore "Check Omni genie instance status"
   ```
2. Check logs: `tail /tmp/genie-standup.log`
3. Test manually first before adding to crontab

### Issue: No git activity shown
**Cause:** No commits in past 24h (normal!)
**Expected:** Agent will send "No commits" message

### Issue: Permission denied
**Solution:** Make sure genie is globally installed:
```bash
npm install -g automagik-genie@latest
```

---

## Advanced: Multiple Schedules

Want different schedules? Add multiple lines:

```cron
# Daily at 9:05 AM
5 9 * * * cd /home/namastex/workspace/automagik-genie && genie task daily-standup "Generate 24h summary for dev branch" >> /tmp/genie-standup.log 2>&1

# Friday end-of-week summary at 5 PM
0 17 * * 5 cd /home/namastex/workspace/automagik-genie && genie task daily-standup "Generate weekly summary for dev branch" >> /tmp/genie-standup-weekly.log 2>&1
```

---

## Quick Reference

| Action | Command |
|--------|---------|
| Add cron job | `crontab -e` |
| List cron jobs | `crontab -l` |
| Remove all jobs | `crontab -r` |
| Check logs | `tail -f /tmp/genie-standup.log` |
| Test manually | `genie task daily-standup "..."` |
| Check cron service | `service cron status` |
| Restart cron | `sudo service cron restart` |

---

## Next Steps

1. ✅ Test agent manually first
2. ✅ Verify WhatsApp message arrives in Namastexers group
3. ✅ Add to crontab
4. ✅ Wait until tomorrow 9:05 AM to confirm
5. ✅ Check logs: `tail /tmp/genie-standup.log`

---

**Pro Tip:** Run a manual test first before adding to crontab. This ensures the agent works correctly before automating it!
