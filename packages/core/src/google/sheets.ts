import { getSheetsClient } from "./client.js";
import { config } from "../config.js";
import { norm, normalizeHeader, sheetRef, colToA1 } from "./utils.js";

// Thin, independent copy of the read/write helpers the bot already has
// (apps/bot/src/google/sheets/core.ts). Kept separate on purpose: the
// mini-app must never depend on apps/bot, so it doesn't break when the
// bot is eventually deleted.

export type LoadedSheet = {
  header: string[];
  map: Record<string, number>;
  data: any[][];
  all: any[][];
};

function getErrorStatus(err: any): number {
  return Number(
    err?.code ?? err?.status ?? err?.response?.status ?? err?.response?.statusCode ?? 0,
  );
}

function isTransientSheetsError(err: any) {
  const status = getErrorStatus(err);
  return status === 429 || (status >= 500 && status < 600);
}

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withSheetsRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const delays = [0, 500, 1500, 3000];
  for (let i = 0; i < delays.length; i++) {
    if (delays[i] > 0) await sleep(delays[i]);
    try {
      return await fn();
    } catch (err: any) {
      const canRetry = isTransientSheetsError(err) && i < delays.length - 1;
      if (canRetry) {
        console.warn(`[SHEETS][RETRY] ${label} attempt=${i + 1}`);
        continue;
      }
      throw err;
    }
  }
  return fn();
}

export function getCell(row: any[], map: Record<string, number>, header: string) {
  const idx = map[norm(header)];
  if (idx === undefined) return "";
  return String(row[idx] ?? "").trim();
}

export function buildRowByHeaders(headers: string[], map: Record<string, number>, patch: Record<string, any>) {
  const row = new Array(headers.length).fill("");
  for (const [hRaw, v] of Object.entries(patch)) {
    const idx = map[norm(hRaw)];
    if (idx === undefined) continue;
    row[idx] = v ?? "";
  }
  return row;
}

/** Creates the tab with a header row if it doesn't exist yet -- lets a writer
 * target a brand-new report tab (e.g. an accounting export) without a manual
 * setup step in the spreadsheet first. */
/**
 * Whether a tab exists, WITHOUT creating it. ensureSheet would happily bring
 * a deliberately deleted tab back to life, which is the opposite of what a
 * one-time "read it if it is still there" migration wants.
 */
export async function sheetExists(sheetName: string): Promise<boolean> {
  const sheets = getSheetsClient();
  const meta = await withSheetsRetry("spreadsheet metadata", () =>
    sheets.spreadsheets.get({ spreadsheetId: config.sheetId, fields: "sheets.properties.title" }),
  );
  return (meta.data.sheets ?? []).some((s) => s.properties?.title === sheetName);
}

export async function ensureSheet(sheetName: string, headers: readonly string[]) {
  const sheets = getSheetsClient();

  const meta = await withSheetsRetry("spreadsheet metadata", () =>
    sheets.spreadsheets.get({ spreadsheetId: config.sheetId, fields: "sheets.properties.title" }),
  );
  const exists = (meta.data.sheets ?? []).some((s) => s.properties?.title === sheetName);
  if (exists) return;

  await withSheetsRetry(`${sheetName} create`, () =>
    sheets.spreadsheets.batchUpdate({
      spreadsheetId: config.sheetId,
      requestBody: { requests: [{ addSheet: { properties: { title: sheetName } } }] },
    }),
  );

  const lastCol = colToA1(headers.length - 1);
  await withSheetsRetry(`${sheetName}!A1:${lastCol}1 update`, () =>
    sheets.spreadsheets.values.update({
      spreadsheetId: config.sheetId,
      range: `${sheetRef(sheetName)}!A1:${lastCol}1`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [[...headers]] },
    }),
  );
}

export async function loadSheet(sheetName: string, range = "A:Z"): Promise<LoadedSheet> {
  const sheets = getSheetsClient();

  const res = await withSheetsRetry(`${sheetName}!${range}`, () =>
    sheets.spreadsheets.values.get({
      spreadsheetId: config.sheetId,
      range: `${sheetRef(sheetName)}!${range}`,
    }),
  );

  const rows = res.data.values || [];
  if (rows.length === 0) {
    return { header: [], map: {}, data: [], all: rows };
  }

  const header = (rows[0] || []).map(normalizeHeader);
  const map: Record<string, number> = {};
  header.forEach((h: string, i: number) => {
    const key = norm(h);
    if (key) map[key] = i;
  });

  const data = rows.slice(1).filter((r) => r && r.some((c) => String(c ?? "").trim() !== ""));

  return { header, map, data, all: rows };
}

/**
 * Physically removes every row the predicate accepts.
 *
 * The sync worker only ever upserts, so a row deleted from Postgres alone is
 * back within a sync cycle -- anything meant to disappear has to go from the
 * sheet as well, and the sheet is the source of truth besides.
 *
 * Rows are deleted bottom-up so earlier deletions don't shift the indices of
 * later ones, and consecutive rows are collapsed into one range request.
 * Returns how many rows went.
 */
export async function deleteRowsWhere(
  sheetName: string,
  match: (row: any[], map: Record<string, number>) => boolean,
): Promise<number> {
  const sheets = getSheetsClient();
  const { map, all } = await loadSheet(sheetName);
  if (all.length < 2) return 0;

  // all[0] is the header, so all[i] sits on 1-based sheet row i + 1, which is
  // the 0-based index i in the API's half-open dimension ranges.
  const doomed: number[] = [];
  for (let i = 1; i < all.length; i++) {
    const row = all[i] ?? [];
    if (row.some((c: any) => String(c ?? "").trim() !== "") && match(row, map)) doomed.push(i);
  }
  if (!doomed.length) return 0;

  const meta = await withSheetsRetry("spreadsheet metadata", () =>
    sheets.spreadsheets.get({ spreadsheetId: config.sheetId, fields: "sheets.properties(sheetId,title)" }),
  );
  const sheetId = (meta.data.sheets ?? []).find((s) => s.properties?.title === sheetName)?.properties?.sheetId;
  if (sheetId === undefined || sheetId === null) return 0;

  const ranges: { start: number; end: number }[] = [];
  for (const i of doomed) {
    const last = ranges[ranges.length - 1];
    if (last && last.end === i) last.end = i + 1;
    else ranges.push({ start: i, end: i + 1 });
  }

  await withSheetsRetry(`${sheetName} delete ${doomed.length} rows`, () =>
    sheets.spreadsheets.batchUpdate({
      spreadsheetId: config.sheetId,
      requestBody: {
        requests: ranges
          .slice()
          .reverse()
          .map((r) => ({
            deleteDimension: { range: { sheetId, dimension: "ROWS", startIndex: r.start, endIndex: r.end } },
          })),
      },
    }),
  );
  return doomed.length;
}

/**
 * Removes every data row from a sheet, keeping the header.
 *
 * For wiping a test run: the tabs the PROGRAM writes (the event journal, the
 * timesheet, the accounting export) rather than the dictionaries a human
 * maintains. A missing tab is not an error -- it is already as empty as it can
 * be. Returns how many rows went.
 */
export async function clearSheetData(sheetName: string): Promise<number> {
  const sheets = getSheetsClient();
  const meta = await withSheetsRetry("spreadsheet metadata", () =>
    sheets.spreadsheets.get({ spreadsheetId: config.sheetId, fields: "sheets.properties(sheetId,title)" }),
  );
  const sheetId = (meta.data.sheets ?? []).find((s) => s.properties?.title === sheetName)?.properties?.sheetId;
  if (sheetId === undefined || sheetId === null) return 0;

  const { all } = await loadSheet(sheetName);
  if (all.length < 2) return 0;

  await withSheetsRetry(`${sheetName} clear ${all.length - 1} rows`, () =>
    sheets.spreadsheets.batchUpdate({
      spreadsheetId: config.sheetId,
      requestBody: {
        // One half-open range from just under the header to the last row.
        requests: [{ deleteDimension: { range: { sheetId, dimension: "ROWS", startIndex: 1, endIndex: all.length } } }],
      },
    }),
  );
  return all.length - 1;
}

/** Append rows built from a patch object keyed by header name, respecting the sheet's real column order. */
export async function appendRowsByHeaders(sheetName: string, patches: Record<string, any>[]) {
  if (!patches.length) return;
  const { header, map } = await loadSheet(sheetName, "1:1");
  const rows = patches.map((patch) => buildRowByHeaders(header, map, patch));
  await appendRows(sheetName, rows);
}

export async function appendRows(sheetName: string, rows: any[][]) {
  if (!rows.length) return;
  const sheets = getSheetsClient();

  await withSheetsRetry(`${sheetName}!A:Z append`, () =>
    sheets.spreadsheets.values.append({
      spreadsheetId: config.sheetId,
      range: `${sheetRef(sheetName)}!A:Z`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: rows },
    }),
  );
}

export async function updateRow(sheetName: string, rowNumber1Based: number, values: any[]) {
  const sheets = getSheetsClient();
  const endCol = colToA1(values.length - 1);
  const range = `${sheetRef(sheetName)}!A${rowNumber1Based}:${endCol}${rowNumber1Based}`;

  await withSheetsRetry(`${sheetName}!${range} update`, () =>
    sheets.spreadsheets.values.update({
      spreadsheetId: config.sheetId,
      range,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [values] },
    }),
  );
}

function rowMatchesKeys(row: any[], map: Record<string, number>, keys: Record<string, any>) {
  for (const [headerName, expected] of Object.entries(keys)) {
    const idx = map[norm(headerName)];
    if (idx === undefined) return false;
    if (String(row[idx] ?? "").trim() !== String(expected ?? "").trim()) return false;
  }
  return true;
}

/** Find a row by key columns and update it, or append a new one. Mirrors the bot's upsertRowByKeys. */
export async function upsertRowByKeys(sheetName: string, keys: Record<string, any>, patch: Record<string, any>) {
  const { header, map, all } = await loadSheet(sheetName);
  if (!header.length) throw new Error(`Sheet "${sheetName}" has no header row`);

  let foundIndex0Based = -1;
  for (let i = 1; i < all.length; i++) {
    const r = all[i];
    if (r && r.length && rowMatchesKeys(r, map, keys)) {
      foundIndex0Based = i;
      break;
    }
  }

  if (foundIndex0Based !== -1) {
    const existing = all[foundIndex0Based] || [];
    const full = new Array(header.length).fill("");
    for (let i = 0; i < header.length; i++) full[i] = existing[i] ?? "";
    for (const [h, v] of Object.entries(patch)) {
      const idx = map[norm(h)];
      if (idx === undefined) continue;
      full[idx] = v ?? "";
    }
    await updateRow(sheetName, foundIndex0Based + 1, full);
    return { action: "updated" as const, rowNumber: foundIndex0Based + 1 };
  }

  const merged = { ...keys, ...patch };
  const newRow = buildRowByHeaders(header, map, merged);
  await appendRows(sheetName, [newRow]);
  return { action: "appended" as const };
}

/**
 * Writes individual cells in one API call.
 *
 * `updateRow` rewrites a whole row, which is wrong for touching a single
 * column of a row a human is also editing: the round trip between reading
 * and writing is long enough for them to have changed another cell, and the
 * whole-row write would put the old value back. Here each cell is its own
 * range, so nothing but the named cells is touched.
 */
export async function updateCells(
  sheetName: string,
  cells: Array<{ row1Based: number; col0Based: number; value: any }>,
) {
  if (!cells.length) return;
  const sheets = getSheetsClient();

  await withSheetsRetry(`${sheetName} update ${cells.length} cells`, () =>
    sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: config.sheetId,
      requestBody: {
        valueInputOption: "USER_ENTERED",
        data: cells.map((c) => ({
          range: `${sheetRef(sheetName)}!${colToA1(c.col0Based)}${c.row1Based}`,
          values: [[c.value]],
        })),
      },
    }),
  );
}

/** Accounting numbers are native numeric values, never USER_ENTERED strings.
 * Ukrainian locale renders decimal commas; RAW prevents hours becoming dates. */
export async function appendAccountingValues(sheetName: string, rows: any[][]) {
  if (!rows.length) return;
  const sheets = getSheetsClient();
  const meta = await withSheetsRetry("accounting metadata", () =>
    sheets.spreadsheets.get({ spreadsheetId: config.sheetId, fields: "properties.locale,sheets.properties(sheetId,title)" }),
  );
  if (meta.data.properties?.locale !== "uk_UA") {
    throw new Error("Для десяткової коми встановіть локаль таблиці «Україна».");
  }
  const sheetId = meta.data.sheets?.find((s) => s.properties?.title === sheetName)?.properties?.sheetId;
  if (sheetId == null) throw new Error(`Не знайдено ${sheetName}`);
  // Format before appending: a failed format request cannot leave exported rows behind.
  await withSheetsRetry("accounting numeric formats", () =>
    sheets.spreadsheets.batchUpdate({
      spreadsheetId: config.sheetId,
      requestBody: { requests: [
        { column: 1, type: "DATE", pattern: "dd.mm.yyyy" },
        { column: 5, type: "NUMBER", pattern: "0.##" },
        { column: 7, type: "NUMBER", pattern: "#,##0.00" },
      ].map(({ column, type, pattern }) => ({ repeatCell: {
        range: { sheetId, startRowIndex: 1, startColumnIndex: column, endColumnIndex: column + 1 },
        cell: { userEnteredFormat: { numberFormat: { type, pattern } } },
        fields: "userEnteredFormat.numberFormat",
      } })) },
    }),
  );
  await withSheetsRetry(`${sheetName} accounting append`, () =>
    sheets.spreadsheets.values.append({
      spreadsheetId: config.sheetId,
      range: `${sheetRef(sheetName)}!A:I`,
      valueInputOption: "RAW",
      requestBody: { values: rows },
    }),
  );
}
