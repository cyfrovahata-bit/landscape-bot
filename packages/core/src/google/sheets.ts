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
