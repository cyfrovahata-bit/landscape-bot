import { config } from "../../config.js";
import { getSheetsClient } from "../client.js";
import { appendRows, getCell, loadSheet, invalidateSheetCache, withSheetsRetry } from "./core.js";
import { EVENTS_HEADERS } from "./headers.js";
import { SHEET_NAMES } from "./names.js";
import { nowISO, sheetRef } from "./utils.js";

const ACCOUNTING_SHEET = "БУХЗВІТ";
const ACCOUNTING_META_SHEET = "БУХЗВІТ_META";
const ACCOUNTING_HEADERS = [
  "№",
  "Дата",
  "Працівник",
  "Об'єкт",
  "Роботи",
  "Обсяг робіт",
  "Нарахування",
  "Примітки",
] as const;
const ACCOUNTING_META_HEADERS = [
  "eventId",
  "createdAt",
  "rowsCount",
] as const;

type RoadEventLike = {
  eventId: string;
  date: string;
  foremanTgId: number;
  payload?: string;
  ts?: string;
  status?: string;
  chatId?: number;
  msgId?: number;
  type?: string;
  objectId?: string;
  carId?: string;
  employeeIds?: string;
  refEventId?: string;
  updatedAt?: string;
};

type AccountingRow = {
  date: string;
  employeeName: string;
  objectName: string;
  workName: string;
  volume: string;
  amount: number;
  eventId: string;
};

async function ensureSheet(sheetName: string, headers: readonly string[]) {
  const sheets = getSheetsClient();

  const meta = await withSheetsRetry("READ", "spreadsheet metadata", () =>
    sheets.spreadsheets.get({
      spreadsheetId: config.sheetId,
      fields: "sheets.properties.title",
    }),
  );

  const exists = (meta.data.sheets ?? []).some(
    (s) => s.properties?.title === sheetName,
  );

  if (!exists) {
    await withSheetsRetry("WRITE", `${sheetName} create`, () =>
      sheets.spreadsheets.batchUpdate({
        spreadsheetId: config.sheetId,
        requestBody: {
          requests: [{ addSheet: { properties: { title: sheetName } } }],
        },
      }),
    );

    const lastCol = String.fromCharCode("A".charCodeAt(0) + headers.length - 1);
    await withSheetsRetry("WRITE", `${sheetName}!A1:${lastCol}1 update`, () =>
      sheets.spreadsheets.values.update({
        spreadsheetId: config.sheetId,
        range: `${sheetRef(sheetName)}!A1:${lastCol}1`,
        valueInputOption: "USER_ENTERED",
        requestBody: { values: [[...headers]] },
      }),
    );
    invalidateSheetCache(sheetName);

    console.log(`[accounting] created sheet ${sheetName}`);
  }
}

async function loadAccountingSheet() {
  await ensureSheet(ACCOUNTING_SHEET, ACCOUNTING_HEADERS);
  return loadSheet(ACCOUNTING_SHEET, "A:H");
}

async function loadAccountingMetaSheet() {
  await ensureSheet(ACCOUNTING_META_SHEET, ACCOUNTING_META_HEADERS);
  return loadSheet(ACCOUNTING_META_SHEET, "A:C");
}

export async function hasAccountingRowsForEvent(eventId: string) {
  const sh = await loadAccountingMetaSheet();
  const needle = String(eventId).trim();

  return sh.data.some((row) => String(row?.[0] ?? "").trim() === needle);
}

export async function resolveApprovedRoadEvent(callbackEv: RoadEventLike) {
  const sh = await loadSheet(SHEET_NAMES.events);
  const rows: RoadEventLike[] = [];

  for (const row of sh.data) {
    const type = getCell(row, sh.map, EVENTS_HEADERS.type);
    const date = getCell(row, sh.map, EVENTS_HEADERS.date);
    const foremanTgId = Number(getCell(row, sh.map, EVENTS_HEADERS.foremanTgId));

    if (type !== "ROAD_END") continue;
    if (date !== callbackEv.date) continue;
    if (foremanTgId !== Number(callbackEv.foremanTgId)) continue;

    rows.push({
      eventId: getCell(row, sh.map, EVENTS_HEADERS.eventId),
      ts: getCell(row, sh.map, EVENTS_HEADERS.ts),
      date,
      foremanTgId,
      type,
      status: getCell(row, sh.map, EVENTS_HEADERS.status),
      objectId: getCell(row, sh.map, EVENTS_HEADERS.objectId),
      carId: getCell(row, sh.map, EVENTS_HEADERS.carId),
      employeeIds: getCell(row, sh.map, EVENTS_HEADERS.employeeIds),
      payload: getCell(row, sh.map, EVENTS_HEADERS.payload),
      chatId: Number(getCell(row, sh.map, EVENTS_HEADERS.chatId) || 0),
      msgId: Number(getCell(row, sh.map, EVENTS_HEADERS.msgId) || 0),
      refEventId: getCell(row, sh.map, EVENTS_HEADERS.refEventId),
      updatedAt: getCell(row, sh.map, EVENTS_HEADERS.updatedAt),
    });
  }

  const activeRows = rows.filter((ev) => String(ev.status ?? "") !== "СКАСОВАНО");
  const candidates = activeRows.length ? activeRows : rows;
  candidates.sort((a, b) => {
    const ats = Date.parse(String(a.ts || a.updatedAt || ""));
    const bts = Date.parse(String(b.ts || b.updatedAt || ""));
    const an = Number.isFinite(ats) ? ats : 0;
    const bn = Number.isFinite(bts) ? bts : 0;
    if (an !== bn) return an - bn;
    return String(a.eventId).localeCompare(String(b.eventId));
  });

  const resolved = candidates[candidates.length - 1] ?? callbackEv;
  const savesCount = rows.length;
  const isResubmission = savesCount > 1 || String(callbackEv.eventId) !== String(resolved.eventId);

  return { event: resolved, savesCount, isResubmission };
}

function money(n: number) {
  return Math.round(Number(n || 0) * 100) / 100;
}

function parseQtyNumber(raw: unknown): number {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : 0;
  const s = String(raw ?? "").trim().replace(",", ".");
  const m = s.match(/-?\d+(?:\.\d+)?/);
  if (!m) return 0;
  const n = Number(m[0]);
  return Number.isFinite(n) ? n : 0;
}

function cleanUnit(raw: unknown): string {
  return String(raw ?? "")
    .trim()
    .replace(/^-?\d+(?:[.,]\d+)?\s*/u, "")
    .trim();
}

function unitFromQty(raw: unknown): string {
  return cleanUnit(cleanUnit(raw));
}

export function formatWorkQty(qtyRaw: unknown, unitRaw: unknown) {
  const qty = parseQtyNumber(qtyRaw);
  const unit = cleanUnit(unitRaw) || unitFromQty(qtyRaw);

  const roundedToInt = Math.round(qty);
  const normalized =
    Math.abs(qty - roundedToInt) < 0.011
      ? roundedToInt
      : Math.round(qty * 100) / 100;
  const qtyText = Number.isInteger(normalized)
    ? String(normalized)
    : String(normalized).replace(/(\.\d*?)0+$/u, "$1").replace(/\.$/u, "");

  return [qtyText, unit].filter(Boolean).join(" ");
}

function parsePayload(ev: RoadEventLike) {
  try {
    return ev.payload ? JSON.parse(String(ev.payload)) : {};
  } catch {
    return {};
  }
}

export function buildAccountingRowsFromApprovedRoadEvent(ev: RoadEventLike): AccountingRow[] {
  const payload = parsePayload(ev);
  const workMoneyRows = Array.isArray(payload.workMoneyRows)
    ? payload.workMoneyRows
    : [];
  const salaryPacks = Array.isArray(payload.salaryPacks)
    ? payload.salaryPacks
    : [];
  const objectsDetailed = Array.isArray(payload.objectsDetailed)
    ? payload.objectsDetailed
    : [];

  const objectNameById = new Map<string, string>();
  for (const o of objectsDetailed) {
    const id = String(o?.objectId ?? "").trim();
    const name = String(o?.objectName ?? "").trim();
    if (id && name) objectNameById.set(id, name);
  }

  const fallbackObjects = objectsDetailed
    .map((o: any) => String(o?.objectName ?? "").trim())
    .filter(Boolean)
    .join(", ");

  const brigadierIds = new Set(
    [
      ...(Array.isArray(payload.brigadierEmployeeIds)
        ? payload.brigadierEmployeeIds
        : []),
      payload.brigadierEmployeeId,
    ]
      .map((x) => String(x ?? "").trim())
      .filter(Boolean),
  );
  const seniorIds = new Set(
    [
      ...(Array.isArray(payload.seniorEmployeeIds)
        ? payload.seniorEmployeeIds
        : []),
      payload.seniorEmployeeId,
    ]
      .map((x) => String(x ?? "").trim())
      .filter(Boolean),
  );

  const byObjectEmployee = new Map<string, any[]>();
  const workTotals = new Map<
    string,
    {
      objectId: string;
      workId: string;
      workName: string;
      unit: string;
      qty: number;
      amount: number;
    }
  >();

  for (const row of workMoneyRows) {
    const objectId = String(row.objectId ?? "").trim();
    const employeeId = String(row.employeeId ?? "").trim();
    const workId = String(row.workId ?? "").trim();
    const workName = String(row.workName ?? row.workId ?? "").trim();
    if (!employeeId || !workName) continue;

    const key = `${objectId}||${employeeId}`;
    const rows = byObjectEmployee.get(key) ?? [];
    rows.push(row);
    byObjectEmployee.set(key, rows);

    const workKey = `${objectId}||${workId || workName}`;
    const rowQty = parseQtyNumber(row.qty);
    const rowUnit = cleanUnit(row.unit) || unitFromQty(row.qty);
    const current =
      workTotals.get(workKey) ?? {
        objectId,
        workId,
        workName,
        unit: rowUnit,
        qty: 0,
        amount: 0,
      };

    current.qty += rowQty;
    if (!current.unit && rowUnit) current.unit = rowUnit;
    current.amount += Number(row.amount ?? 0);
    workTotals.set(workKey, current);
  }

  const out: AccountingRow[] = [];

  for (const pack of salaryPacks) {
    const objectId = String(pack?.objectId ?? "").trim();
    const objectName =
      String(pack?.objectName ?? "").trim() ||
      objectNameById.get(objectId) ||
      fallbackObjects ||
      objectId ||
      "—";

    const objectTotal = Number(pack?.objectTotal ?? 0);
    const packRows = Array.isArray(pack?.rows) ? pack.rows : [];
    const hasBrigadier = packRows.some((r: any) =>
      brigadierIds.has(String(r.employeeId ?? "").trim()),
    );
    const hasSenior = packRows.some((r: any) =>
      seniorIds.has(String(r.employeeId ?? "").trim()),
    );
    const workersPool = money(objectTotal * (hasBrigadier ? 0.7 : 0.9));
    const workerSalaryRows = packRows.filter((r: any) => {
      const id = String(r.employeeId ?? "").trim();
      if (!id) return false;
      if (hasBrigadier && brigadierIds.has(id)) return false;
      if (hasSenior && seniorIds.has(id)) return false;
      return byObjectEmployee.has(`${objectId}||${id}`);
    });
    const totalPoints = workerSalaryRows.reduce(
      (a: number, r: any) => a + Number(r.points ?? 0),
      0,
    );
    const employeesCount = workerSalaryRows.length;
    if (!employeesCount || workersPool <= 0) continue;
    const objectWorks = [...workTotals.values()].filter(
      (w) => String(w.objectId) === objectId && Number(w.amount ?? 0) > 0,
    );
    const workTotalForObject = objectWorks.reduce(
      (a, w) => a + Number(w.amount ?? 0),
      0,
    );

    for (const salaryRow of workerSalaryRows) {
      const employeeId = String(salaryRow?.employeeId ?? "").trim();
      const employeeName = String(salaryRow?.employeeName ?? employeeId).trim();
      if (!employeeId) continue;
      const employeePoints = Number(salaryRow?.points ?? 0);
      const employeeShare =
        totalPoints > 0 ? employeePoints / totalPoints : 1 / employeesCount;
      const employeeAmount = money(workersPool * employeeShare);

      const workRows = byObjectEmployee.get(`${objectId}||${employeeId}`) ?? [];
      if (!workRows.length) continue;

      const workKeys = [
        ...new Set(
          workRows.map((row) => {
            const workId = String(row.workId ?? "").trim();
            return `${objectId}||${workId || String(row.workName ?? "")}`;
          }),
        ),
      ];

      for (const workKey of workKeys) {
        const totalWork = workTotals.get(workKey);
        if (!totalWork) continue;

        const workTotal = Number(totalWork.amount ?? 0);
        const share =
          workTotalForObject > 0
            ? workTotal / workTotalForObject
            : 1 / Math.max(1, workKeys.length);
        const amount = money(employeeAmount * share);

        if (amount <= 0) continue;

        const qty = Number(totalWork.qty ?? 0);
        const unit = cleanUnit(totalWork.unit);
        const formattedQty = formatWorkQty(qty, unit);

        out.push({
          date: ev.date,
          employeeName,
          objectName,
          workName: totalWork.workName || totalWork.workId || "—",
          volume: formattedQty,
          amount,
          eventId: ev.eventId,
        });

        console.log(
          [
            "[accounting] row",
            `workTotal=${money(workTotal)}`,
            `workersPool=${workersPool}`,
            `employeesCount=${employeesCount}`,
            `totalPoints=${money(totalPoints)}`,
            `employeeId=${employeeId}`,
            `name=${employeeName}`,
            `points=${money(employeePoints)}`,
            `share=${money(employeeShare)}`,
            `amount=${amount}`,
            `qty=${money(qty)}`,
            `unit=${unit}`,
            `formattedQty=${formattedQty}`,
          ].join(" "),
        );
      }
    }
  }

  const totalRowsAmount = money(out.reduce((a, row) => a + Number(row.amount ?? 0), 0));
  console.log(`[accounting] totalRowsAmount=${totalRowsAmount}`);

  return out;
}

export async function appendAccountingReportRows(rows: AccountingRow[]) {
  if (!rows.length) return;

  const sh = await loadAccountingSheet();
  const hasHeader =
    String(sh.all?.[0]?.[0] ?? "").trim() === ACCOUNTING_HEADERS[0] &&
    String(sh.all?.[0]?.[1] ?? "").trim() === ACCOUNTING_HEADERS[1];
  const existingDataRows = hasHeader ? Math.max(0, sh.all.length - 1) : sh.all.length;
  let nextNo = existingDataRows + 1;

  await appendRows(
    ACCOUNTING_SHEET,
    rows.map((row) => [
      nextNo++,
      row.date,
      row.employeeName,
      row.objectName,
      row.workName,
      row.volume,
      row.amount,
      "",
    ]),
    "USER_ENTERED",
  );
}

async function appendAccountingMetaRow(eventId: string, rowsCount: number) {
  await loadAccountingMetaSheet();
  await appendRows(
    ACCOUNTING_META_SHEET,
    [[String(eventId).trim(), nowISO(), rowsCount]],
    "USER_ENTERED",
  );
}

export async function appendAccountingReportForApprovedRoadEvent(ev: RoadEventLike) {
  if (await hasAccountingRowsForEvent(ev.eventId)) {
    console.log(`[accounting] skip duplicate eventId=${ev.eventId}`);
    return { skipped: true, rows: 0 };
  }

  const rows = buildAccountingRowsFromApprovedRoadEvent(ev);
  console.log(`[accounting] prepared rows=${rows.length} eventId=${ev.eventId}`);

  if (!rows.length) {
    console.log(`[accounting] nothing to append eventId=${ev.eventId}`);
    return { skipped: false, rows: 0 };
  }

  await appendAccountingReportRows(rows);
  await appendAccountingMetaRow(ev.eventId, rows.length);
  console.log(`[accounting] appended rows=${rows.length} eventId=${ev.eventId}`);
  return { skipped: false, rows: rows.length };
}
