import { SHEET_NAMES } from "./names.js";
import type { DayStatusRow, DayChecklist } from "./types.js";
import {
  DAY_STATUS_HEADERS,
  ODOMETER_HEADERS,
  REPORTS_HEADERS,
  TIMESHEET_HEADERS,
  EVENTS_HEADERS,
  ALLOWANCES_HEADERS,
  MATERIALS_MOVE_HEADERS,      
} from "./headers.js";

import { loadSheet, getCell, requireHeaders } from "./core.js";
import { parseNumber } from "./utils.js";
import { upsertDayStatus } from "./working.js";

export async function getDayStatusRow(date: string, objectId: string, foremanTgId: number): Promise<DayStatusRow | null> {
  const sh = await loadSheet(SHEET_NAMES.dayStatus);

  

requireHeaders(
  sh.map,
  [
    DAY_STATUS_HEADERS.date,
    DAY_STATUS_HEADERS.objectId,
    DAY_STATUS_HEADERS.foremanTgId,
    DAY_STATUS_HEADERS.status,

    // ✅ NEW:
    DAY_STATUS_HEADERS.returnReason,
    DAY_STATUS_HEADERS.approvedBy,
    DAY_STATUS_HEADERS.approvedAt,
    DAY_STATUS_HEADERS.updatedAt,
  ],
  SHEET_NAMES.dayStatus
);

  const found = sh.data.find((r) => {
    const d = getCell(r, sh.map, DAY_STATUS_HEADERS.date);
    const o = getCell(r, sh.map, DAY_STATUS_HEADERS.objectId);
    const f = getCell(r, sh.map, DAY_STATUS_HEADERS.foremanTgId);
    return d === date && o === objectId && String(f) === String(foremanTgId);
  });

  if (!found) return null;

  // якщо колонок/флагів ще нема — не впадемо, просто буде дефолт
  const status = (getCell(found, sh.map, DAY_STATUS_HEADERS.status) || "ЧЕРНЕТКА") as DayStatusRow["status"];

const yesNo = (v: unknown) => String(v ?? "").trim().toLowerCase() === "так";
const hasCol = (h: string) => sh.map[h] !== undefined;

return {
  date,
  objectId,
  foremanTgId,
  status,

  hasTimesheet: hasCol(DAY_STATUS_HEADERS.hasTimesheet) ? yesNo(getCell(found, sh.map, DAY_STATUS_HEADERS.hasTimesheet)) : false,
  hasReports: hasCol(DAY_STATUS_HEADERS.hasReports) ? yesNo(getCell(found, sh.map, DAY_STATUS_HEADERS.hasReports)) : false,
  hasRoad: hasCol(DAY_STATUS_HEADERS.hasRoad) ? yesNo(getCell(found, sh.map, DAY_STATUS_HEADERS.hasRoad)) : false,

  hasOdoStart: hasCol(DAY_STATUS_HEADERS.hasOdoStart) ? yesNo(getCell(found, sh.map, DAY_STATUS_HEADERS.hasOdoStart)) : false,
  hasOdoEnd: hasCol(DAY_STATUS_HEADERS.hasOdoEnd) ? yesNo(getCell(found, sh.map, DAY_STATUS_HEADERS.hasOdoEnd)) : false,

  hasOdoStartPhoto: hasCol(DAY_STATUS_HEADERS.hasOdoStartPhoto) ? yesNo(getCell(found, sh.map, DAY_STATUS_HEADERS.hasOdoStartPhoto)) : false,
  hasOdoEndPhoto: hasCol(DAY_STATUS_HEADERS.hasOdoEndPhoto) ? yesNo(getCell(found, sh.map, DAY_STATUS_HEADERS.hasOdoEndPhoto)) : false,

  hasLogistics: hasCol(DAY_STATUS_HEADERS.hasLogistics) ? yesNo(getCell(found, sh.map, DAY_STATUS_HEADERS.hasLogistics)) : false,
  hasMaterials: hasCol(DAY_STATUS_HEADERS.hasMaterials) ? yesNo(getCell(found, sh.map, DAY_STATUS_HEADERS.hasMaterials)) : false,
  hasReportsVolumeOk: hasCol(DAY_STATUS_HEADERS.hasReportsVolumeOk) ? yesNo(getCell(found, sh.map, DAY_STATUS_HEADERS.hasReportsVolumeOk)) : false,

  returnReason: hasCol(DAY_STATUS_HEADERS.returnReason) ? getCell(found, sh.map, DAY_STATUS_HEADERS.returnReason) : "",
  approvedBy: hasCol(DAY_STATUS_HEADERS.approvedBy) ? getCell(found, sh.map, DAY_STATUS_HEADERS.approvedBy) : "",
  approvedAt: hasCol(DAY_STATUS_HEADERS.approvedAt) ? getCell(found, sh.map, DAY_STATUS_HEADERS.approvedAt) : "",
  updatedAt: hasCol(DAY_STATUS_HEADERS.updatedAt) ? getCell(found, sh.map, DAY_STATUS_HEADERS.updatedAt) : "",
};

}

export async function getDayStatus(date: string, objectId: string, foremanTgId: number) {
  return getDayStatusRow(date, objectId, foremanTgId);
}

async function hasReportsForDay(date: string, objectId: string, foremanTgId: number) {
  const sh = await loadSheet(SHEET_NAMES.reports);
  requireHeaders(
    sh.map,
    [REPORTS_HEADERS.date, REPORTS_HEADERS.objectId, REPORTS_HEADERS.foremanTgId],
    SHEET_NAMES.reports
  );

  return sh.data.some((r) => {
    const d = getCell(r, sh.map, REPORTS_HEADERS.date);
    const o = getCell(r, sh.map, REPORTS_HEADERS.objectId);
    const f = getCell(r, sh.map, REPORTS_HEADERS.foremanTgId);
    return d === date && o === objectId && String(f) === String(foremanTgId);
  });
}

async function hasTimesheetForDay(date: string, objectId: string) {
  const sh = await loadSheet(SHEET_NAMES.timesheet);
  requireHeaders(sh.map, [TIMESHEET_HEADERS.date, TIMESHEET_HEADERS.objectId, TIMESHEET_HEADERS.hours], SHEET_NAMES.timesheet);

  return sh.data.some((r) => {
    const d = getCell(r, sh.map, TIMESHEET_HEADERS.date);
    const o = getCell(r, sh.map, TIMESHEET_HEADERS.objectId);
    const h = parseNumber(getCell(r, sh.map, TIMESHEET_HEADERS.hours));
    return d === date && o === objectId && h > 0;
  });
}

function safeJson<T>(s?: string): T | null {
  const str = String(s ?? "").trim();
  if (!str) return null;
  try { return JSON.parse(str) as T; } catch { return null; }
}

function matchesObject(r: any, objectId: string, sh: any): boolean {
  const o = String(getCell(r, sh.map, EVENTS_HEADERS.objectId) ?? "").trim();
  if (o && o === objectId) return true;

  // timeline event: objectId="", objects in payload
  if (!o) {
    const p = safeJson<{ objectIds?: string[] }>(getCell(r, sh.map, EVENTS_HEADERS.payload));
    const ids = (p?.objectIds ?? []).map(x => String(x).trim()).filter(Boolean);
    return ids.includes(objectId);
  }

  return false;
}


async function getRoadFlagsFromEvents(date: string, objectId: string, foremanTgId: number) {
  const sh = await loadSheet(SHEET_NAMES.events);

  requireHeaders(
    sh.map,
    [
      EVENTS_HEADERS.date,
      EVENTS_HEADERS.objectId,
      EVENTS_HEADERS.foremanTgId,
      EVENTS_HEADERS.type,
      EVENTS_HEADERS.status,
      EVENTS_HEADERS.payload,
    ],
    SHEET_NAMES.events
  );

const rows = sh.data.filter((r) => {
  const d = getCell(r, sh.map, EVENTS_HEADERS.date);
  const f = getCell(r, sh.map, EVENTS_HEADERS.foremanTgId);
  const st = getCell(r, sh.map, EVENTS_HEADERS.status);

  return (
    d === date &&
    String(f) === String(foremanTgId) &&
    st === "АКТИВНА" &&
    matchesObject(r, objectId, sh)
  );
});


  const byType = (t: string) => rows.filter((r) => getCell(r, sh.map, EVENTS_HEADERS.type) === t);

  const startRows = byType("ODO_START");
  const endRows   = byType("ODO_END");

  // маркер, що "дорога завершена/зафіксована"
  const roadEndRows  = byType("ROAD_END");
  const roadSaveRows = byType("ROAD_SAVE"); // або ROAD_SAVED якщо так назвеш

  // фото беремо з payload.odoPhoto (ти саме так пишеш)
  const hasPhoto = (rs: any[]) =>
    rs.some((r) => {
      try {
        const p = JSON.parse(getCell(r, sh.map, EVENTS_HEADERS.payload) || "{}");
        return String(p?.odoPhoto || "").trim() !== "";
      } catch { return false; }
    });

const hasOdoStart = startRows.length > 0;
  const hasOdoEnd   = endRows.length > 0;

  return {
    hasOdoStart,
    hasOdoEnd,
    hasOdoStartPhoto: hasPhoto(startRows),
    hasOdoEndPhoto: hasPhoto(endRows),

    // ✅ дорога є тільки якщо її ЗАВЕРШИЛИ/ЗБЕРЕГЛИ
    hasRoad: roadSaveRows.length > 0 || roadEndRows.length > 0,
  };
}

/**
 * Рахує чеклист (✅/❌) по наявним листам
 * і оновлює рядок в СТАТУС_ДНЯ.
 */

export async function computeChecklist(
  date: string,
  objectId: string,
  foremanTgId: number
): Promise<DayChecklist> {
  const checklist: DayChecklist = {
    hasTimesheet: false,
    hasReports: false,

    // нові/уточнені прапорці
    hasReportsMissingQty: false,
    hasReportsVolumeOk: false,   // якщо є reports і є хоч 1 НЕ_ЗАПОВНЕНО → стане false
    hasRoad: false,

    hasOdoStart: false,
    hasOdoEnd: false,
    hasOdoStartPhoto: false,
    hasOdoEndPhoto: false,

    hasLogistics: false,
    hasMaterials: false,
  };

  // TIMESHEET: має бути хоча б 1 рядок з hours > 0 на date+objectId
try {
  const sh = await loadSheet(SHEET_NAMES.timesheet);

  requireHeaders(
    sh.map,
    [TIMESHEET_HEADERS.date, TIMESHEET_HEADERS.objectId, TIMESHEET_HEADERS.hours],
    SHEET_NAMES.timesheet
  );

  checklist.hasTimesheet = sh.data.some((r) => {
    const d = getCell(r, sh.map, TIMESHEET_HEADERS.date);
    const o = getCell(r, sh.map, TIMESHEET_HEADERS.objectId);
    const h = parseNumber(getCell(r, sh.map, TIMESHEET_HEADERS.hours));
    return d === date && o === objectId && h > 0;
  });
} catch {}



  // REPORTS + REPORTS VOLUME OK
  try {
  const sh = await loadSheet(SHEET_NAMES.reports);
  requireHeaders(
    sh.map,
    [
      REPORTS_HEADERS.date,
      REPORTS_HEADERS.objectId,
      REPORTS_HEADERS.foremanTgId,
      REPORTS_HEADERS.volumeStatus,
      REPORTS_HEADERS.volume,
    ],
    SHEET_NAMES.reports
  );

    const rows = sh.data.filter((r) => {
      const d = getCell(r, sh.map, REPORTS_HEADERS.date);
      const o = getCell(r, sh.map, REPORTS_HEADERS.objectId);
      const f = getCell(r, sh.map, REPORTS_HEADERS.foremanTgId);
      return d === date && o === objectId && String(f) === String(foremanTgId);
    });

    checklist.hasReports = rows.length > 0;

    // якщо reports є — перевіряємо чи нема НЕ_ЗАПОВНЕНО
if (checklist.hasReports) {
  const hasMissing = rows.some((r) => {
    const vs = String(getCell(r, sh.map, REPORTS_HEADERS.volumeStatus) || "").trim().toUpperCase();

    const raw = String(getCell(r, sh.map, REPORTS_HEADERS.volume) ?? "").trim();
    const vol = parseNumber(raw); // 0 -> ок

    const emptyLike = raw === "" || raw === "?" || raw.toUpperCase() === "NULL";

    return vs === "НЕ_ЗАПОВНЕНО" || emptyLike || !(vol >= 0);
  });

  checklist.hasReportsMissingQty = hasMissing;
  checklist.hasReportsVolumeOk = !hasMissing;
} else {
  checklist.hasReportsMissingQty = false;
  checklist.hasReportsVolumeOk = false;
}
  } catch {}

  // ODOMETER (from ODOMETER_DAY) + ROAD (from EVENTS)
  try {
    // 1) ROAD flag беремо як і було — з EVENTS (ROAD_END/ROAD_SAVE)
    const road = await getRoadFlagsFromEvents(date, objectId, foremanTgId);
    checklist.hasRoad = road.hasRoad;

    // 2) ODOMETER flags беремо з ODOMETER_DAY (одометр "на день", не на обʼєкт)
    const odo = await loadSheet(SHEET_NAMES.odometerDay);

    requireHeaders(
      odo.map,
      [
        ODOMETER_HEADERS.date,
        ODOMETER_HEADERS.foremanTgId,
        ODOMETER_HEADERS.startValue,
        ODOMETER_HEADERS.endValue,
        ODOMETER_HEADERS.startPhoto,
        ODOMETER_HEADERS.endPhoto,
      ],
      SHEET_NAMES.odometerDay
    );

    const row = odo.data.find((r) => {
      const d = getCell(r, odo.map, ODOMETER_HEADERS.date);
      const f = getCell(r, odo.map, ODOMETER_HEADERS.foremanTgId);
      return d === date && String(f) === String(foremanTgId);
    });

    if (row) {
      const sv = String(getCell(row, odo.map, ODOMETER_HEADERS.startValue) ?? "").trim();
      const ev = String(getCell(row, odo.map, ODOMETER_HEADERS.endValue) ?? "").trim();
      const sp = String(getCell(row, odo.map, ODOMETER_HEADERS.startPhoto) ?? "").trim();
      const ep = String(getCell(row, odo.map, ODOMETER_HEADERS.endPhoto) ?? "").trim();

      checklist.hasOdoStart = sv !== "";
      checklist.hasOdoEnd = ev !== "";
      checklist.hasOdoStartPhoto = sp !== "";
      checklist.hasOdoEndPhoto = ep !== "";
    } else {
      checklist.hasOdoStart = false;
      checklist.hasOdoEnd = false;
      checklist.hasOdoStartPhoto = false;
      checklist.hasOdoEndPhoto = false;
    }
  } catch {}


  // LOGISTICS (як у тебе було — через EVENTS “ЛОГІСТИКА” АКТИВНА)
  try {
    const sh = await loadSheet(SHEET_NAMES.events);
    requireHeaders(
      sh.map,
      [EVENTS_HEADERS.date, EVENTS_HEADERS.objectId, EVENTS_HEADERS.type, EVENTS_HEADERS.status],
      SHEET_NAMES.events
    );

    checklist.hasLogistics = sh.data.some((r) => {
      return (
        getCell(r, sh.map, EVENTS_HEADERS.date) === date &&
        getCell(r, sh.map, EVENTS_HEADERS.objectId) === objectId &&
        getCell(r, sh.map, EVENTS_HEADERS.type) === "ЛОГІСТИКА" &&
        getCell(r, sh.map, EVENTS_HEADERS.status) === "АКТИВНА"
      );
    });
  } catch {}

    // MATERIALS (беремо з МАТЕРІАЛИ_РУХ)
  try {
    // ⚠️ ВАЖЛИВО: назва sheet в SHEET_NAMES має відповідати вкладці "МАТЕРІАЛИ_РУХ"
    const sh = await loadSheet(SHEET_NAMES.materialsMove);

    requireHeaders(
      sh.map,
      [
        MATERIALS_MOVE_HEADERS.date,
        MATERIALS_MOVE_HEADERS.objectId,
        MATERIALS_MOVE_HEADERS.foremanTgId,
      ],
      SHEET_NAMES.materialsMove
    );

    checklist.hasMaterials = sh.data.some((r) => {
      const d = String(getCell(r, sh.map, MATERIALS_MOVE_HEADERS.date) ?? "").trim();
      const o = String(getCell(r, sh.map, MATERIALS_MOVE_HEADERS.objectId) ?? "").trim();
      const f = String(getCell(r, sh.map, MATERIALS_MOVE_HEADERS.foremanTgId) ?? "").trim();
      return d === date && o === objectId && f === String(foremanTgId);
    });
  } catch {}


  try {
const existing = await getDayStatusRow(date, objectId, foremanTgId);

await upsertDayStatus({
  date,
  objectId,
  foremanTgId,

  status: existing?.status ?? "ЧЕРНЕТКА",
  returnReason: existing?.returnReason ?? "",
  approvedBy: existing?.approvedBy ?? "",
  approvedAt: existing?.approvedAt ?? "",

  hasTimesheet: checklist.hasTimesheet,
  hasReports: checklist.hasReports,
  hasRoad: checklist.hasRoad,
  hasOdoStart: checklist.hasOdoStart,
  hasOdoEnd: checklist.hasOdoEnd,
  hasOdoStartPhoto: checklist.hasOdoStartPhoto,
  hasOdoEndPhoto: checklist.hasOdoEndPhoto,
  hasLogistics: checklist.hasLogistics,
  hasMaterials: checklist.hasMaterials,
  hasReportsVolumeOk: checklist.hasReportsVolumeOk,
  updatedAt: new Date().toISOString(),
} as any);
} catch {}
  // MATERIALS поки лишаємо false (підключиш коли буде sheet руху матеріалів)
  return checklist;
}
