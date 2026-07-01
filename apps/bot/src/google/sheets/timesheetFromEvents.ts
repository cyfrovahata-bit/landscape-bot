// src/google/sheets/timesheetFromEvents.ts
import type { EventRow, TimesheetRow, EmployeeRow } from "./types.js";


type RoadPayload = {
  objectIds?: string[];   // 1–4
  peopleNow?: string[];   // опціонально, але дуже зручно
};

type RoadActive = {
  lastTs: string;             // ISO
  people: Set<string>;        // хто зараз "в дорозі"
  objectIds: string[];        // 1–4 (куди списувати час)
};

const normalizeObjectIds = (ids?: unknown): string[] => {
  if (!Array.isArray(ids)) return [];
  return ids.map((x) => String(x).trim()).filter(Boolean).slice(0, 4);
};

const splitMinutesAcrossObjects = (objectIds: string[], totalMins: number) => {
  const k = objectIds.length;
  if (k <= 0 || totalMins <= 0) return [];
  // ділимо порівну, залишок розкидаємо на перші
  const base = Math.floor(totalMins / k);
  let rem = totalMins - base * k;
  return objectIds.map((objId) => {
    const add = rem > 0 ? 1 : 0;
    rem = Math.max(0, rem - 1);
    return { objId, mins: base + add };
  });
};



function parseIds(csv?: string): string[] {
  return String(csv ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function safeJson<T>(s?: string): T | null {
  const str = String(s ?? "").trim();
  if (!str) return null;
  try { return JSON.parse(str) as T; } catch { return null; }
}

function roundHours2(hours: number): number {
  return Math.round(hours * 100) / 100; // 2 знаки
}

type Active = {
  objectId: string;
  lastTs: string; // ISO
};

export function computeTimesheetFromEvents(args: {
  date: string;
  foremanTgId: number;
  events: EventRow[];
  employeesDict: EmployeeRow[]; // щоб підтягти імена
}): TimesheetRow[] {
  const { date, events, employeesDict } = args;

  const empNameById = new Map<string, string>();
  for (const e of employeesDict) empNameById.set(String(e.id), e.name);

  // employeeId -> Active
  const active = new Map<string, Active>();

  let roadActive: RoadActive | null = null;

const roadFlushTo = (endTs: string) => {
  if (!roadActive) return;
  const mins = diffMinutes(roadActive.lastTs, endTs);
  if (mins <= 0) { roadActive.lastTs = endTs; return; }

  const objIds = roadActive.objectIds;
  if (objIds.length < 1) { roadActive.lastTs = endTs; return; } // нема куди списати

  const parts = splitMinutesAcrossObjects(objIds, mins);

  for (const empId of roadActive.people) {
    for (const p of parts) {
      addMinutes(p.objId, empId, p.mins);
    }
  }

  roadActive.lastTs = endTs;
};


  // objectId -> employeeId -> minutes
  const minutesByObjEmp = new Map<string, Map<string, number>>();

  const addMinutes = (objectId: string, employeeId: string, mins: number) => {
    if (mins <= 0) return;
    let m = minutesByObjEmp.get(objectId);
    if (!m) {
      m = new Map();
      minutesByObjEmp.set(objectId, m);
    }
    m.set(employeeId, (m.get(employeeId) ?? 0) + mins);
  };

  const diffMinutes = (aIso: string, bIso: string) => {
    const a = new Date(aIso).getTime();
    const b = new Date(bIso).getTime();
    if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
    return Math.max(0, Math.round((b - a) / 60000));
  };

  const closeEmployee = (employeeId: string, endTs: string) => {
    const st = active.get(employeeId);
    if (!st) return;
    addMinutes(st.objectId, employeeId, diffMinutes(st.lastTs, endTs));
    active.delete(employeeId);
  };

  const openEmployee = (employeeId: string, objectId: string, ts: string) => {
    // якщо вже відкритий десь — закриємо на цей же ts
    closeEmployee(employeeId, ts);
    active.set(employeeId, { objectId, lastTs: ts });
  };

  for (const ev of events) {
    const ts = ev.ts;
    const objectId = ev.objectId || "";
    const ids = parseIds(ev.employeeIds);

    if (!ts) continue;



    switch (ev.type) {
      case "TS_START": {
        if (!objectId) break;
        for (const id of ids) openEmployee(id, objectId, ts);
        break;
      }

            case "ROAD_START": {
        // стартуємо сесію дороги
        const p = safeJson<RoadPayload>(ev.payload);
        const objectIds = normalizeObjectIds(p?.objectIds);
        const people = new Set(parseIds(ev.employeeIds));

        // якщо вже була активна дорога — закриємо на цей ts і перезапустимо
        if (roadActive) roadFlushTo(ts);

        roadActive = {
          lastTs: ts,
          people,
          objectIds,
        };
        break;
      }

      case "ROAD_ADD": {
        if (!roadActive) break;

        // спочатку “дорахували” до цього моменту старим складом
        roadFlushTo(ts);

        const p = safeJson<RoadPayload>(ev.payload);
        const peopleNow = p?.peopleNow?.map(String).filter(Boolean);

        if (peopleNow?.length) {
          roadActive.people = new Set(peopleNow);
        } else {
          // fallback: employeeIds може містити 1 id
          for (const id of parseIds(ev.employeeIds)) roadActive.people.add(id);
        }

        const objectIds = normalizeObjectIds(p?.objectIds);
        if (objectIds.length) roadActive.objectIds = objectIds;

        break;
      }

      case "ROAD_REMOVE": {
        if (!roadActive) break;

        roadFlushTo(ts);

        const p = safeJson<RoadPayload>(ev.payload);
        const peopleNow = p?.peopleNow?.map(String).filter(Boolean);

        if (peopleNow?.length) {
          roadActive.people = new Set(peopleNow);
        } else {
          // fallback: employeeIds може містити 1 id
          for (const id of parseIds(ev.employeeIds)) roadActive.people.delete(id);
        }

        const objectIds = normalizeObjectIds(p?.objectIds);
        if (objectIds.length) roadActive.objectIds = objectIds;

        break;
      }

      case "ROAD_END": {
        if (!roadActive) break;

        // дорахували до end
        roadFlushTo(ts);

        // закрили сесію
        roadActive = null;
        break;
      }

      case "TS_ADD": {
        if (!objectId) break;
        for (const id of ids) openEmployee(id, objectId, ts);
        break;
      }

      case "TS_REMOVE": {
        for (const id of ids) closeEmployee(id, ts);
        break;
      }

      case "TS_MOVE": {
        // payload: { toObjectId: "..." }
        const p = safeJson<{ toObjectId?: string }>(ev.payload);
        const to = String(p?.toObjectId ?? "").trim();
        if (!to) break;

        for (const id of ids) {
          closeEmployee(id, ts);
          openEmployee(id, to, ts);
        }
        break;
      }

      case "TS_END": {
        // якщо event має employeeIds — закриваємо тільки їх, інакше закриваємо всіх активних на objectId
        if (ids.length) {
          for (const id of ids) closeEmployee(id, ts);
        } else if (objectId) {
          for (const [empId, st] of active.entries()) {
            if (st.objectId === objectId) closeEmployee(empId, ts);
          }
        }
        break;
      }

      default:
        break;
    }
  }

  // Не закриваємо “до кінця дня” автоматом — краще вимагати TS_END (інакше буде брехня).
  // Але можна буде додати fallback пізніше.

  // Перетворюємо в TimesheetRow[]
  const rows: TimesheetRow[] = [];
  for (const [objId, empMap] of minutesByObjEmp.entries()) {
    for (const [empId, mins] of empMap.entries()) {
const hours = roundHours2(mins / 60);
if (hours <= 0) continue;

      rows.push({
        date,
        objectId: objId,
        employeeId: empId,
        employeeName: empNameById.get(empId) ?? empId,
        hours,
        source: "EVENTS",
        updatedAt: new Date().toISOString(),
      });
    }
  }

  // стабільне сортування
  rows.sort((a, b) => (a.objectId + a.employeeId).localeCompare(b.objectId + b.employeeId));
  return rows;
}
