import { ensureSheet, loadSheet, appendRows, sheetExists } from "./google/sheets.js";
import { eq, sql } from "drizzle-orm";
import { db, schema } from "./db.js";

// Same tab names/headers the legacy bot writes into (apps/bot/src/google/sheets/accounting.ts)
// so an approval from either the bot or the mini-app lands in the ONE report the
// accountant actually opens -- there must never be two separate "БУХЗВІТ"s.
export const ACCOUNTING_SHEET = "БУХЗВІТ";
/**
 * The idempotency keys moved to Postgres (schema.accountingExports) -- they
 * were never anything a human opened, and a technical tab sitting next to the
 * accountant's report only invited someone to delete it. The name stays for
 * the one-time import below and so maintenance can still clear a leftover tab.
 */
export const ACCOUNTING_META_SHEET = "БУХЗВІТ_META";
// Форма рядків звіту живе в accountingRows.ts -- без Google і без БД, щоб її
// можна було покрити тестами. Тут лишається тільки запис в аркуш.
export {
  ACCOUNTING_HEADERS,
  buildAccountingRows,
  formatRoadKm,
  splitMoneyByShares,
  money,
  type AccountingWork,
  type AccountingObject,
  type AccountingSalaryRow,
  type AccountingSalaryPack,
  type AccountingRow,
} from "./accountingRows.js";
import { ACCOUNTING_HEADERS, type AccountingRow } from "./accountingRows.js";

async function loadAccountingSheet() {
  await ensureSheet(ACCOUNTING_SHEET, ACCOUNTING_HEADERS);
  return loadSheet(ACCOUNTING_SHEET, "A:H");
}

async function hasAccountingRowsForKey(key: string) {
  const [row] = await db.select().from(schema.accountingExports).where(eq(schema.accountingExports.key, key)).limit(1);
  return !!row;
}

/**
 * One-time carry-over of the keys that are still sitting in the old
 * БУХЗВІТ_META tab. Runs at startup and stops for good once the table has
 * anything in it, so it costs one metadata call on an empty database and
 * nothing afterwards.
 *
 * Deliberately checks whether the tab EXISTS instead of ensuring it: once the
 * owner deletes it there is nothing to import, and recreating it to read zero
 * rows would undo exactly what this change is for.
 */
export async function importAccountingKeysFromSheet(): Promise<{ imported: number }> {
  const [{ count } = { count: 0 }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(schema.accountingExports);
  if (Number(count) > 0) return { imported: 0 };

  if (!(await sheetExists(ACCOUNTING_META_SHEET))) return { imported: 0 };

  const sh = await loadSheet(ACCOUNTING_META_SHEET, "A:C");
  const rows = sh.data
    .map((row) => ({
      key: String(row?.[0] ?? "").trim(),
      createdAt: String(row?.[1] ?? "").trim(),
      rowsCount: Number(row?.[2] ?? 0),
    }))
    .filter((r) => r.key)
    .map((r) => {
      // MINIAPP|<date>|<foremanTgId>|<eventIds>
      const parts = r.key.split("|");
      const parsed = new Date(r.createdAt);
      let foremanTgId: bigint | null = null;
      try {
        if (parts[2]) foremanTgId = BigInt(parts[2]);
      } catch {
        // a key from the legacy bot has its own shape -- the key itself is
        // what matters, the columns beside it are only for human eyes
      }
      return {
        key: r.key,
        date: parts[1] ?? "",
        foremanTgId,
        rowsCount: Number.isFinite(r.rowsCount) ? r.rowsCount : 0,
        createdAt: Number.isNaN(parsed.getTime()) ? new Date() : parsed,
      };
    });
  if (!rows.length) return { imported: 0 };

  await db.insert(schema.accountingExports).values(rows).onConflictDoNothing();
  console.log(`[accounting] imported ${rows.length} export key(s) from ${ACCOUNTING_META_SHEET}`);
  return { imported: rows.length };
}

async function appendAccountingReportRows(rows: AccountingRow[]) {
  if (!rows.length) return;
  const sh = await loadAccountingSheet();
  const hasHeader = String(sh.all?.[0]?.[0] ?? "").trim() === ACCOUNTING_HEADERS[0];
  const existingDataRows = hasHeader ? Math.max(0, sh.all.length - 1) : sh.all.length;
  let nextNo = existingDataRows + 1;

  await appendRows(
    ACCOUNTING_SHEET,
    rows.map((row) => [nextNo++, row.date, row.employeeName, row.objectName, row.workName, row.volume, row.amount, row.foremanName]),
  );
}

/**
 * Writes one day's approved payroll into the shared БУХЗВІТ report -- called
 * once a foreman's whole day is approved via the mini-app's "Затвердження"
 * screen (mirrors what the legacy bot does on its own approval flow, since
 * that only fires for reports approved through the bot, never through the
 * mini-app).
 *
 * `key` must uniquely identify THIS state of the day's submission, not just
 * the date+foreman -- a day can be approved, returned for correction,
 * resubmitted, then approved again, and the corrected numbers must reach the
 * accountant, not get silently skipped as "already exported". The caller
 * should fold in something that changes across a resubmission (e.g. the
 * trip events' own eventIds), the same way the bot's own export keys off the
 * approved event's eventId rather than off date+foreman alone.
 */
export async function writeAccountingReportForDay(params: { key: string; rows: AccountingRow[] }) {
  const { key, rows } = params;
  if (await hasAccountingRowsForKey(key)) {
    return { skipped: true, rows: 0 };
  }
  if (!rows.length) {
    return { skipped: false, rows: 0 };
  }

  await appendAccountingReportRows(rows);
  // Only after the rows are actually in the sheet: a key written first would
  // mark a failed export as done and the day would never reach the accountant.
  await db
    .insert(schema.accountingExports)
    .values({
      key,
      date: key.split("|")[1] ?? "",
      foremanTgId: (() => {
        try {
          return BigInt(key.split("|")[2] ?? "");
        } catch {
          return null;
        }
      })(),
      rowsCount: rows.length,
      createdAt: new Date(),
    })
    .onConflictDoNothing();
  return { skipped: false, rows: rows.length };
}
