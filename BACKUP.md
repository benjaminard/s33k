# s33k data durability: backup and restore

This is the single source of truth for backing up and restoring s33k's data. s33k is a single-user,
self-hosted tool: everything it holds (your keywords and rank history, your first-party analytics
events, your domains and settings) lives in ONE database, so one backup covers everything. There is
no separate analytics store to back up.

s33k runs on ONE of two databases, depending on how you deployed it:

- **Postgres** when `DATABASE_URL` is set (the docker-compose stack ships a Postgres alongside the app).
- **SQLite** otherwise, a single file on disk (`DATABASE_PATH`, default `data/database.sqlite`).

Back up whichever one you run. `DEPLOY.md` points here; do not duplicate this runbook elsewhere.

> What this is NOT: `GET /api/export` is a logical export of your own data as one JSON bundle. It is a
> data-portability feature ("take your data with you"), not a system backup: it does not cover instance
> settings and is not a restorable database image. See section 4.

---

## 1. If you run Postgres (docker compose stack)

Two layers protect the data. Use whichever fits your host; both is best.

### Automated snapshots (if your host offers them)

Many hosts and managed-Postgres providers can snapshot the database on a schedule. Turn this on if it
is available, pick a **daily** cadence, and **retain at least 7 days** (14 to 30 is better once the
data matters, since a problem is often noticed days after it happened). Confirm at least one successful
snapshot exists before relying on it: a backup setting with zero completed snapshots is not a backup.

### Manual logical backup with `pg_dump` (a copy you control)

A logical dump is a portable SQL file you can store off the host (a private bucket, an encrypted disk).
It is the copy that survives the whole host being lost.

Set the connection string from your deployment (for the docker-compose stack it is the `DATABASE_URL`
you configured). Export it locally; do NOT commit it or paste the literal host into any script:

```bash
export DATABASE_URL="postgres://...your s33k Postgres connection string..."
```

Back up:

```bash
# Plain SQL dump (human-readable, easy to inspect). Date-stamped so backups never overwrite.
pg_dump "$DATABASE_URL" > s33k-$(date +%Y%m%d).sql

# Or the custom/compressed format (smaller, supports selective + parallel restore with pg_restore).
pg_dump --format=custom "$DATABASE_URL" > s33k-$(date +%Y%m%d).dump
```

Keep the resulting file somewhere off the host and access-controlled. It contains all of your data, so
treat it like the production database itself.

Restore into a database, ideally a fresh/scratch one first (section 3), then promote only after
verifying. `$RESTORE_URL` is the target you are restoring INTO.

```bash
# From a plain .sql dump:
psql "$RESTORE_URL" < s33k-YYYYMMDD.sql

# From a custom-format .dump (use pg_restore). --clean drops existing objects first;
# --no-owner avoids role-ownership mismatches between environments.
pg_restore --clean --no-owner --dbname "$RESTORE_URL" s33k-YYYYMMDD.dump
```

On a fresh empty target you can drop `--clean` (there is nothing to drop). On boot, s33k runs its
migrations (`entrypoint.sh`), and they swallow only already-applied (idempotency) errors, so an
up-to-date restored schema is left alone.

---

## 2. If you run SQLite (single file)

The whole database is one file, so a backup is a copy of that file. Find it via `DATABASE_PATH`
(default `data/database.sqlite`).

Back up. Stop the app first, or use the SQLite backup command so you copy a consistent file rather than
one mid-write:

```bash
# Simplest: stop s33k, then copy the file. Date-stamped so backups never overwrite.
cp data/database.sqlite s33k-$(date +%Y%m%d).sqlite

# Or a consistent online backup without stopping the app:
sqlite3 data/database.sqlite ".backup 's33k-$(date +%Y%m%d).sqlite'"
```

Keep the copy off the machine and access-controlled.

Restore. Stop the app, put the backup file back in place, then start s33k:

```bash
cp s33k-YYYYMMDD.sqlite data/database.sqlite
```

On boot, s33k runs its migrations and leaves an up-to-date schema alone (section 1 restore note).

---

## 3. Restore-drill checklist (rehearse before you need it)

A backup you have never restored is a hope, not a backup. Run this drill periodically and after any
schema migration.

1. **Provision a scratch target.** For Postgres, a throwaway database or a local
   `createdb s33k_restore_test` (set `RESTORE_URL` to it). For SQLite, just restore the copy to a
   scratch path. Never drill against your live data.
2. **Restore** the latest backup into the scratch target (the section 1 or 2 restore commands).
3. **Verify the core tables exist and carry rows.** Connect (`psql "$RESTORE_URL"`, or
   `sqlite3 s33k-YYYYMMDD.sqlite`) and run:

   ```sql
   SELECT count(*) FROM domain;
   SELECT count(*) FROM keyword;
   ```

   Compare each count against your live database (run the same `SELECT`s there, read-only). The numbers
   should match the backup's point in time. A zero where the live DB has rows means the restore did not
   land that table; stop and investigate before trusting the backup.
4. **Spot-check a row.** `SELECT domain FROM domain LIMIT 5;` and confirm a known domain (e.g. your own)
   is present.
5. **Tear down the scratch target** so it does not linger or get mistaken for the real one.

If any step fails, the backup is not usable; fix the backup process before you depend on it.

---

## 4. What is in the database (so you know what a backup protects)

One backup of the single s33k database covers everything:

- `domain`, `keyword` (with full rank history), `setting` (the one global instance-settings row).
- First-party analytics events (the `s33k_event` autocapture rows the beacon writes) and related rows.
- Any connected-service credentials, stored cryptr-encrypted.

There is no separate analytics store. Because analytics is first-party (the beacon writes straight into
this same database), backing up this one database preserves your traffic history too.

---

## 5. Why `GET /api/export` is NOT a backup

`GET /api/export` returns your OWN data (your domains, keywords with rank history, first-party events,
and account/key metadata) as one JSON bundle. It is a data-portability and trust feature ("you can take
your data with you").

It is NOT a system backup because:

- It is JSON shaped for portability, not a restorable database image.
- It does not cover instance settings.
- There is no import counterpart that rebuilds the database from it.

Use it for "give me my data". Use sections 1 through 3 for "protect the instance".
