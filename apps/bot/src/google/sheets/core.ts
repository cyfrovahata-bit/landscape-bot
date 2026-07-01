import { getSheetsClient } from "../client.js";
import { config } from "../../config.js";
import { norm, normalizeHeader, sheetRef, colToA1 } from "./utils.js";
import type { HeaderName } from "./headers.js";

export function resolveHeaderIndex(map: Record<string, number>, header: HeaderName): number | undefined {
  const variants = Array.isArray(header) ? header : [header];
  for (const v of variants) {
    const key = norm(v);
    if (key in map) return map[key];
  }
  return undefined;
}

export function requireHeaders(map: Record<string, number>, required: HeaderName[], sheetName: string) {
  const missing: string[] = [];

  for (const r of required) {
    const idx = resolveHeaderIndex(map, r);
    if (idx === undefined) {
      missing.push(Array.isArray(r) ? r.join(" | ") : r);
    }
  }

  if (missing.length) {
    throw new Error(`❌ У вкладці "${sheetName}" не знайдено колонки: ${missing.join(", ")}`);
  }
}

export function getCell(row: any[], map: Record<string, number>, headerName: HeaderName) {
  const idx = resolveHeaderIndex(map, headerName);
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

const headerCache = new Map<
  string,
  { headers: string[]; map: Record<string, number> }
>();

type LoadedSheet = {
  header: string[];
  map: Record<string, number>;
  data: any[][];
  all: any[][];
};

const READ_CACHE_DEFAULT_TTL_MS = 25_000;
const READ_CACHE_EVENTS_TTL_MS = 20_000;
const readCache = new Map<string, { ts: number; value: LoadedSheet }>();
const pendingReads = new Map<string, Promise<LoadedSheet>>();

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getErrorStatus(err: any): number {
  return Number(
    err?.code ??
      err?.status ??
      err?.response?.status ??
      err?.response?.statusCode ??
      err?.response?.body?.error?.code ??
      0,
  );
}

export function isTransientSheetsError(err: any) {
  const status = getErrorStatus(err);
  return status === 429 || (status >= 500 && status < 600);
}

export function isSheetsQuotaError(err: any) {
  const status = getErrorStatus(err);
  const text = [
    err?.message,
    err?.response?.body?.error?.message,
    err?.response?.body?.error_description,
    err?.response?.body?.description,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  return status === 429 || text.includes("quota exceeded") || text.includes("readrequestsperminute");
}

export async function withSheetsRetry<T>(
  op: "READ" | "WRITE",
  label: string,
  fn: () => Promise<T>,
): Promise<T> {
  const delays = [0, 500, 1500, 3000];

  for (let i = 0; i < delays.length; i++) {
    if (delays[i] > 0) await sleep(delays[i]);

    try {
      if (op === "READ") console.log(`[SHEETS][READ] ${label}`);
      return await fn();
    } catch (err: any) {
      const status = getErrorStatus(err);
      if (isSheetsQuotaError(err)) {
        console.warn(`[SHEETS][QUOTA] ${label} status=${status || "unknown"}`);
      }

      const attempt = i + 1;
      const canRetry = isTransientSheetsError(err) && i < delays.length - 1;
      if (canRetry) {
        console.warn(`[SHEETS][RETRY] attempt=${attempt} status=${status || "unknown"} ${label}`);
        continue;
      }

      throw err;
    }
  }

  return fn();
}

function readCacheKey(sheetName: string, range: string) {
  return `${sheetName}!${range}`;
}

function ttlForSheet(sheetName: string) {
  return sheetName === "ЖУРНАЛ_ПОДІЙ" ? READ_CACHE_EVENTS_TTL_MS : READ_CACHE_DEFAULT_TTL_MS;
}

export function invalidateSheetCache(sheetName?: string) {
  if (!sheetName) {
    readCache.clear();
    pendingReads.clear();
    return;
  }

  for (const key of [...readCache.keys()]) {
    if (key.startsWith(`${sheetName}!`)) readCache.delete(key);
  }
  for (const key of [...pendingReads.keys()]) {
    if (key.startsWith(`${sheetName}!`)) pendingReads.delete(key);
  }
}

export async function getHeaderMap(sheetName: string) {
  const cached = headerCache.get(sheetName);

  if (cached) {
    return cached;
  }

  const sheets = getSheetsClient();

  const head = await withSheetsRetry("READ", `${sheetName}!1:1`, () =>
    sheets.spreadsheets.values.get({
      spreadsheetId: config.sheetId,
      range: `${sheetRef(sheetName)}!1:1`,
    }),
  );

  const rawHeaders: string[] = (head.data.values?.[0] || []).map((x) => String(x ?? ""));
  const headers = rawHeaders.map(normalizeHeader);

  const map: Record<string, number> = {};

  headers.forEach((h, i) => {
    const key = norm(h);

    if (key) {
      map[key] = i;
    }
  });

  const result = { headers, map };

  headerCache.set(sheetName, result);

  return result;
}

export async function loadSheet(sheetName: string, range = "A:Z") {
  const cacheKey = readCacheKey(sheetName, range);
  const cached = readCache.get(cacheKey);
  const now = Date.now();

  if (cached && now - cached.ts < ttlForSheet(sheetName)) {
    console.log(`[SHEETS][CACHE_HIT] ${cacheKey}`);
    return cached.value;
  }

  console.log(`[SHEETS][CACHE_MISS] ${cacheKey}`);

  const pending = pendingReads.get(cacheKey);
  if (pending) {
    console.log(`[SHEETS][CACHE_HIT] ${cacheKey}:pending`);
    return pending;
  }

  const sheets = getSheetsClient();
  const pendingRead = (async (): Promise<LoadedSheet> => {
    const res = await withSheetsRetry("READ", `${sheetName}!${range}`, () =>
      sheets.spreadsheets.values.get({
        spreadsheetId: config.sheetId,
        range: `${sheetRef(sheetName)}!${range}`,
      }),
    );

    const rows = res.data.values || [];

    if (rows.length === 0) {
      return { header: [] as string[], map: {} as Record<string, number>, data: [] as any[][], all: rows };
    }

    const header = (rows[0] || []).map(normalizeHeader);
    const map: Record<string, number> = {};
    header.forEach((h: string, i: number) => {
      const key = norm(h);
      if (key) map[key] = i;
    });

    const data = rows
      .slice(1)
      .filter((r) => r && r.some((c) => String(c ?? "").trim() !== ""));

    return { header, map, data, all: rows };
  })();

  pendingReads.set(cacheKey, pendingRead);

  try {
    const value = await pendingRead;
    readCache.set(cacheKey, { ts: Date.now(), value });
    return value;
  } finally {
    pendingReads.delete(cacheKey);
  }
}

export async function appendRows(
  sheetName: string,
  rows: any[][],
  valueInputOption: "RAW" | "USER_ENTERED" = "USER_ENTERED"
) {
  if (!rows.length) return;
  const sheets = getSheetsClient();

  await withSheetsRetry("WRITE", `${sheetName}!A:Z append`, () =>
    sheets.spreadsheets.values.append({
      spreadsheetId: config.sheetId,
      range: `${sheetRef(sheetName)}!A:Z`,
      valueInputOption,
      requestBody: { values: rows },
    }),
  );
  invalidateSheetCache(sheetName);
}

export async function updateRow(sheetName: string, rowNumber1Based: number, values: any[]) {
  const sheets = getSheetsClient();
  const endCol = colToA1(values.length - 1);
  const range = `${sheetRef(sheetName)}!A${rowNumber1Based}:${endCol}${rowNumber1Based}`;

  await withSheetsRetry("WRITE", `${sheetName}!${range} update`, () =>
    sheets.spreadsheets.values.update({
      spreadsheetId: config.sheetId,
      range,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [values] },
    }),
  );
  invalidateSheetCache(sheetName);
}

function rowMatchesKeys(row: any[], map: Record<string, number>, keys: Record<string, any>) {
  for (const [headerName, expected] of Object.entries(keys)) {
    const idx = map[norm(headerName)];
    if (idx === undefined) return false;
    const cell = String(row[idx] ?? "").trim();
    const exp = String(expected ?? "").trim();
    if (cell !== exp) return false;
  }
  return true;
}

/**
 * Upsert: знайти рядок по keys → update, або append якщо нема
 * (для MVP читає весь лист A:Z)
 */
export async function upsertRowByKeys(sheetName: string, keys: Record<string, any>, patch: Record<string, any>) {
  const sheets = getSheetsClient();

  const res = await withSheetsRetry("READ", `${sheetName}!A:Z upsert`, () =>
    sheets.spreadsheets.values.get({
      spreadsheetId: config.sheetId,
      range: `${sheetRef(sheetName)}!A:Z`,
    }),
  );

  const rows = res.data.values || [];
  if (!rows.length) throw new Error(`❌ Лист "${sheetName}" порожній або не має заголовків`);

  const headers = (rows[0] || []).map(normalizeHeader);
  const map: Record<string, number> = {};
  headers.forEach((h, i) => {
    if (h) map[norm(h)] = i;
  });

  // всі key headers мають існувати
  requireHeaders(map, Object.keys(keys), sheetName);
  // і всі patch headers теж мають існувати
  requireHeaders(map, Object.keys(patch), sheetName);

  // знайти рядок
  let foundIndex0Based = -1;
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r || !r.length) continue;
    if (rowMatchesKeys(r, map, keys)) {
      foundIndex0Based = i;
      break;
    }
  }

  if (foundIndex0Based !== -1) {
    const existing = rows[foundIndex0Based] || [];
    const full = new Array(headers.length).fill("");
    for (let i = 0; i < headers.length; i++) full[i] = existing[i] ?? "";

    // накласти patch
    for (const [h, v] of Object.entries(patch)) {
      const idx = map[norm(h)];
      if (idx === undefined) continue;
      full[idx] = v ?? "";
    }

    await updateRow(sheetName, foundIndex0Based + 1, full);
    return { action: "updated" as const, rowNumber: foundIndex0Based + 1 };
  }

  const mergedPatch = { ...keys, ...patch };
  const newRow = buildRowByHeaders(headers, map, mergedPatch);
  await appendRows(sheetName, [newRow], "USER_ENTERED");
  return { action: "appended" as const };

}

