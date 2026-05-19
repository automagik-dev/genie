---
title: "Upgrading to pgserve v3 (autopg)"
description: "How existing and new users move onto autopg/pgserve v3. What is automatic, what is preserved, and the one manual step when you have data to carry."
---

# Upgrading to pgserve v3 (autopg)

`pgserve` v3 ships as **autopg** — a router-less, single-postmaster
distribution (the old daemon, accept-hook router, and SO_PEERCRED
fingerprint routing are gone). Genie now natively detects autopg v3 and
owns its own database on it. Everything below is verified end-to-end.

## What new genie does on the host it finds

| You currently run | New genie behavior | Action needed |
|---|---|---|
| **pgserve v1.x** (port 8432, no admin.json) | falls back to the legacy TCP/headless path; `_genie_migrations` and your data stay where they are | none — keep running, upgrade pgserve later when you choose |
| **pgserve v2.x** (admin.json + accept-hook router) | stays on `database = postgres`; the router routes you to your existing `app_genie_<fp>` DB; migrations are idempotent | none — your data is preserved |
| **autopg / pgserve v3** (writes `<socketDir>/runtime.json`) | auto-detects v3, auto-creates a dedicated `genie` database, runs migrations into it | none — first boot provisions everything |

Detection is **strictly** keyed on `<socketDir>/runtime.json` (the v3
marker). v1/v2 hosts are never retargeted, so an upgraded genie on an
old pgserve never moves your data and never blocks you.

The dedicated v3 database name is `genie`; override with
`GENIE_DB_NAME=<name>` if you need something different (e.g. multi-tenant
hosts). `GENIE_ROLE_CUTOVER=0` continues to work; native-DB provisioning
is decoupled from the role-cutover kill-switch.

## Moving data from old pgserve → autopg v3

This is the only step that isn't automatic. New genie on autopg v3
creates a **fresh empty `genie` DB**; your existing teams / agents /
tasks / sessions live in the *old* pgserve's `app_genie_<fp>` DB and
will not migrate themselves.

If you don't need the history, just install autopg v3 — you're done.

If you do, dump-then-restore around the upgrade:

```bash
# 1. On the old pgserve / old genie — snapshot to .genie/snapshot.sql.gz
genie db backup

# 2. Install autopg v3 (replaces pgserve)
curl -fsSL https://raw.githubusercontent.com/automagik-dev/autopg/main/install.sh | bash

# 3. On the new autopg v3 — let new genie provision its `genie` DB
genie db migrate    # creates + populates the v3 `genie` database

# 4. Restore your snapshot into the freshly-provisioned `genie` DB
genie db restore    # defaults to .genie/snapshot.sql.gz
```

The snapshot is portable across pgserve versions because `genie db
backup` is a logical (`pg_dump`) dump, not a physical replication of the
old data directory.

## Verifying after the upgrade

```bash
genie ls                                                # lists your agents
genie db status                                         # table counts, version
psql -h "$XDG_RUNTIME_DIR/pgserve" -U postgres -d genie # explore the new DB
```

## Rolling back

The old pgserve install (its data dir, admin.json, role state) is
untouched by autopg v3's installer. If you decide to roll back, point
genie's environment at the old socket / port again and `genie db
restore` from your snapshot into the old `app_genie_<fp>` DB. The
embedded-migrations change in new genie is forward-compatible: it does
not modify migrations that have already been applied.
