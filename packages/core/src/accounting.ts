import { ensureSheet, loadSheet, appendRows } from "./google/sheets.js";

// Same tab names/headers the legacy bot writes into (apps/bot/src/google/sheets/accounting.ts)
// so an approval from either the bot or the mini-app lands in the ONE report the
// accountant actually opens -- there must never be two separate "БУХЗВІТ"s.
const ACCOUNTING_SHEET = "БУХЗВІТ";
const ACCOUNTING_META_SHEET = "БУХЗВІТ_META";
const ACCOUNTING_HEADERS = ["№", "Дата", "Працівник", "Об'єкт", "Роботи", "Обсяг робіт", "Нарахування", "Примітки"] as const;
const ACCOUNTING_META_HEADERS = ["key", "createdAt", "rowsCount"] as const;

function money(n: number) {
  return Math.round(Number(n || 0) * 100) / 100;
}

export type AccountingWork = { workId: string; workName: string; volume?: string | number; employeeIds?: string[] };
export type AccountingObject = { objectId: string; objectName: string; works: AccountingWork[] };
export type AccountingSalaryRow = { employeeId: string; employeeName: string; pay: number };
export type AccountingSalaryPack = { objectId: string; objectName: string; rows: AccountingSalaryRow[] };
export type AccountingRow = {
  date: string;
  employeeName: string;
  objectName: string;
  workName: string;
  volume: string;
  amount: number;
  foremanName: string;
};

/**
 * Splits each employee's already-computed per-object pay (role/coefficient
 * aware -- see buildSalaryPacksWithRoles) across the specific works they're
 * tagged on at that object (WorkInput.employeeIds), weighted by each work's
 * own money value (volume * tariff). Falls back to splitting across every
 * work at the object if the employee isn't tagged on any specific one, so
 * nobody's pay silently disappears from the report. The last work-row for
 * each employee absorbs whatever rounding leaves over, so a person's rows
 * always sum to EXACTLY the pay figure they're shown in the app -- a
 * bookkeeping report that doesn't tie out to the kopeck isn't fit to hand
 * to an accountant.
 */
export function buildAccountingRows(params: {
  date: string;
  // Whoever submitted/filled this report -- written into the "Примітки"
  // column so the accountant knows which brigadier's numbers each row is.
  foremanName: string;
  objects: AccountingObject[];
  salaryPacks: AccountingSalaryPack[];
  roadAllowancePerPerson: number;
  unionEmployeeIds: string[];
  employeeNameById: Map<string, string>;
  tariffByWorkId: Map<string, number>;
  unitByWorkId: Map<string, string>;
}): AccountingRow[] {
  const { date, foremanName, objects, salaryPacks, roadAllowancePerPerson, unionEmployeeIds, employeeNameById, tariffByWorkId, unitByWorkId } = params;
  const objectsById = new Map(objects.map((o) => [o.objectId, o]));
  const out: AccountingRow[] = [];

  const workValue = (w: AccountingWork) => {
    const vol = Number(w.volume);
    const tariff = tariffByWorkId.get(w.workId) ?? 0;
    return (Number.isFinite(vol) ? vol : 0) * tariff;
  };
  const formatVolume = (w: AccountingWork) => {
    const vol = Number(w.volume);
    const unit = unitByWorkId.get(w.workId) ?? "";
    return [Number.isFinite(vol) ? vol : w.volume, unit].filter((x) => x !== undefined && x !== "").join(" ");
  };

  for (const pack of salaryPacks) {
    const obj = objectsById.get(pack.objectId);
    const works = obj?.works ?? [];
    if (!works.length) continue;

    for (const row of pack.rows) {
      if (!(row.pay > 0)) continue;

      const tagged = works.filter((w) => (w.employeeIds ?? []).includes(row.employeeId));
      const pool = tagged.length ? tagged : works;
      const values = pool.map(workValue);
      const totalValue = values.reduce((a, v) => a + v, 0);

      let remaining = row.pay;
      pool.forEach((w, i) => {
        const isLast = i === pool.length - 1;
        const share = totalValue > 0 ? values[i] / totalValue : 1 / pool.length;
        const amount = isLast ? money(remaining) : money(row.pay * share);
        remaining = money(remaining - amount);
        if (amount <= 0) return;
        out.push({
          date,
          employeeName: row.employeeName,
          objectName: pack.objectName,
          workName: w.workName,
          volume: formatVolume(w),
          amount,
          foremanName,
        });
      });
    }
  }

  if (roadAllowancePerPerson > 0) {
    for (const empId of unionEmployeeIds) {
      out.push({
        date,
        employeeName: employeeNameById.get(empId) ?? empId,
        objectName: "—",
        workName: "Доплата за виїзд",
        volume: "",
        amount: money(roadAllowancePerPerson),
        foremanName,
      });
    }
  }

  return out;
}

async function loadAccountingSheet() {
  await ensureSheet(ACCOUNTING_SHEET, ACCOUNTING_HEADERS);
  return loadSheet(ACCOUNTING_SHEET, "A:H");
}

async function loadAccountingMetaSheet() {
  await ensureSheet(ACCOUNTING_META_SHEET, ACCOUNTING_META_HEADERS);
  return loadSheet(ACCOUNTING_META_SHEET, "A:C");
}

async function hasAccountingRowsForKey(key: string) {
  const sh = await loadAccountingMetaSheet();
  return sh.data.some((row) => String(row?.[0] ?? "").trim() === key);
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
  await loadAccountingMetaSheet();
  await appendRows(ACCOUNTING_META_SHEET, [[key, new Date().toISOString(), rows.length]]);
  return { skipped: false, rows: rows.length };
}
