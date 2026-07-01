import { sql, getTableColumns } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import { db } from "../db.js";

/**
 * Google Sheets rows can contain duplicate keys (e.g. someone re-submitted
 * a row by hand). Postgres rejects an ON CONFLICT DO UPDATE that would
 * touch the same row twice in one statement, so keep only the last
 * occurrence of each key within a batch (sheets are read top-to-bottom,
 * so "last" is the most recently edited row).
 */
function dedupeByKey<T extends Record<string, any>>(rows: T[], keyFields: string[]): T[] {
  const byKey = new Map<string, T>();
  for (const row of rows) {
    const key = keyFields.map((f) => String(row[f])).join("|");
    byKey.set(key, row);
  }
  return [...byKey.values()];
}

/**
 * Generic batch upsert: insert rows, on conflict overwrite with the incoming values.
 * `updateColumns` are the TS field names as defined in the schema (e.g. "foremanTgId"),
 * NOT the underlying snake_case DB column names — Drizzle's `set` keys must match the
 * schema's field names, it resolves the real column internally.
 */
export async function upsertBatch<T extends Record<string, any>>(
  table: PgTable,
  rows: T[],
  conflictColumn: any,
  updateColumns: string[],
) {
  if (!rows.length) return;

  const columns = getTableColumns(table) as Record<string, { name: string }>;
  const conflictCols = Array.isArray(conflictColumn) ? conflictColumn : [conflictColumn];
  const keyFields = conflictCols.map((col) => {
    const entry = Object.entries(columns).find(([, c]) => c === col);
    if (!entry) throw new Error("Could not resolve conflict column to a table field");
    return entry[0];
  });

  const deduped = dedupeByKey(rows, keyFields);

  const set: Record<string, any> = {};
  for (const field of updateColumns) {
    const dbColumn = columns[field]?.name;
    if (!dbColumn) throw new Error(`Unknown field "${field}" on table for upsert set-clause`);
    set[field] = sql.raw(`excluded."${dbColumn}"`);
  }

  // Batch in chunks to keep single statements reasonably sized.
  const CHUNK = 500;
  for (let i = 0; i < deduped.length; i += CHUNK) {
    const chunk = deduped.slice(i, i + CHUNK);
    await db
      .insert(table)
      .values(chunk as any)
      .onConflictDoUpdate({ target: conflictColumn, set });
  }
}
