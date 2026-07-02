import { nowISO } from "./google/utils.js";
import { upsertRowByKeys, appendRowsByHeaders } from "./google/sheets.js";
import {
  SHEET_NAMES,
  EVENTS_HEADERS,
  ODOMETER_HEADERS,
  ALLOWANCES_HEADERS,
  DAY_STATUS_HEADERS,
  MATERIALS_MOVE_HEADERS,
  TOOLS_MOVE_HEADERS,
} from "./google/names.js";
import { db, schema } from "./db.js";
import { upsertBatch } from "./sync/upsert.js";

type Executor = Pick<typeof db, "insert">;

/**
 * Writers used by the mini-app server. Google Sheets is always written
 * first (source of truth); the same row is then mirrored into Postgres
 * in the same request so the mini-app UI reflects the change instantly,
 * without waiting for the next background sync cycle.
 */

export function makeEventId(prefix = "POD") {
  const rnd = Math.random().toString(36).slice(2, 10);
  return `${prefix}_${Date.now()}_${rnd}`;
}

export type EventInput = {
  eventId: string;
  status: string;
  refEventId?: string;
  chatId?: number | null;
  ts?: string;
  date: string;
  foremanTgId: number;
  type: string;
  objectId?: string;
  carId?: string;
  employeeIds?: string; // JSON array
  payload?: string; // JSON
  msgId?: number;
};

export async function writeEvent(e: EventInput, tx?: Executor) {
  const ts = e.ts ?? nowISO();
  const updatedAt = nowISO();

  await upsertRowByKeys(
    SHEET_NAMES.events,
    { [EVENTS_HEADERS.eventId]: e.eventId },
    {
      [EVENTS_HEADERS.status]: e.status,
      [EVENTS_HEADERS.refEventId]: e.refEventId ?? "",
      [EVENTS_HEADERS.updatedAt]: updatedAt,
      [EVENTS_HEADERS.chatId]: e.chatId ?? "",
      [EVENTS_HEADERS.ts]: ts,
      [EVENTS_HEADERS.date]: e.date,
      [EVENTS_HEADERS.foremanTgId]: e.foremanTgId,
      [EVENTS_HEADERS.type]: e.type,
      [EVENTS_HEADERS.objectId]: e.objectId ?? "",
      [EVENTS_HEADERS.carId]: e.carId ?? "",
      [EVENTS_HEADERS.employeeIds]: e.employeeIds ?? "",
      [EVENTS_HEADERS.payload]: e.payload ?? "",
      [EVENTS_HEADERS.msgId]: e.msgId ?? "",
    },
  );

  await upsertBatch(
    schema.events,
    [
      {
        eventId: e.eventId,
        status: e.status,
        refEventId: e.refEventId ?? null,
        chatId: e.chatId ? BigInt(e.chatId) : null,
        ts: new Date(ts),
        date: e.date,
        foremanTgId: BigInt(e.foremanTgId),
        type: e.type,
        objectId: e.objectId ?? null,
        carId: e.carId ?? null,
        employeeIds: e.employeeIds ?? null,
        payload: e.payload ?? null,
        msgId: e.msgId ?? null,
      },
    ],
    schema.events.eventId,
    ["status", "refEventId", "chatId", "ts", "date", "foremanTgId", "type", "objectId", "carId", "employeeIds", "payload", "msgId"],
    tx,
  );
}

export type OdometerDayInput = {
  date: string;
  carId: string;
  foremanTgId: number;
  startValue?: number;
  startPhoto?: string;
  endValue?: number;
  endPhoto?: string;
};

function classifyTripByKm(km: number): "S" | "M" | "L" | "XL" {
  if (!Number.isFinite(km) || km <= 0) return "S";
  if (km <= 20) return "S";
  if (km <= 50) return "M";
  if (km <= 100) return "L";
  return "XL";
}

export async function writeOdometerDay(row: OdometerDayInput, tx?: Executor) {
  const updatedAt = nowISO();
  const km =
    typeof row.startValue === "number" && typeof row.endValue === "number"
      ? row.endValue - row.startValue
      : undefined;
  const tripClass = typeof km === "number" ? classifyTripByKm(km) : undefined;

  await upsertRowByKeys(
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
    },
  );

  await upsertBatch(
    schema.odometerDays,
    [
      {
        date: row.date,
        carId: row.carId,
        foremanTgId: BigInt(row.foremanTgId),
        startValue: row.startValue ?? null,
        startPhoto: row.startPhoto ?? null,
        endValue: row.endValue ?? null,
        endPhoto: row.endPhoto ?? null,
        kmDay: typeof km === "number" ? km : null,
        tripClass: tripClass ?? null,
      },
    ],
    [schema.odometerDays.date, schema.odometerDays.carId],
    ["foremanTgId", "startValue", "startPhoto", "endValue", "endPhoto", "kmDay", "tripClass"],
    tx,
  );

  return { km, tripClass };
}

export type TimesheetRowInput = {
  date: string;
  objectId: string;
  employeeId: string;
  employeeName: string;
  hours: number;
  source: string;
};

export async function writeTimesheetRows(rows: TimesheetRowInput[], tx?: Executor) {
  for (const row of rows) {
    await upsertRowByKeys(
      SHEET_NAMES.timesheet,
      {
        ["ДАТА"]: row.date,
        ["ОБʼЄКТ_ID"]: row.objectId,
        ["ПРАЦІВНИК_ID"]: row.employeeId,
      },
      {
        ["ІМʼЯ_ПРАЦІВНИКА"]: row.employeeName,
        ["ГОДИНИ"]: row.hours,
        ["ДЖЕРЕЛО"]: row.source,
        ["ОНОВЛЕНО"]: nowISO(),
      },
    );
  }

  await upsertBatch(
    schema.timesheetEntries,
    rows.map((row) => ({
      date: row.date,
      objectId: row.objectId,
      employeeId: row.employeeId,
      employeeName: row.employeeName,
      hours: row.hours,
      source: row.source,
    })),
    [schema.timesheetEntries.date, schema.timesheetEntries.objectId, schema.timesheetEntries.employeeId],
    ["employeeName", "hours", "source"],
    tx,
  );
}

export type ReportRowInput = {
  date: string;
  objectId: string;
  foremanTgId: number;
  workId: string;
  workName: string;
  volume?: string | number;
  volumeStatus: "НЕ_ЗАПОВНЕНО" | "ЗАПОВНЕНО";
  dayStatus: string;
};

export async function writeReports(rows: ReportRowInput[], tx?: Executor) {
  for (const row of rows) {
    // Keyed by date+objectId+workId+foremanTgId (not just date+objectId+workId):
    // two different brigades can legitimately both report volumes for the same
    // work on the same object on the same day, and must not silently overwrite
    // each other's numbers.
    await upsertRowByKeys(
      SHEET_NAMES.reports,
      {
        ["ДАТА"]: row.date,
        ["ОБʼЄКТ_ID"]: row.objectId,
        ["РОБОТА_ID"]: row.workId,
        ["БРИГАДИР_TG_ID"]: row.foremanTgId,
      },
      {
        ["НАЗВА_РОБОТИ"]: row.workName,
        ["ОБСЯГ"]: row.volume ?? "",
        ["СТАТУС_ОБСЯГУ"]: row.volumeStatus,
        ["СТАТУС_ДНЯ"]: row.dayStatus,
        ["ОНОВЛЕНО"]: nowISO(),
      },
    );
  }

  await upsertBatch(
    schema.reports,
    rows.map((row) => ({
      date: row.date,
      objectId: row.objectId,
      foremanTgId: BigInt(row.foremanTgId),
      workId: row.workId,
      workName: row.workName,
      volume: row.volume === undefined ? null : String(row.volume),
      volumeStatus: row.volumeStatus,
      dayStatus: row.dayStatus,
    })),
    [schema.reports.date, schema.reports.objectId, schema.reports.workId, schema.reports.foremanTgId],
    ["workName", "volume", "volumeStatus", "dayStatus"],
    tx,
  );
}

export type DayStatusInput = {
  date: string;
  objectId: string;
  foremanTgId: number;
  status: string;
  hasTimesheet?: boolean;
  hasReports?: boolean;
  hasReportsVolumeOk?: boolean;
  hasRoad?: boolean;
  hasOdoStart?: boolean;
  hasOdoEnd?: boolean;
  hasLogistics?: boolean;
  hasMaterials?: boolean;
};

export async function writeDayStatus(row: DayStatusInput, tx?: Executor) {
  const yn = (b?: boolean) => (b ? "так" : "ні");

  await upsertRowByKeys(
    SHEET_NAMES.dayStatus,
    {
      [DAY_STATUS_HEADERS.date]: row.date,
      [DAY_STATUS_HEADERS.objectId]: row.objectId,
      [DAY_STATUS_HEADERS.foremanTgId]: row.foremanTgId,
    },
    {
      [DAY_STATUS_HEADERS.status]: row.status,
      [DAY_STATUS_HEADERS.hasTimesheet]: yn(row.hasTimesheet),
      [DAY_STATUS_HEADERS.hasReports]: yn(row.hasReports),
      [DAY_STATUS_HEADERS.hasReportsVolumeOk]: yn(row.hasReportsVolumeOk),
      [DAY_STATUS_HEADERS.hasRoad]: yn(row.hasRoad),
      [DAY_STATUS_HEADERS.hasOdoStart]: yn(row.hasOdoStart),
      [DAY_STATUS_HEADERS.hasOdoEnd]: yn(row.hasOdoEnd),
      [DAY_STATUS_HEADERS.hasLogistics]: yn(row.hasLogistics),
      [DAY_STATUS_HEADERS.hasMaterials]: yn(row.hasMaterials),
      [DAY_STATUS_HEADERS.updatedAt]: nowISO(),
    },
  );

  await upsertBatch(
    schema.dayStatuses,
    [
      {
        date: row.date,
        objectId: row.objectId,
        foremanTgId: BigInt(row.foremanTgId),
        status: row.status,
        hasTimesheet: !!row.hasTimesheet,
        hasReports: !!row.hasReports,
        hasReportsVolumeOk: !!row.hasReportsVolumeOk,
        hasRoad: !!row.hasRoad,
        hasOdoStart: !!row.hasOdoStart,
        hasOdoEnd: !!row.hasOdoEnd,
        hasLogistics: !!row.hasLogistics,
        hasMaterials: !!row.hasMaterials,
      },
    ],
    [schema.dayStatuses.date, schema.dayStatuses.objectId, schema.dayStatuses.foremanTgId],
    [
      "status",
      "hasTimesheet",
      "hasReports",
      "hasReportsVolumeOk",
      "hasRoad",
      "hasOdoStart",
      "hasOdoEnd",
      "hasLogistics",
      "hasMaterials",
    ],
    tx,
  );
}

export type AllowanceInput = {
  date: string;
  objectId?: string; // "" for trip-level allowances like ROAD_TRIP, matches the bot exactly
  foremanTgId: number;
  type: string;
  employeeId: string;
  employeeName: string;
  amount: number;
  meta?: string;
  dayStatus?: string;
};

/** Mirrors the bot's upsertAllowanceRow: keyed by date+foremanTgId+type+employeeId+objectId. */
export async function writeAllowanceRows(rows: AllowanceInput[], tx?: Executor) {
  for (const row of rows) {
    await upsertRowByKeys(
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
        [ALLOWANCES_HEADERS.dayStatus]: row.dayStatus ?? "ЧЕРНЕТКА",
        [ALLOWANCES_HEADERS.updatedAt]: nowISO(),
      },
    );
  }

  await upsertBatch(
    schema.allowances,
    rows.map((row) => ({
      date: row.date,
      objectId: row.objectId ?? "",
      foremanTgId: BigInt(row.foremanTgId),
      type: row.type,
      employeeId: row.employeeId,
      employeeName: row.employeeName,
      amount: row.amount,
      meta: row.meta ?? null,
      dayStatus: row.dayStatus ?? "ЧЕРНЕТКА",
    })),
    [schema.allowances.date, schema.allowances.foremanTgId, schema.allowances.type, schema.allowances.employeeId, schema.allowances.objectId],
    ["employeeName", "amount", "meta", "dayStatus"],
    tx,
  );
}

export type MaterialMoveInput = {
  date: string;
  objectId: string;
  foremanTgId: number;
  materialId: string;
  materialName: string;
  qty: number;
  unit: string;
  moveType: "ISSUE" | "RETURN" | "WRITEOFF" | "ADJUST";
  purpose?: string;
};

export async function writeMaterialMoves(rows: MaterialMoveInput[]) {
  if (!rows.length) return;
  const now = nowISO();

  const sheetRows = rows.map((r) => {
    const moveId = `MMV_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    return {
      moveId,
      time: now,
      date: r.date,
      objectId: r.objectId,
      foremanTgId: r.foremanTgId,
      materialId: r.materialId,
      materialName: r.materialName,
      qty: r.qty,
      unit: r.unit,
      moveType: r.moveType,
      purpose: r.purpose ?? "",
    };
  });

  await appendRowsByHeaders(
    SHEET_NAMES.materialsMove,
    sheetRows.map((r) => ({
      [MATERIALS_MOVE_HEADERS.moveId]: r.moveId,
      [MATERIALS_MOVE_HEADERS.time]: r.time,
      [MATERIALS_MOVE_HEADERS.date]: r.date,
      [MATERIALS_MOVE_HEADERS.objectId]: r.objectId,
      [MATERIALS_MOVE_HEADERS.foremanTgId]: String(r.foremanTgId),
      [MATERIALS_MOVE_HEADERS.materialId]: r.materialId,
      [MATERIALS_MOVE_HEADERS.materialName]: r.materialName,
      [MATERIALS_MOVE_HEADERS.qty]: r.qty,
      [MATERIALS_MOVE_HEADERS.unit]: r.unit,
      [MATERIALS_MOVE_HEADERS.moveType]: r.moveType,
      [MATERIALS_MOVE_HEADERS.purpose]: r.purpose,
      [MATERIALS_MOVE_HEADERS.dayStatus]: "ЧЕРНЕТКА",
      [MATERIALS_MOVE_HEADERS.updatedAt]: now,
    })),
  );

  await upsertBatch(
    schema.materialMoves,
    sheetRows.map((r) => ({
      moveId: r.moveId,
      time: r.time,
      date: r.date,
      objectId: r.objectId,
      foremanTgId: BigInt(r.foremanTgId),
      materialId: r.materialId,
      materialName: r.materialName,
      qty: r.qty,
      unit: r.unit,
      moveType: r.moveType,
      purpose: r.purpose,
      dayStatus: "ЧЕРНЕТКА",
    })),
    schema.materialMoves.moveId,
    ["time", "date", "objectId", "foremanTgId", "materialId", "materialName", "qty", "unit", "moveType", "purpose", "dayStatus"],
  );

  return sheetRows;
}
