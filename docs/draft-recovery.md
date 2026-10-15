# Draft persistence and recovery (2026-10-15)

Scope: draft persistence only. Payroll, submitted events, accounting exports,
reservations, route rules and existing UI flows are not changed.

## Storage

- `day_drafts` remains the current mirror, one slot per foreman, for compatibility.
- `draft_heads` retains a monotonic revision even when the slot is cleared.
- `draft_history` is append-only. `snapshot` contains the complete serialized
  draft row (camelCase property names for application-created records; snake_case
  for the initial SQL migration backup). Its `payload` is the original JSON text.
- Migration 0017 copies every existing row into history before accepting writes.
- Every changed accepted snapshot and the preceding row are archived atomically.
  Rejected incoming snapshots and pre-clear rows are also retained.
- Per-foreman transaction locks serialize writes and clears. No other foreman's
  slot is locked or modified. Identical retries do not create another revision.
- New clients send `baseRevision` and serialize PUT/DELETE. A conflict stops
  mirroring and displays a warning; the phone's local draft is retained.
- Legacy clients still work. Once a slot is managed by a version-aware client,
  a legacy client cannot overwrite/clear it; its rejected PUT is archived.
  Legacy clients have no UI conflict handling, so reopen the Mini App to upgrade.
- Empty snapshots cannot overwrite nonempty snapshots, including parked days.
- Restoring snapshots and clearing drafts never automatically sends a report.

## Inspect / recover (programmer only)

First stop edits on the affected phone. Inspect only the selected foreman:

```sql
SELECT id, revision, action, created_at
FROM draft_history WHERE foreman_tg_id = :foreman
ORDER BY id DESC;
SELECT snapshot FROM draft_history
WHERE foreman_tg_id = :foreman AND id = :history_id;
```

Parse the selected snapshot, then its `payload`. Check `date`, `editingTripSeq`,
`tripStartedAt`, each person's sessions, `onboard`, `here`, `carAtObjectId`, work
volumes, and a possible `dayStash`. Keep open sessions open only if work really
continues. Distinguish a submitted-trip editor from a new unsent trip to avoid
creating a duplicate. Do not copy payroll figures or resubmit an existing report.

Restore in ONE transaction using the SAME advisory key as the application:
`SELECT pg_advisory_xact_lock(hashtext('draft:' || :foreman));`
Re-read current revision inside the lock, archive the current row with action
`manual_before_restore`, update ONLY `day_drafts WHERE foreman_tg_id=:foreman`,
and upsert/increment ONLY that foreman's `draft_heads` revision, managed=true.
Archive the restored row with action `manual_restore`. Abort on a changed
expected revision or unexpected row count. Never lower a revision.

The affected phone must reopen the app. Existing nonempty local drafts are
intentionally not silently replaced by server data: preserve them and resolve
any conflict before clearing local storage. An empty local draft offers the
existing server-restore confirmation. Don't tell users to clear cache first.

The previous state stays in history for reversal. A whole-database restore is
NOT appropriate for recovering one foreman's trip.

## Rollback

Code baseline: 79e62e346fa8348cd8773ff5a4b4315e69d2f3c1.
The two added tables may remain if code is rolled back; do not drop recovery
history. Do not restore the full pre-deploy dump over new production work.
A pre-deploy custom-format pg_dump is stored on the Postgres volume under
`$PGDATA/greenhand-recovery/before-draft-history-20261015.dump`.
This is a same-volume recovery copy, not an independent off-site backup.

## Checks

`npm run check` includes regression tests for blank/stale writes, parked days,
server recovery and PUT/DELETE ordering. `npm run build` verifies production
frontend compilation. Migration SQL is tested in an isolated schema inside a
rolled-back transaction using copies of existing draft rows.
