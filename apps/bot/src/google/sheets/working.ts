import { SHEET_NAMES } from "./names.js";
import type { AllowanceRow, ClosureRow, DayStatusRow, EventRow, OdometerDayRow, ReportRow, TimesheetRow, MaterialMoveRow, ToolMoveRow } from "./types.js";
import {
  ALLOWANCES_HEADERS,
  CLOSURES_HEADERS,
  DAY_STATUS_HEADERS,
  EVENTS_HEADERS,
  ODOMETER_HEADERS,
  REPORTS_HEADERS,
  TIMESHEET_HEADERS,
  MATERIALS_MOVE_HEADERS,
  TOOLS_MOVE_HEADERS,
  EDIT_LOG_HEADERS
} from "./headers.js";
import { buildRowByHeaders, getHeaderMap, appendRows, requireHeaders, upsertRowByKeys, loadSheet, getCell, invalidateSheetCache } from "./core.js";
import { nowISO, parseNumber, makeEventId, classifyTripByKm  } from "./utils.js";
import { computeChecklist, getDayStatusRow } from "./checklist.js";
// ⬇️ додай імпорти зверху файлу
import { fetchEmployees } from "./dictionaries.js";
import { computeTimesheetFromEvents } from "./timesheetFromEvents.js";

export type RoadEventsInput = {
  date: string;
  foremanTgId: number;

  carId: string;
  objectIds: string[];        // 1–4
  employeeIds: string[];      // 1+
  chatId?: number;
  msgId?: number;

  odoStartKm: number;
  odoEndKm: number;
  odoStartPhoto?: string;     // file_id або drive link — як ти вирішиш
  odoEndPhoto?: string;
};

export type RoadEventType =
  | "ODO_START"
  | "ODO_END"
  | "ROAD_SAVE";

function roadPayloadBase(input: RoadEventsInput) {
  const kmDay = input.odoEndKm - input.odoStartKm;
  return {
    carId: input.carId,
    employeeIds: input.employeeIds,
    objectIds: input.objectIds,
    odoStartKm: input.odoStartKm,
    odoEndKm: input.odoEndKm,
    odoStartPhoto: input.odoStartPhoto ?? "",
    odoEndPhoto: input.odoEndPhoto ?? "",
    kmDay: Number.isFinite(kmDay) ? kmDay : 0,
  };
}

/**
 * ROAD events пишемо ПО КОЖНОМУ objectId:
 * - ROAD_ODO_START (для hasOdoStart/hasOdoStartPhoto)
 * - ROAD_ODO_END   (для hasOdoEnd/hasOdoEndPhoto)
 * - ROAD_SAVE      (для hasRoad)
 * 
 * 
 */

export async function appendRoadEvents(input: RoadEventsInput) {
  const now = nowISO();

  const objectIds = (input.objectIds ?? []).map(String).filter(Boolean);
  if (objectIds.length < 1 || objectIds.length > 4) {
    throw new Error(`ROAD: objectIds must be 1..4 (got ${objectIds.length})`);
  }
  if (!input.carId) throw new Error("ROAD: carId is required");
  if (!input.employeeIds?.length) throw new Error("ROAD: employeeIds must be >= 1");
  if (typeof input.odoStartKm !== "number") throw new Error("ROAD: odoStartKm required");
  if (typeof input.odoEndKm !== "number") throw new Error("ROAD: odoEndKm required");

  const base = roadPayloadBase(input);

  const mk = (type: RoadEventType, objectId: string, payload: any): EventRow => ({
    eventId: makeEventId("ROAD"),
    ts: now,
    date: input.date,
    foremanTgId: input.foremanTgId,
    type,
    status: "АКТИВНА",
    objectId,
    carId: input.carId,
    employeeIds: input.employeeIds.join(","),
    payload: JSON.stringify(payload),
    chatId: input.chatId ?? 0,
    msgId: input.msgId ?? 0,
    refEventId: "",
    updatedAt: now,
  });

  const events: EventRow[] = [];

  for (const objectId of objectIds) {
    events.push(
      mk("ODO_START", objectId, {
        ...base,
        odoKm: input.odoStartKm,
        odoPhoto: input.odoStartPhoto ?? "",
      }),
      mk("ODO_END", objectId, {
        ...base,
        odoKm: input.odoEndKm,
        odoPhoto: input.odoEndPhoto ?? "",
      }),
      mk("ROAD_SAVE", objectId, base)
    );
  }

  await appendEvents(events);

    await upsertOdometerDay({
    date: input.date,
    carId: input.carId,
    foremanTgId: input.foremanTgId,
    startValue: input.odoStartKm,
    startPhoto: input.odoStartPhoto ?? "",
    endValue: input.odoEndKm,
    endPhoto: input.odoEndPhoto ?? "",
    kmDay: base.kmDay,
    tripClass: classifyTripByKm(base.kmDay),
    updatedAt: now,
  });


  for (const objectId of objectIds) {
    await refreshDayChecklist(input.date, objectId, input.foremanTgId);
  }
}


function isMissingVolumeStatus(vs: string) {
  const s = String(vs ?? "").trim().toUpperCase();
  return s !== "ЗАПОВНЕНО";
}

function isMissingVolume(volumeRaw: string) {
  const s = String(volumeRaw ?? "").trim();
  if (s === "" || s === "?") return true;
  const n = Number(s.replace(",", "."));
  return !Number.isFinite(n) || n <= 0;
}

export async function fetchMissingReports(args: {
  date: string;
  objectId: string;
  foremanTgId: number;
}): Promise<ReportRow[]> {
  const { map, data } = await loadSheet(SHEET_NAMES.reports, "A:Z");

  // мінімально потрібні колонки
  // (requireHeaders ти вже робиш всередині upsertRowByKeys, але тут ми просто читаємо)
  const out: ReportRow[] = [];

  for (const row of data) {
    const date = getCell(row, map, REPORTS_HEADERS.date);
    const objectId = getCell(row, map, REPORTS_HEADERS.objectId);
    const foremanTgIdStr = getCell(row, map, REPORTS_HEADERS.foremanTgId);

    if (date !== args.date) continue;
    if (objectId !== args.objectId) continue;
    if (parseNumber(foremanTgIdStr) !== args.foremanTgId) continue;

    const volumeRaw = getCell(row, map, REPORTS_HEADERS.volume);
    const volumeStatus = getCell(row, map, REPORTS_HEADERS.volumeStatus);

    const missing =
      isMissingVolumeStatus(volumeStatus) || isMissingVolume(volumeRaw);

    if (!missing) continue;

    out.push({
      date,
      objectId,
      foremanTgId: parseNumber(foremanTgIdStr),
      workId: getCell(row, map, REPORTS_HEADERS.workId),
      workName: getCell(row, map, REPORTS_HEADERS.workName),
      // якщо у твоєму типі volume string — заміни на volume: volumeRaw
      volume: volumeRaw === "" || volumeRaw === "?" ? volumeRaw : parseNumber(volumeRaw),
      volumeStatus,
      photos: getCell(row, map, REPORTS_HEADERS.photos),
      dayStatus: getCell(row, map, REPORTS_HEADERS.dayStatus),
      updatedAt: getCell(row, map, REPORTS_HEADERS.updatedAt),
    } as any);
  }

  return out;
}

function clearEventsSheetCache() {
  eventsSheetCache = null;
  invalidateSheetCache(SHEET_NAMES.events);
}


/**
 * D2: апдейтнути qty/статус по ключу "date||objectId||foremanTgId||workId"
 */
export async function updateReportQty(args: {
  key: string;
  volume: number | "" | "?";
  volumeStatus: "ЗАПОВНЕНО" | "НЕ_ЗАПОВНЕНО";
}): Promise<void> {
  const [date, objectId, foremanStr, workId] = String(args.key).split("||");
  const foremanTgId = Number(foremanStr);

  await upsertRowByKeys(
    SHEET_NAMES.reports,
    {
      [REPORTS_HEADERS.date]: date,
      [REPORTS_HEADERS.objectId]: objectId,
      [REPORTS_HEADERS.foremanTgId]: String(foremanTgId),
      [REPORTS_HEADERS.workId]: workId,
    },
    {
      [REPORTS_HEADERS.volume]: args.volume,
      [REPORTS_HEADERS.volumeStatus]: args.volumeStatus,
      [REPORTS_HEADERS.updatedAt]: nowISO(), // якщо колонки нема — прибери цей рядок
    }
  );
  clearEventsSheetCache();
}



export async function fetchEventById(eventId: string) {
  const sh = await loadEventsSheetCached();

  requireHeaders(
    sh.map,
    [EVENTS_HEADERS.eventId],
    SHEET_NAMES.events
  );

  const row = sh.data.find((r: any) =>
  String(getCell(r, sh.map, EVENTS_HEADERS.eventId)) === String(eventId)
);
  if (!row) return null;

  // якщо в тебе є тип EventRow — поверни його як у інших fetch
  return buildRowByHeaders(row, sh.map, EVENTS_HEADERS);
}



// ⬇️ ДОДАЙ ЦЮ ФУНКЦІЮ
export async function getTodayTimesheetPreview(args: {
  date: string;
  foremanTgId: number;
  objectId?: string;
}) {
  const { date, foremanTgId, objectId } = args;

const filter: FetchEventsFilter = {
  date,
  foremanTgId,
  types: ["TS_START", "TS_ADD", "TS_REMOVE", "TS_MOVE", "TS_END"],
  status: "АКТИВНА",
  ...(objectId ? { objectId } : {}),
};




const events = await fetchEvents(filter);


  const employeesDict = await fetchEmployees();

  return computeTimesheetFromEvents({
    date,
    foremanTgId,
    events,
    employeesDict,
  });
}


type FetchEventsFilter = {
  date: string;
  foremanTgId?: number | string;
  types?: string[];
  objectId?: string;
  status?: EventRow["status"];
};


let eventsSheetCache: any = null;

async function loadEventsSheetCached() {
  const now = Date.now();
  const ttlMs = 20_000;

  if (eventsSheetCache && now - eventsSheetCache.ts < ttlMs) {
    console.log(`[SHEETS][CACHE_HIT] eventsSheetCache`);
    return {
      map: eventsSheetCache.map,
      data: eventsSheetCache.data,
    };
  }

  console.log(`[SHEETS][CACHE_MISS] eventsSheetCache`);
  const sh = await loadSheet(SHEET_NAMES.events); // ✅ ВАЖЛИВО

  eventsSheetCache = {
    ts: now,
    map: sh.map,
    data: sh.data,
  };

  return sh;
}


export async function fetchEvents(filter: FetchEventsFilter): Promise<EventRow[]> {
  const { map, data } = await loadEventsSheetCached();

  requireHeaders(
    map,
    [
      EVENTS_HEADERS.eventId,
      EVENTS_HEADERS.ts,
      EVENTS_HEADERS.date,  
      EVENTS_HEADERS.foremanTgId,
      EVENTS_HEADERS.type,
      EVENTS_HEADERS.status,
      EVENTS_HEADERS.updatedAt,

      EVENTS_HEADERS.objectId,
      EVENTS_HEADERS.carId,
      EVENTS_HEADERS.employeeIds,
      EVENTS_HEADERS.payload,
      EVENTS_HEADERS.chatId,
      EVENTS_HEADERS.msgId,
      EVENTS_HEADERS.refEventId,
    ],
    SHEET_NAMES.events
  );

  const idx = (h: string): number => {
    const i = map[h];
    if (typeof i !== "number") throw new Error(`Missing header "${h}" in sheet "${SHEET_NAMES.events}"`);
    return i;
  };

  const s = (v: unknown) => String(v ?? "").trim();

  const toNumU = (v: unknown): number | undefined => {
    const t = s(v);
    if (!t) return undefined;
    const n = Number(t);
    return Number.isFinite(n) ? n : undefined;
  };

  const out: EventRow[] = [];

  for (let r = 0; r < data.length; r++) {
    const row = data[r];
    if (!row) continue;

    const date = s(row[idx(EVENTS_HEADERS.date)]);
    const foremanTgId = Number(s(row[idx(EVENTS_HEADERS.foremanTgId)]) || 0);

if (date !== filter.date) continue;

if (
  filter.foremanTgId !== undefined &&
  filter.foremanTgId !== null &&
  String(filter.foremanTgId).trim() !== "" &&
  foremanTgId !== Number(filter.foremanTgId)
) {
  continue;
}

    const type = s(row[idx(EVENTS_HEADERS.type)]);
    if (filter.types?.length && !filter.types.includes(type)) continue;

    const objectId = s(row[idx(EVENTS_HEADERS.objectId)]);
    if (filter.objectId && objectId !== filter.objectId) continue;

    const status = s(row[idx(EVENTS_HEADERS.status)]) as EventRow["status"];
    if (filter.status && status !== filter.status) continue;

    out.push({
      eventId: s(row[idx(EVENTS_HEADERS.eventId)]),
      ts: s(row[idx(EVENTS_HEADERS.ts)]),
      date,
      foremanTgId,
      type,
      objectId,
      carId: s(row[idx(EVENTS_HEADERS.carId)]),
      employeeIds: s(row[idx(EVENTS_HEADERS.employeeIds)]),
      payload: s(row[idx(EVENTS_HEADERS.payload)]),
      chatId: toNumU(row[idx(EVENTS_HEADERS.chatId)]) ?? 0,
      msgId: toNumU(row[idx(EVENTS_HEADERS.msgId)]) ?? 0,
      refEventId: s(row[idx(EVENTS_HEADERS.refEventId)]),
      status,
      updatedAt: s(row[idx(EVENTS_HEADERS.updatedAt)]),
    });
  }

  out.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
  return out;
}

export async function refreshDayChecklist(date: string, objectId: string, foremanTgId: number) {
  const existing = await getDayStatusRow(date, objectId, foremanTgId);

  // ✅ тепер з foremanTgId
  const checklist = await computeChecklist(date, objectId, foremanTgId);

  const row: DayStatusRow = {
    date,
    objectId,
    foremanTgId,
    status: existing?.status || "ЧЕРНЕТКА",

    hasTimesheet: checklist.hasTimesheet,
    hasReports: checklist.hasReports,

    // ✅ нове
    hasReportsVolumeOk: checklist.hasReportsVolumeOk,

    hasRoad: checklist.hasRoad,
    hasOdoStart: checklist.hasOdoStart,
    hasOdoEnd: checklist.hasOdoEnd,

    // ✅ нове
    hasOdoStartPhoto: checklist.hasOdoStartPhoto,
    hasOdoEndPhoto: checklist.hasOdoEndPhoto,

    hasLogistics: checklist.hasLogistics,
    hasMaterials: checklist.hasMaterials,

    returnReason: existing?.returnReason || "",
    approvedBy: existing?.approvedBy || "",
    approvedAt: existing?.approvedAt || "",
    updatedAt: nowISO(),
  };

  return upsertDayStatus(row);
}


type SetDayStatusInput = {
  date: string;
  objectId: string;
  foremanTgId: number;

  // "ЧЕРНЕТКА" | "ЗДАНО" | "ПОВЕРНУТО" | "ПІДТВЕРДЖЕНО" (або як у тебе в types.ts)
  status: DayStatusRow["status"];

  // для Returned
  returnReason?: string;

  // для Approved
  approvedBy?: string;
  approvedAt?: string; // якщо не передали — поставимо nowISO()
};

export async function setDayStatus(input: SetDayStatusInput) {
  const { date, objectId, foremanTgId } = input;

  const existing = await getDayStatusRow(date, objectId, foremanTgId);

  // ✅ тепер з foremanTgId
  const checklist = await computeChecklist(date, objectId, foremanTgId);

  const base: DayStatusRow = {
    date,
    objectId,
    foremanTgId,

    status: input.status,

    hasTimesheet: checklist.hasTimesheet,
    hasReports: checklist.hasReports,

    // ✅ нове
    hasReportsVolumeOk: checklist.hasReportsVolumeOk,

    hasRoad: checklist.hasRoad,
    hasOdoStart: checklist.hasOdoStart,
    hasOdoEnd: checklist.hasOdoEnd,

    // ✅ нове
    hasOdoStartPhoto: checklist.hasOdoStartPhoto,
    hasOdoEndPhoto: checklist.hasOdoEndPhoto,

    hasLogistics: checklist.hasLogistics,
    hasMaterials: checklist.hasMaterials,

    returnReason: existing?.returnReason || "",
    approvedBy: existing?.approvedBy || "",
    approvedAt: existing?.approvedAt || "",
    updatedAt: nowISO(),
  };

  // правила переходів (як у тебе було) — лишаємо
  if (input.status === "ПОВЕРНУТО") {
    base.returnReason = (input.returnReason ?? "").trim();
    base.approvedBy = "";
    base.approvedAt = "";
  }

  if (input.status === "ЗАТВЕРДЖЕНО") {
    base.returnReason = "";
    base.approvedBy = (input.approvedBy ?? existing?.approvedBy ?? "").trim();
    base.approvedAt = (input.approvedAt ?? nowISO()).trim();
  }

  if (input.status === "ЗДАНО" || input.status === "ЧЕРНЕТКА") {
    base.returnReason = "";
    base.approvedBy = "";
    base.approvedAt = "";
  }

  return upsertDayStatus(base);
}


/**
 * ======================
 *  WORKING SHEETS: APPEND
 * ======================
 */

export async function appendEvents(events: EventRow[]) {
  if (!events.length) return;

  const { headers, map } = await getHeaderMap(SHEET_NAMES.events);

  requireHeaders(
    map,
    [
      EVENTS_HEADERS.eventId,
      EVENTS_HEADERS.status,
      EVENTS_HEADERS.updatedAt,
      EVENTS_HEADERS.ts,
      EVENTS_HEADERS.date,
      EVENTS_HEADERS.foremanTgId,
      EVENTS_HEADERS.type,

      // 👇 те що ти реально пишеш нижче
      EVENTS_HEADERS.refEventId,
      EVENTS_HEADERS.chatId,
      EVENTS_HEADERS.msgId,
      EVENTS_HEADERS.objectId,
      EVENTS_HEADERS.carId,
      EVENTS_HEADERS.employeeIds,
      EVENTS_HEADERS.payload,
    ],
    SHEET_NAMES.events
  );

  const rows = events.map((e) =>
    buildRowByHeaders(headers, map, {
      [EVENTS_HEADERS.eventId]: e.eventId,
      [EVENTS_HEADERS.status]: e.status,
      [EVENTS_HEADERS.refEventId]: e.refEventId ?? "",
      [EVENTS_HEADERS.updatedAt]: e.updatedAt ?? nowISO(),
      [EVENTS_HEADERS.chatId]: e.chatId ? String(e.chatId) : "",

      [EVENTS_HEADERS.ts]: e.ts,
      [EVENTS_HEADERS.date]: e.date,
      [EVENTS_HEADERS.foremanTgId]: e.foremanTgId,
      [EVENTS_HEADERS.type]: e.type,
      [EVENTS_HEADERS.objectId]: e.objectId ?? "",
      [EVENTS_HEADERS.carId]: e.carId ?? "",
      [EVENTS_HEADERS.employeeIds]: e.employeeIds ?? "",
      [EVENTS_HEADERS.payload]: e.payload ?? "",
      [EVENTS_HEADERS.msgId]: e.msgId ? String(e.msgId) : "",
    })
  );

  await appendRows(SHEET_NAMES.events, rows, "USER_ENTERED");
clearEventsSheetCache();
}

export async function appendPayrollRows(rows: any[][]) {
  if (!rows.length) return;

  await appendRows("БУХГАЛТЕРСЬКИЙ ЗВІТ", rows, "USER_ENTERED");
}

export async function appendReports(reports: ReportRow[]) {
  if (!reports.length) return;

  const { headers, map } = await getHeaderMap(SHEET_NAMES.reports);

requireHeaders(
  map,
  [
    REPORTS_HEADERS.date,
    REPORTS_HEADERS.objectId,
    REPORTS_HEADERS.foremanTgId,
    REPORTS_HEADERS.workId,
    REPORTS_HEADERS.workName,
    REPORTS_HEADERS.volume,
    REPORTS_HEADERS.volumeStatus,
    REPORTS_HEADERS.photos,
    REPORTS_HEADERS.dayStatus,
    REPORTS_HEADERS.createdAt, 
    REPORTS_HEADERS.updatedAt,
  ],
  SHEET_NAMES.reports
);


  const rows = reports.map((r) =>
buildRowByHeaders(headers, map, {
  [REPORTS_HEADERS.date]: r.date,
  [REPORTS_HEADERS.objectId]: r.objectId,
  [REPORTS_HEADERS.foremanTgId]: String(r.foremanTgId),
  [REPORTS_HEADERS.workId]: r.workId,
  [REPORTS_HEADERS.workName]: r.workName,
  [REPORTS_HEADERS.volume]: r.volume ?? "",
  [REPORTS_HEADERS.volumeStatus]: r.volumeStatus,
  [REPORTS_HEADERS.photos]: r.photos ?? "",
  [REPORTS_HEADERS.dayStatus]: r.dayStatus,
  [REPORTS_HEADERS.createdAt]: r.createdAt ?? nowISO(), 
  [REPORTS_HEADERS.updatedAt]: r.updatedAt ?? nowISO(),
})

  );

  await appendRows(SHEET_NAMES.reports, rows, "USER_ENTERED");
}

/**
 * ======================
 *  EVENTS: UPSERT/UPDATE
 * ======================
 */

export async function upsertEvent(e: EventRow) {
  const updatedAt = e.updatedAt ?? nowISO();

  if (!e.eventId) throw new Error("❌ ПОДІЯ_ID (eventId) обовʼязковий");
  if (!e.status) throw new Error("❌ СТАТУС (status) обовʼязковий");

  const result = await upsertRowByKeys(
    SHEET_NAMES.events,
    { [EVENTS_HEADERS.eventId]: e.eventId },
    {
      [EVENTS_HEADERS.status]: e.status,
      [EVENTS_HEADERS.refEventId]: e.refEventId ?? "",
      [EVENTS_HEADERS.updatedAt]: updatedAt,
      [EVENTS_HEADERS.chatId]: e.chatId ?? "",

      [EVENTS_HEADERS.ts]: e.ts,
      [EVENTS_HEADERS.date]: e.date,
      [EVENTS_HEADERS.foremanTgId]: e.foremanTgId,
      [EVENTS_HEADERS.type]: e.type,
      [EVENTS_HEADERS.objectId]: e.objectId ?? "",
      [EVENTS_HEADERS.carId]: e.carId ?? "",
      [EVENTS_HEADERS.employeeIds]: e.employeeIds ?? "",
      [EVENTS_HEADERS.payload]: e.payload ?? "",
      [EVENTS_HEADERS.msgId]: e.msgId ?? "",
    }
  );
  clearEventsSheetCache();
  return result;
}



export async function updateEventById(
  eventId: string,
  patch: Partial<Pick<EventRow, "status" | "refEventId" | "payload" | "updatedAt" | "msgId">>
) {
  const updatedAt = patch.updatedAt ?? nowISO();

  const p: Record<string, any> = { [EVENTS_HEADERS.updatedAt]: updatedAt };
  if (patch.status) p[EVENTS_HEADERS.status] = patch.status;
  if (patch.refEventId !== undefined) p[EVENTS_HEADERS.refEventId] = patch.refEventId ?? "";
  if (patch.payload !== undefined) p[EVENTS_HEADERS.payload] = patch.payload ?? "";
  if (patch.msgId !== undefined) p[EVENTS_HEADERS.msgId] = patch.msgId ?? "";

  const result = await upsertRowByKeys(SHEET_NAMES.events, { [EVENTS_HEADERS.eventId]: eventId }, p);
  clearEventsSheetCache();
  return result;
}

/**
 * ======================
 *  WORKING SHEETS: UPSERT
 * ======================
 */

export async function upsertDayStatus(row: DayStatusRow) {
  const updatedAt = row.updatedAt ?? nowISO();

  return upsertRowByKeys(
    SHEET_NAMES.dayStatus,
    {
      [DAY_STATUS_HEADERS.date]: row.date,
      [DAY_STATUS_HEADERS.objectId]: row.objectId,
      [DAY_STATUS_HEADERS.foremanTgId]: row.foremanTgId,
    },
    {
      [DAY_STATUS_HEADERS.status]: row.status,

      [DAY_STATUS_HEADERS.hasTimesheet]: row.hasTimesheet ? "так" : "ні",
      [DAY_STATUS_HEADERS.hasReports]: row.hasReports ? "так" : "ні",

      // ✅ нове
      [DAY_STATUS_HEADERS.hasReportsVolumeOk]: row.hasReportsVolumeOk ? "так" : "ні",

      [DAY_STATUS_HEADERS.hasRoad]: row.hasRoad ? "так" : "ні",
      [DAY_STATUS_HEADERS.hasOdoStart]: row.hasOdoStart ? "так" : "ні",
      [DAY_STATUS_HEADERS.hasOdoEnd]: row.hasOdoEnd ? "так" : "ні",

      // ✅ нове
      [DAY_STATUS_HEADERS.hasOdoStartPhoto]: row.hasOdoStartPhoto ? "так" : "ні",
      [DAY_STATUS_HEADERS.hasOdoEndPhoto]: row.hasOdoEndPhoto ? "так" : "ні",

      [DAY_STATUS_HEADERS.hasLogistics]: row.hasLogistics ? "так" : "ні",
      [DAY_STATUS_HEADERS.hasMaterials]: row.hasMaterials ? "так" : "ні",

      [DAY_STATUS_HEADERS.returnReason]: row.returnReason ?? "",
      [DAY_STATUS_HEADERS.approvedBy]: row.approvedBy ?? "",
      [DAY_STATUS_HEADERS.approvedAt]: row.approvedAt ?? "",
      [DAY_STATUS_HEADERS.updatedAt]: updatedAt,
    }
  );
}


export async function upsertOdometerDay(row: OdometerDayRow) {
  const updatedAt = row.updatedAt ?? nowISO();

  const km =
    typeof row.kmDay === "number"
      ? row.kmDay
      : typeof row.startValue === "number" && typeof row.endValue === "number"
        ? row.endValue - row.startValue
        : undefined;

  const tripClass =
    row.tripClass ??
    (typeof km === "number" ? classifyTripByKm(km) : undefined);


  return upsertRowByKeys(
    SHEET_NAMES.odometerDay,
    {
      [ODOMETER_HEADERS.date]: row.date,
      [ODOMETER_HEADERS.carId]: row.carId,
      [ODOMETER_HEADERS.foremanTgId]: row.foremanTgId,
    },
    {
      [ODOMETER_HEADERS.startValue]: row.startValue ?? "",
      [ODOMETER_HEADERS.startPhoto]: row.startPhoto ?? "",
      [ODOMETER_HEADERS.endValue]: row.endValue ?? "",
      [ODOMETER_HEADERS.endPhoto]: row.endPhoto ?? "",
      [ODOMETER_HEADERS.kmDay]: typeof km === "number" ? km : "",
      [ODOMETER_HEADERS.tripClass]: tripClass ?? "",
      [ODOMETER_HEADERS.updatedAt]: updatedAt,
    }
  );
}

export async function upsertTimesheetRow(row: TimesheetRow) {
  const updatedAt = row.updatedAt ?? nowISO();

  return upsertRowByKeys(
    SHEET_NAMES.timesheet,
    {
      [TIMESHEET_HEADERS.date]: row.date,
      [TIMESHEET_HEADERS.objectId]: row.objectId,
      [TIMESHEET_HEADERS.employeeId]: row.employeeId,
    },
    {
      [TIMESHEET_HEADERS.employeeName]: row.employeeName,
      [TIMESHEET_HEADERS.hours]: row.hours,
      [TIMESHEET_HEADERS.source]: row.source,
      [TIMESHEET_HEADERS.disciplineCoef]: row.disciplineCoef ?? "",
      [TIMESHEET_HEADERS.productivityCoef]: row.productivityCoef ?? "",
      [TIMESHEET_HEADERS.updatedAt]: updatedAt,
    }
  );
}

export async function upsertTimesheetRows(rows: TimesheetRow[]) {
  for (const r of rows) await upsertTimesheetRow(r);
}

export async function upsertAllowanceRow(row: AllowanceRow) {
  const updatedAt = row.updatedAt ?? nowISO();

  const objectIdKey = (row.objectId ?? "").trim(); // для ROAD роби "" (див нижче)
  const employeeIdKey = String(row.employeeId ?? "").trim();

  if (!row.date) throw new Error("ALLOWANCE: date is required");
  if (!row.foremanTgId) throw new Error("ALLOWANCE: foremanTgId is required");
  if (!row.type) throw new Error("ALLOWANCE: type is required");
  if (!employeeIdKey) throw new Error("ALLOWANCE: employeeId is required");

  return upsertRowByKeys(
    SHEET_NAMES.allowances,
    {
      [ALLOWANCES_HEADERS.date]: row.date,
      [ALLOWANCES_HEADERS.foremanTgId]: row.foremanTgId,
      [ALLOWANCES_HEADERS.type]: row.type,
      [ALLOWANCES_HEADERS.employeeId]: row.employeeId,
      [ALLOWANCES_HEADERS.objectId]: row.objectId ?? "",
    },
    {
      [ALLOWANCES_HEADERS.employeeName]: row.employeeName,
      [ALLOWANCES_HEADERS.amount]: row.amount,
      [ALLOWANCES_HEADERS.meta]: row.meta ?? "",
      [ALLOWANCES_HEADERS.dayStatus]: row.dayStatus,
      [ALLOWANCES_HEADERS.updatedAt]: updatedAt,
    }
  );
}

export async function upsertAllowanceRows(rows: AllowanceRow[]) {
  for (const r of rows) await upsertAllowanceRow(r);
}

export async function upsertClosure(row: ClosureRow) {
  return upsertRowByKeys(
    SHEET_NAMES.closures,
    {
      [CLOSURES_HEADERS.date]: row.date,
      [CLOSURES_HEADERS.objectId]: row.objectId,
      [CLOSURES_HEADERS.foremanTgId]: row.foremanTgId,
    },
    {
      [CLOSURES_HEADERS.submittedAt]: row.submittedAt,
      [CLOSURES_HEADERS.submittedBy]: row.submittedBy,
      [CLOSURES_HEADERS.comment]: row.comment ?? "",
    }
  );
}

export async function appendMaterialMoves(rows: MaterialMoveRow[]) {
  if (!rows.length) return;

  const { headers, map } = await getHeaderMap(SHEET_NAMES.materialsMove);
  requireHeaders(map, Object.values(MATERIALS_MOVE_HEADERS), SHEET_NAMES.materialsMove);

  const now = nowISO();
  const sheetRows = rows.map((r) =>
    buildRowByHeaders(headers, map, {
      [MATERIALS_MOVE_HEADERS.moveId]: r.moveId,
      [MATERIALS_MOVE_HEADERS.time]: r.time,
      [MATERIALS_MOVE_HEADERS.date]: r.date,
      [MATERIALS_MOVE_HEADERS.objectId]: r.objectId,
      [MATERIALS_MOVE_HEADERS.foremanTgId]: String(r.foremanTgId),

      [MATERIALS_MOVE_HEADERS.materialId]: r.materialId,
      [MATERIALS_MOVE_HEADERS.materialName]: r.materialName,
      [MATERIALS_MOVE_HEADERS.qty]: r.qty == null ? "" : String(r.qty),
      [MATERIALS_MOVE_HEADERS.unit]: r.unit,
      [MATERIALS_MOVE_HEADERS.moveType]: r.moveType,

      [MATERIALS_MOVE_HEADERS.purpose]: r.purpose ?? "",
      [MATERIALS_MOVE_HEADERS.photos]: r.photos ?? "",
      [MATERIALS_MOVE_HEADERS.payload]: r.payload ?? "",
      [MATERIALS_MOVE_HEADERS.dayStatus]: r.dayStatus ?? "",
      [MATERIALS_MOVE_HEADERS.updatedAt]: r.updatedAt ?? now,
    })
  );

  await appendRows(SHEET_NAMES.materialsMove, sheetRows, "USER_ENTERED");
}

export async function appendToolMoves(rows: ToolMoveRow[]) {
  if (!rows.length) return;

  const { headers, map } = await getHeaderMap(SHEET_NAMES.toolsMove);
  requireHeaders(map, Object.values(TOOLS_MOVE_HEADERS), SHEET_NAMES.toolsMove);

  const now = nowISO();
  const sheetRows = rows.map((r) =>
    buildRowByHeaders(headers, map, {
      [TOOLS_MOVE_HEADERS.moveId]: r.moveId,
      [TOOLS_MOVE_HEADERS.time]: r.time,
      [TOOLS_MOVE_HEADERS.date]: r.date,
      [TOOLS_MOVE_HEADERS.foremanTgId]: String(r.foremanTgId),

      [TOOLS_MOVE_HEADERS.toolId]: r.toolId,
      [TOOLS_MOVE_HEADERS.toolName]: r.toolName,
      [TOOLS_MOVE_HEADERS.qty]: String(r.qty),
      [TOOLS_MOVE_HEADERS.moveType]: r.moveType,

      [TOOLS_MOVE_HEADERS.purpose]: r.purpose ?? "",
      [TOOLS_MOVE_HEADERS.photos]: r.photos ?? "",
      [TOOLS_MOVE_HEADERS.payload]: r.payload ?? "",
      [TOOLS_MOVE_HEADERS.updatedAt]: r.updatedAt ?? now,
    })
  );

  await appendRows(SHEET_NAMES.toolsMove, sheetRows, "USER_ENTERED");
}


export async function getEventById(eventId: string): Promise<EventRow | null> {
  if (!eventId) return null;

  const { map, data } = await loadEventsSheetCached();

  requireHeaders(
    map,
    [
      EVENTS_HEADERS.eventId,
      EVENTS_HEADERS.ts,
      EVENTS_HEADERS.date,
      EVENTS_HEADERS.foremanTgId,
      EVENTS_HEADERS.type,
      EVENTS_HEADERS.status,
      EVENTS_HEADERS.objectId,
      EVENTS_HEADERS.carId,
      EVENTS_HEADERS.employeeIds,
      EVENTS_HEADERS.payload,
      EVENTS_HEADERS.chatId,
      EVENTS_HEADERS.msgId,
      EVENTS_HEADERS.refEventId,
      EVENTS_HEADERS.updatedAt,
    ],
    SHEET_NAMES.events
  );

  const idx = (h: string) => {
    const i = map[h];
    if (typeof i !== "number") throw new Error(`Missing header "${h}" in sheet "${SHEET_NAMES.events}"`);
    return i;
  };

  const s = (v: unknown) => String(v ?? "").trim();

  for (const row of data) {
    if (!row) continue;
    if (s(row[idx(EVENTS_HEADERS.eventId)]) !== eventId) continue;

    return {
      eventId: s(row[idx(EVENTS_HEADERS.eventId)]),
      ts: s(row[idx(EVENTS_HEADERS.ts)]),
      date: s(row[idx(EVENTS_HEADERS.date)]),
      foremanTgId: Number(s(row[idx(EVENTS_HEADERS.foremanTgId)]) || 0),
      type: s(row[idx(EVENTS_HEADERS.type)]),

      status: s(row[idx(EVENTS_HEADERS.status)]) as EventRow["status"],
      objectId: s(row[idx(EVENTS_HEADERS.objectId)]),
      carId: s(row[idx(EVENTS_HEADERS.carId)]),
      employeeIds: s(row[idx(EVENTS_HEADERS.employeeIds)]),
      payload: s(row[idx(EVENTS_HEADERS.payload)]),

      chatId: Number(s(row[idx(EVENTS_HEADERS.chatId)]) || 0),
      msgId: Number(s(row[idx(EVENTS_HEADERS.msgId)]) || 0),
      refEventId: s(row[idx(EVENTS_HEADERS.refEventId)]),
      updatedAt: s(row[idx(EVENTS_HEADERS.updatedAt)]),
    };
  }

  return null;
}

/**
 * editEventByIdWithLog: “правильний” edit:
 * - тягнемо before
 * - робимо updateEventById(...)
 * - рахуємо after (merge before+patch)
 * - пишемо edit log (обов’язково)
 * 
 * 
 * 
 */


export async function appendRoadTimelineEvent(args: {
  date: string;
  foremanTgId: number;
  type: "ROAD_START" | "ROAD_ADD" | "ROAD_REMOVE" | "ROAD_END";
  carId: string;
  employeeIds: string[];   // поточний склад
  payload?: any;
  chatId?: number;
  msgId?: number;
}) {
  const now = nowISO();

  await appendEvents([{
    eventId: makeEventId("ROAD"),
    ts: now,
    date: args.date,
    foremanTgId: args.foremanTgId,
    type: args.type,
    status: "АКТИВНА",

    objectId: "",           // ⚠️ важливо
    carId: args.carId,
    employeeIds: args.employeeIds.join(","),

    payload: JSON.stringify(args.payload ?? {}),
    chatId: args.chatId ?? 0,
    msgId: args.msgId ?? 0,
    refEventId: "",
    updatedAt: now,
  }]);
}

function parseCsvIds(s?: string): string[] {
  return String(s ?? "")
    .split(",")
    .map(x => x.trim())
    .filter(Boolean);
}

export type EditLogRow = {
  editId: string;
  ts: string;
  editorTgId: number;

  entity: "EVENT" | "REPORT" | "DAY_STATUS" | "ODOMETER" | "TIMESHEET" | "ALLOWANCE" | "MATERIAL_MOVE" | "TOOL_MOVE";
  entityId: string;

  date?: string;
  objectId?: string;
  foremanTgId?: number;

  patchJson: string;
  beforeJson: string;
  afterJson: string;

  reason: string;

  chatId?: number;
  msgId?: number;
};

export async function appendEditLog(rows: EditLogRow[]) {
  if (!rows.length) return;

  const { headers, map } = await getHeaderMap(SHEET_NAMES.editLog);
  requireHeaders(map, Object.values(EDIT_LOG_HEADERS), SHEET_NAMES.editLog);

  const now = nowISO();

  const sheetRows = rows.map((r) =>
    buildRowByHeaders(headers, map, {
      [EDIT_LOG_HEADERS.editId]: r.editId,
      [EDIT_LOG_HEADERS.ts]: r.ts || now,
      [EDIT_LOG_HEADERS.editorTgId]: String(r.editorTgId),

      [EDIT_LOG_HEADERS.entity]: r.entity,
      [EDIT_LOG_HEADERS.entityId]: r.entityId,

      [EDIT_LOG_HEADERS.date]: r.date ?? "",
      [EDIT_LOG_HEADERS.objectId]: r.objectId ?? "",
      [EDIT_LOG_HEADERS.foremanTgId]: r.foremanTgId != null ? String(r.foremanTgId) : "",

      [EDIT_LOG_HEADERS.patchJson]: r.patchJson ?? "",
      [EDIT_LOG_HEADERS.beforeJson]: r.beforeJson ?? "",
      [EDIT_LOG_HEADERS.afterJson]: r.afterJson ?? "",

      [EDIT_LOG_HEADERS.reason]: r.reason ?? "",

      [EDIT_LOG_HEADERS.chatId]: r.chatId != null ? String(r.chatId) : "",
      [EDIT_LOG_HEADERS.msgId]: r.msgId != null ? String(r.msgId) : "",
    })
  );

  await appendRows(SHEET_NAMES.editLog, sheetRows, "USER_ENTERED");
}

function applyPatch<T extends Record<string, any>>(base: T, patch: Partial<T>): T {
  const out: any = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

export async function fetchReportsForPayroll(args: {
  date: string;
  foremanTgId: number;
  objectId: string;
}) {
  const { map, data } = await loadSheet(SHEET_NAMES.reports, "A:Z");

  const rows: any[] = [];

  for (const row of data) {
    const date = getCell(row, map, REPORTS_HEADERS.date);
    const objectId = getCell(row, map, REPORTS_HEADERS.objectId);
    const foremanTgId = Number(
      getCell(row, map, REPORTS_HEADERS.foremanTgId)
    );

    if (date !== args.date) continue;
    if (objectId !== args.objectId) continue;
    if (foremanTgId !== args.foremanTgId) continue;

    rows.push({
      workName: getCell(row, map, REPORTS_HEADERS.workName),
      volume: getCell(row, map, REPORTS_HEADERS.volume),
    });
  }

  return rows;
}

export async function editEventByIdWithLog(args: {
  eventId: string;
  editorTgId: number;
  reason: string;
  patch: Partial<Pick<EventRow, "status" | "refEventId" | "payload" | "msgId">>;
  chatId?: number;
  msgId?: number;
}) {
  const before = await getEventById(args.eventId);
  if (!before) throw new Error(`EDIT: eventId not found: ${args.eventId}`);

  const updatedAt = nowISO();

  await updateEventById(args.eventId, { ...args.patch, updatedAt });

  const after = applyPatch<EventRow>({ ...before, updatedAt }, args.patch as any);

  await appendEditLog([{
    editId: makeEventId("EDIT"),
    ts: updatedAt,
    editorTgId: args.editorTgId,

    entity: "EVENT",
    entityId: args.eventId,

    date: before.date,
    objectId: before.objectId ?? "",
    foremanTgId: before.foremanTgId,

    patchJson: JSON.stringify(args.patch ?? {}),
    beforeJson: JSON.stringify(before),
    afterJson: JSON.stringify(after),

    reason: (args.reason ?? "").trim() || "—",

chatId: args.chatId ?? 0,
msgId: args.msgId ?? 0,
  }]);

  return { before, after };
}
