# Task: Fix Global Install

**Date:** 2026-02-03
**Context:** genie-cli install.sh does not install globally properly
**Priority:** High

---

## Problem

The `install.sh` script is NOT installing genie-cli globally. When users run:

```bash
curl -fsSL https://raw.githubusercontent.com/namastexlabs/genie-cli/main/install.sh | bash
```

The commands `claudio`, `term`, `genie` are NOT available globally after installation.

---

## Investigation Steps

1. Check how npm/bun global install is being called
2. Verify the package.json `bin` field is correct
3. Check if the global bin path is in PATH
4. Test the install process end-to-end

---

## Key Files

- `install.sh` - Main installer script (lines 480-490)
- `package.json` - Check `bin` field for global commands
- Check the actual npm global bin location

---

## Acceptance Criteria

- [ ] After running install.sh, `claudio --version` works
- [ ] After running install.sh, `term --version` works
- [ ] After running install.sh, `genie --version` works
- [ ] Global install works with both npm and bun
- [ ] PATH is correctly set or user is instructed to update it

---

## Also

When fixing, make sure `--dangerously-skip-permissions` is used when launching claude for workflows that need it.

---

## Commands to Test

```bash
# Fresh install test
npm uninstall -g @automagik/genie
./install.sh
which claudio
which term
claudio --version
```
