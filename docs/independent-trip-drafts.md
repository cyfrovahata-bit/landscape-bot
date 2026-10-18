# Independent server working records

Baseline: 885b650eff23c1295818fa75566e2cab0bc0b221.

## Storage and compatibility

`trip_drafts` holds independent UUID trips and named `report:<owner>:<date>:<seq>` report editors.
Each record has its own revision, owner and open/archive state. `trip_draft_history` retains
accepted, rejected, imported, submitted and admin-restored versions. No trip data is written
to browser storage. An open React editor is transient until the server acknowledges the write.
A network error blocks further editing and allows a retry. This does not provide offline use.

On startup, `/adopt` takes the old per-owner advisory lock, copies legacy `day_drafts` and its
parked trip separately, and leaves their original rows/history untouched. Already-submitted
snapshots are archived when supported by a newer matching RTS_SAVE. Local legacy storage is
read once only for migration: separate content-hashed import records are uploaded before
removing the unchanged original browser value. Imports never replace server working records.
Older open tabs are refused singleton writes after adoption; rejected contents remain in the
legacy history. The user must reopen the Mini App, not erase the browser cache.

Submitted RTS_SAVE entries retain their existing date/foreman/tripSeq identity and payroll
math. New submissions also carry `draftId`; archiving that draft and the RTS_SAVE commit in
the same existing database transaction. Duplicate network retries retain the same tripSeq.
Working copies of old reports use separate IDs rather than borrowing the active trip's slot.

One brigadier's reservation context remains associated with one working trip at a time,
matching the former single-builder constraint. Independent drafts do not grant duplicate
use of cars or people. A report submission clears only its own reservation context.
The existing car/worker conflict checks, payroll calculations and Sheets exports remain.

## Administrator controls

Current trips -> Database records/history: paginated read, JSON export, audited restore of
an open record with expected revision. A restore does not update a submitted report, payroll
or Sheets; the owner must explicitly review and submit it. Current data remains in history.
Active reserved trips cannot be archived from the admin list. No raw SQL console, secret
view, or permanent delete endpoint is exposed in the Mini App.

## Validation and rollback

`npm run check`, `npm run build:miniapp`. Persistence integration tests start an actual HTTP
server and use PGlite's PostgreSQL engine, testing access checks, stale writes, archived
records, migration retention, restores, and pagination across 1100 records. PGlite tests do
not prove multi-process PostgreSQL advisory locking or full Telegram UI behavior.

A production pre-change pg_dump was created at
`$PGDATA/greenhand-recovery/before-independent-trips-20261018.dump` and its directory verified
using `pg_restore -l`. It shares the PostgreSQL volume; it is not an independent external backup.

Migration 0018 only adds tables. Do NOT drop these tables on rollback. Before returning to
baseline code after adoption, pause user writes and export every new record/history. Baseline
code sees the preserved legacy snapshot, not later independent changes; those must be
reviewed and explicitly recovered before resuming old clients. Never restore the full old
backup over newer payroll data merely to roll back application code.
