// src/bot/flows/roadTimesheet.stats.ts
import type TelegramBot from "node-telegram-bot-api";

import { TEXTS } from "../texts.js";
import { todayISO } from "../core/helpers.js";
import { buildRoadDayStats } from "./roadTimesheet.stats.data.js";

import type { Step, State } from "./roadTimesheet.types.js";

import {
  carName,
  objectName,
  empName,
  joinEmpNames,
  uniq,
  fmtNum,
  mdEscapeSimple,
  roundToQuarterHours,
  safeEditMessageText,
  ensureEmployees,
  ensureCarsMeta,
  ensureObjectsMeta,
  computeFromRts,
  computeRoadSecondsFromRts,
  pickBrigadierFromPeople,
  isSenior,
} from "./roadTimesheet.utils.js";

import { computeWorkMoneyFromRts } from "./roadTimesheet.compute.js";
import { fmtHhMm } from "./roadTimesheet.format.js";

import { getDayStatusRow } from "../../google/sheets/checklist.js";

import {
  fetchEvents,
} from "../../google/sheets/working.js";

/* =========================================================
 * Callbacks (локальні для stats, але на базі загального PREFIX)
 * ========================================================= */
export const STATS_CB = {
  MENU: "STATS:MENU",
  CARS: "STATS:CARS",
  OBJECTS: "STATS:OBJECTS",
  PEOPLE: "STATS:PEOPLE",
  LOGISTICS: "STATS:LOGISTICS",

  CAR_VIEW: "STATS:CAR:", // +carId
  OBJECT_VIEW: "STATS:OBJ:", // +objectId
  PERSON_VIEW: "STATS:EMP:", // +employeeId
  LOGISTICS_VIEW: "STATS:LOG:", // +logisticId
  BACK: "STATS:BACK:", // +tag
} as const;


function isApprovedStatus(status: string) {
  const s = String(status ?? "")
    .trim()
    .toUpperCase()
    .replace(/[✅🟡🔴🟢⚪️]/g, "")
    .replace(/\s+/g, " ");

  return (
    s === "ЗАТВЕРДЖЕНО" ||
    s === "ПІДТВЕРДЖЕНО"
  );
}

function isReturnedStatus(status: string) {
  const s = normalizeStatus(status);
  return s === "ПОВЕРНУТО" || s === "СКАСОВАНО";
}

function getEventTs(e: any) {
  const ms = Date.parse(String(e?.ts ?? e?.updatedAt ?? ""));
  return Number.isFinite(ms) ? ms : 0;
}

function auditStatsSource(screen: string, details: Record<string, any>) {
  console.log(`[RTS_STATS][${screen}]`, details);
}

function addToMap(map: Map<string, number>, key: string, value: number) {
  map.set(key, Math.round(((map.get(key) ?? 0) + Number(value ?? 0)) * 100) / 100);
}

function getPayloadObjectName(payload: any, objectId: string, st: State) {
  const detailed = Array.isArray(payload?.objectsDetailed) ? payload.objectsDetailed : [];
  const found = detailed.find((o: any) => String(o?.objectId ?? "") === String(objectId));
  return String(found?.objectName ?? objectName(st, objectId));
}

function payloadsForObject(payloads: any[], objectId: string) {
  return payloads.filter((payload) => {
    const oid = String(objectId);
    return (
      (payload.salaryPacks ?? []).some((p: any) => String(p.objectId ?? "") === oid) ||
      (payload.payrollPacks ?? []).some((p: any) => String(p.objectId ?? "") === oid) ||
      (payload.workTotalsByObject ?? []).some((p: any) => String(p.objectId ?? "") === oid) ||
      (payload.workMoneyRows ?? []).some((r: any) => String(r.objectId ?? "") === oid)
    );
  });
}

function payloadsForEmployee(payloads: any[], employeeId: string) {
  return payloads.filter((payload) => {
    const eid = String(employeeId);
    return (
      (payload.salaryPacks ?? []).some((p: any) =>
        (p.rows ?? []).some((r: any) => String(r.employeeId ?? "") === eid),
      ) ||
      (payload.payrollPacks ?? []).some((p: any) =>
        (p.rows ?? []).some((r: any) => String(r.employeeId ?? "") === eid),
      ) ||
      (payload.workMoneyRows ?? []).some((r: any) => String(r.employeeId ?? "") === eid)
    );
  });
}

function cbx(prefix: string, key: string) {
  // робимо callback_data в тому ж просторі що й flow (через PREFIX)
  return `${prefix}${key}`;
}

/* =========================================================
 * State helpers for screens
 * ========================================================= */
type Screen = {
  text: string;
  kb: TelegramBot.InlineKeyboardMarkup;
  parse_mode: TelegramBot.ParseMode;
};

function setScreen(st: State, step: Step, scr: Screen) {
  (st as any).step = step;
  (st as any).statsScreen = scr;
}


async function getOdoRangeForCarFromEvents(params: {
  date: string;
  foremanTgId: number;
  carId: string;
}): Promise<{
  odoStartKm?: number;
  odoEndKm?: number;
  startTs?: string;
  endTs?: string;
} | null> {
  const { date, foremanTgId, carId } = params;

  const parsePayload = (raw: any) => {
    if (!raw) return null;
    if (typeof raw === "string") {
      try { return JSON.parse(raw); } catch { return null; }
    }
    return raw ?? null;
  };

  const getTs = (e: any) =>
    Date.parse(String(e?.ts ?? e?.updatedAt ?? e?.createdAt ?? "")) || 0;

  try {
    const events = await fetchEvents({ date, foremanTgId } as any);
    const rows = (events ?? []).filter(
      (e: any) => String(e.carId ?? "") === String(carId),
    );

    // ✅ ПЕРШИЙ ODO START
    const startRows = rows
      .filter((e: any) => String(e.type ?? "") === "RTS_ODO_START")
      .sort((a: any, b: any) => getTs(a) - getTs(b));

    // ✅ ОСТАННІЙ ODO END
    const endRows = rows
      .filter((e: any) => String(e.type ?? "") === "RTS_ODO_END")
      .sort((a: any, b: any) => getTs(a) - getTs(b));

    const firstStart = startRows[0];
    const lastEnd = endRows[endRows.length - 1];

    const pStart = parsePayload(firstStart?.payload);
    const pEnd = parsePayload(lastEnd?.payload);

    const odoStartKm =
      typeof pStart?.odoStartKm === "number" ? pStart.odoStartKm : undefined;

    const odoEndKm =
      typeof pEnd?.odoEndKm === "number" ? pEnd.odoEndKm : undefined;

const startTs = (firstStart?.ts ?? firstStart?.updatedAt) as string | undefined;
const endTs = (lastEnd?.ts ?? lastEnd?.updatedAt) as string | undefined;

return {
  ...(typeof odoStartKm === "number" ? { odoStartKm } : {}),
  ...(typeof odoEndKm === "number" ? { odoEndKm } : {}),
  ...(startTs ? { startTs } : {}),
  ...(endTs ? { endTs } : {}),
};
  } catch {
    return null;
  }
}

async function getResolvedRoadEndPayloads(params: {
  date: string;
  foremanTgId: number;
}): Promise<any[]> {
  const { date, foremanTgId } = params;

  try {
    const events = await fetchEvents({ date, foremanTgId } as any);

    const rows = (events ?? [])
      .filter((e: any) => String(e.type ?? "") === "ROAD_END")
      .sort((a: any, b: any) => {
        const ta = getEventTs(a);
        const tb = getEventTs(b);
        if (ta !== tb) return ta - tb;
        return String(a.eventId ?? "").localeCompare(String(b.eventId ?? ""));
      });

    const approvedRows = rows.filter((e: any) => isApprovedStatus(String(e.status ?? "")));
    const nonReturnedRows = rows.filter((e: any) => !isReturnedStatus(String(e.status ?? "")));
    const candidates = approvedRows.length ? approvedRows : nonReturnedRows.length ? [nonReturnedRows[nonReturnedRows.length - 1]] : [];

    const payloads = candidates
      .filter(Boolean)
      .map((ev: any) => {
        let payload: any = {};
        try {
          payload = typeof ev.payload === "string" ? JSON.parse(ev.payload) : (ev.payload ?? {});
        } catch {
          payload = {};
        }

        return {
          ...(payload ?? {}),
          __status: String(ev.status ?? ""),
          __eventId: String(ev.eventId ?? ""),
          __refEventId: String(ev.refEventId ?? ""),
          __type: String(ev.type ?? ""),
          __resolvedFrom: approvedRows.length ? "approved" : "latest_non_returned",
        };
      });

    auditStatsSource("ROAD_END_RESOLVE", {
      date,
      foremanTgId,
      roadEndEvents: rows.length,
      approvedEvents: approvedRows.length,
      nonReturnedEvents: nonReturnedRows.length,
      resolvedEvents: payloads.map((p) => p.__eventId),
      statuses: payloads.map((p) => p.__status),
    });

    return payloads;
  } catch {
    return [];
  }
}

async function getLatestRoadEndPayload(params: {
  date: string;
  foremanTgId: number;
}): Promise<any | null> {
  const payloads = await getResolvedRoadEndPayloads(params);
  return payloads[payloads.length - 1] ?? null;
}


export function renderRoadStatsIfStep(st: State): Screen | null {
  const step = (st as any).step as Step;
  const isStats =
    step === ("STATS_MENU" as any) ||
    step === ("STATS_CARS" as any) ||
    step === ("STATS_OBJECTS" as any) ||
    step === ("STATS_PEOPLE" as any) ||
    step === ("STATS_LOGISTICS" as any) ||
    step === ("STATS_CAR_VIEW" as any) ||
    step === ("STATS_OBJECT_VIEW" as any) ||
    step === ("STATS_PERSON_VIEW" as any) ||
    step === ("STATS_LOGISTICS_VIEW" as any);

  if (!isStats) return null;

  const scr = (st as any).statsScreen as Screen | undefined;
  if (!scr) {
return {
  text: "⚠️ Нема екрану статистики.",
  parse_mode: "Markdown", // ✅ ДОДАЙ ЦЕ
  kb: {
    inline_keyboard: [[{ text: TEXTS.common.backToMenu, callback_data: "" }]],
  },
};
  }
  return scr;
}

function secToMinutes(sec: number) {
  const s = Math.max(0, Math.floor(sec || 0));
  return Math.floor(s / 60);
}

async function getObjectStatusSafe(date: string, objectId: string, foremanTgId: number) {
  try {
    const ds = await getDayStatusRow(date, objectId, foremanTgId);
    return String(ds?.status ?? "").trim();
  } catch {
    return "";
  }
}

function normalizeStatus(raw?: string) {
  return String(raw ?? "")
    .toUpperCase()
    .replace(/[✅🟡🔴🟢⚪️]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function logisticStatusLabel(status?: string) {
  const st = normalizeStatus(status);

  if (st === "ЗАТВЕРДЖЕНО") return "✅ ЗАТВЕРДЖЕНО";
  if (st === "ПОВЕРНУТО") return "🔴 ПОВЕРНУТО";
  if (st === "АКТИВНА") return "🟡 АКТИВНА";
  if (!st) return "—";

  return st;
}

/* =========================================================
 * Screen builders (menu/lists)
 * ========================================================= */
function buildStatsMenu(prefix: string): Screen {
  return {
    text: `📊 Статистика\n\nОбери розділ:`,
    parse_mode: "Markdown",
    kb: {
      inline_keyboard: [
        [{ text: "🚗 Машини", callback_data: cbx(prefix, STATS_CB.CARS) }],
        [{ text: "🏗 Обʼєкти", callback_data: cbx(prefix, STATS_CB.OBJECTS) }],
        [{ text: "👥 Люди", callback_data: cbx(prefix, STATS_CB.PEOPLE) }],
        [{ text: "🚚 Логістика", callback_data: cbx(prefix, STATS_CB.LOGISTICS) }],
        [{ text: TEXTS.common.backToMenu, callback_data: cbx(prefix, "MENU") }], // буде перехоплено основним cb.MENU
      ],
    },
  };
}

function buildCarsList(st: State, prefix: string): Screen {
  const cars = (st as any).carsMeta ?? [];
  const slice = cars.slice(0, 30);

  const rows: TelegramBot.InlineKeyboardButton[][] = slice.map((c: any) => [
    {
      text: `🚗 ${String(c.name ?? c.id).slice(0, 60)}`,
      callback_data: cbx(prefix, `${STATS_CB.CAR_VIEW}${c.id}`),
    },
  ]);

  rows.push([{ text: "⬅️ Назад", callback_data: cbx(prefix, `${STATS_CB.BACK}stats_menu`) }]);
  rows.push([{ text: TEXTS.common.backToMenu, callback_data: cbx(prefix, "MENU") }]);

  return {
    text: `🚗 Обери авто`,
    parse_mode: "Markdown",
    kb: { inline_keyboard: rows },
  };
}

function buildObjectsList(st: State, prefix: string): Screen {
  const objs = (st as any).objectsMeta ?? [];
  const slice = objs.slice(0, 30);

  const rows: TelegramBot.InlineKeyboardButton[][] = slice.map((o: any) => [
    {
      text: `🏗 ${String(o.name ?? o.id).slice(0, 60)}`,
      callback_data: cbx(prefix, `${STATS_CB.OBJECT_VIEW}${o.id}`),
    },
  ]);

  rows.push([{ text: "⬅️ Назад", callback_data: cbx(prefix, `${STATS_CB.BACK}stats_menu`) }]);
  rows.push([{ text: TEXTS.common.backToMenu, callback_data: cbx(prefix, "MENU") }]);

  return {
    text: `🏗 Обʼєкти — вибери обʼєкт`,
    parse_mode: "Markdown",
    kb: { inline_keyboard: rows },
  };
}

function buildPeopleList(st: State, prefix: string): Screen {
  const emps = (st as any).employees ?? [];
  const slice = emps.slice(0, 40);

  const rows: TelegramBot.InlineKeyboardButton[][] = slice.map((e: any) => [
    {
      text: `👤 ${String(e.name ?? e.id).slice(0, 60)}`,
      callback_data: cbx(prefix, `${STATS_CB.PERSON_VIEW}${e.id}`),
    },
  ]);

  rows.push([{ text: "⬅️ Назад", callback_data: cbx(prefix, `${STATS_CB.BACK}stats_menu`) }]);
  rows.push([{ text: TEXTS.common.backToMenu, callback_data: cbx(prefix, "MENU") }]);

  return {
    text: `👥 Люди — вибери працівника`,
    parse_mode: "Markdown",
    kb: { inline_keyboard: rows },
  };
}

async function buildLogisticsList(params: {
  st: State;
  prefix: string;
  date: string;
  foremanTgId: number;
}): Promise<Screen> {
  const { prefix, date, foremanTgId } = params;

  const events = await fetchEvents({ date, foremanTgId } as any);

  const logisticsEvents = (events ?? []).filter(
    (e: any) => String(e.type ?? "") === "ЛОГІСТИКА"
  );

  const byLogistic = new Map<string, { name: string; count: number }>();

  for (const ev of logisticsEvents) {
    let payload: any = {};
    try {
      payload = typeof ev.payload === "string" ? JSON.parse(ev.payload) : (ev.payload ?? {});
    } catch {
      payload = {};
    }

    const items = Array.isArray(payload.items) ? payload.items : [];
    for (const it of items) {
      const id = String(it.logisticId ?? "");
      const name = String(it.logisticName ?? id ?? "—");
      if (!id) continue;

      const cur = byLogistic.get(id) ?? { name, count: 0 };
      cur.count += 1;
      cur.name = name;
      byLogistic.set(id, cur);
    }
  }

  const rows: TelegramBot.InlineKeyboardButton[][] =
    [...byLogistic.entries()]
      .sort((a, b) => a[1].name.localeCompare(b[1].name, "uk"))
      .slice(0, 50)
      .map(([logisticId, v]) => [
        {
          text: `🚚 ${String(v.name).slice(0, 50)} (${v.count})`,
          callback_data: cbx(prefix, `${STATS_CB.LOGISTICS_VIEW}${logisticId}`),
        },
      ]);

if (!rows.length) {
  rows.push([{ text: "— Немає логістики за день —", callback_data: cbx(prefix, `${STATS_CB.BACK}stats_menu`) }]);
}

  rows.push([{ text: "⬅️ Назад", callback_data: cbx(prefix, `${STATS_CB.BACK}stats_menu`) }]);
  rows.push([{ text: TEXTS.common.backToMenu, callback_data: cbx(prefix, "MENU") }]);

  return {
    text: `🚚 Логістика — вибери напрямок`,
    parse_mode: "Markdown",
    kb: { inline_keyboard: rows },
  };
}

/* =========================================================
 * Screen builders (views) — async (рахуємо по RTS)
 * ========================================================= */

async function buildCarView(params: {
  st: State;
  prefix: string;
  date: string;
  foremanTgId: number;
  carId: string;
}): Promise<Screen> {
  const { st, prefix, date, foremanTgId, carId } = params;

  const day = await buildRoadDayStats({ date, foremanTgId });
  const car = day.cars[carId];
  const payload = await getLatestRoadEndPayload({ date, foremanTgId });

  const objectLines =
    (car?.objectIds ?? []).map((oid) => `• ${mdEscapeSimple(objectName(st, oid))}`).join("\n") || "—";

  const currentCarPeopleIds = car ? ((car as any).currentEmployeeIds ?? []) : [];
  const peopleLines =
    currentCarPeopleIds
      .map((empId: string) => `• ${mdEscapeSimple(empName(st, empId))}`)
      .join("\n") || "—";

  const kmDay =
    typeof car?.odoStartKm === "number" && typeof car?.odoEndKm === "number"
      ? Math.max(0, car.odoEndKm - car.odoStartKm)
      : undefined;

  const whereNow =
    car?.whereNowObjectId
      ? objectName(st, car.whereNowObjectId)
      : "—";

  auditStatsSource("CAR_VIEW", {
    date,
    foremanTgId,
    carId,
    eventId: payload?.__eventId ?? "",
    refEventId: payload?.__refEventId ?? "",
    status: payload?.__status ?? "",
    type: payload?.__type ?? "",
    source: payload?.__resolvedFrom ?? "live_events",
    resolvedFinalEvent: payload?.__eventId ?? "",
  statePhase: st.phase,
  currentCar: carId,
  currentEarnings: "",
  statusNow: car?.statusNow ?? "",
  lastEventType: car?.lastEventType ?? "",
  sourceEventsCount: day.events.filter((ev: any) => String(ev.carId ?? "") === String(carId)).length,
  currentPeople: currentCarPeopleIds,
  currentPhase: car?.statusNow ?? "",
  currentObject: car?.whereNowObjectId ?? "",
    lastDriveEvent: (car as any)?.lastDriveEventId ?? "",
    lastReturnEvent: (car as any)?.lastReturnEventId ?? "",
  });

  const text =
    `🚗 *Статистика авто*\n\n` +
    `Авто: *${mdEscapeSimple(carName(st, carId))}*\n` +
    `📅 ${mdEscapeSimple(date)}\n` +
    `Статус зараз: *${mdEscapeSimple(car?.statusNow || "—")}*\n` +
    `Де зараз: *${mdEscapeSimple(whereNow)}*\n\n` +
    `Початковий ODO: ${typeof car?.odoStartKm === "number" ? fmtNum(car.odoStartKm) : "—"} км\n` +
    `Кінцевий ODO: ${typeof car?.odoEndKm === "number" ? fmtNum(car.odoEndKm) : "—"} км\n` +
    `Кілометрів за день: ${kmDay !== undefined ? fmtNum(kmDay) : "—"}\n` +
    `Час у дорозі: ${car?.roadSec ? fmtHhMm(Math.floor(car.roadSec / 60)) : "—"}\n\n` +
    `👥 Люди:\n${peopleLines}\n\n` +
    `🏗 Де були:\n${objectLines}`;

  return {
    text,
    parse_mode: "Markdown",
    kb: {
      inline_keyboard: [
        [{ text: "⬅️ Назад", callback_data: cbx(prefix, STATS_CB.CARS) }],
        [{ text: TEXTS.common.backToMenu, callback_data: cbx(prefix, "MENU") }],
      ],
    },
  };
}

async function buildStatsPayMap(params: {
  date: string;
  foremanTgId: number;
}) {
  const { date, foremanTgId } = params;

 const payloads = await getResolvedRoadEndPayloads({ date, foremanTgId });
 const approvedPayloads = payloads.filter((payload) => isApprovedStatus(payload?.__status));

if (approvedPayloads.some((payload) => payload?.salaryPacks?.length)) {
  const moneyByObject = new Map<string, number>();
  const payByObjectEmp = new Map<string, number>();
  const companyByObject = new Map<string, number>();
  const roleSummaryByObject = new Map<
    string,
    { workers: number; brigadiers: number; seniors: number; company: number }
  >();

  for (const payload of approvedPayloads) {
    const brigadierSet = new Set(
      (payload.brigadierEmployeeIds ?? []).map(String),
    );

    const seniorSet = new Set(
      (payload.seniorEmployeeIds ?? []).map(String),
    );

    for (const pack of payload.salaryPacks ?? []) {
      const objectId = String(pack.objectId ?? "");
      if (!objectId) continue;

      addToMap(moneyByObject, objectId, Number(pack.objectTotal ?? 0));

      const summary = roleSummaryByObject.get(objectId) ?? {
        workers: 0,
        brigadiers: 0,
        seniors: 0,
        company: 0,
      };

      let eventTotalPaid = 0;
      let eventWorkers = 0;
      let eventBrigadiers = 0;
      let eventSeniors = 0;

      for (const r of pack.rows ?? []) {
        const empId = String(r.employeeId ?? "");
        const pay = Number(r.pay ?? 0);

        if (!empId) continue;

        addToMap(payByObjectEmp, `${objectId}||${empId}`, pay);

        eventTotalPaid += pay;
        if (brigadierSet.has(empId)) eventBrigadiers += pay;
        else if (seniorSet.has(empId)) eventSeniors += pay;
        else eventWorkers += pay;
      }

      summary.workers = Math.round((summary.workers + eventWorkers) * 100) / 100;
      summary.brigadiers = Math.round((summary.brigadiers + eventBrigadiers) * 100) / 100;
      summary.seniors = Math.round((summary.seniors + eventSeniors) * 100) / 100;
      summary.company = Math.round(
        (summary.company + Math.max(0, Number(pack.objectTotal ?? 0) - eventTotalPaid)) * 100,
      ) / 100;

      roleSummaryByObject.set(objectId, summary);
      companyByObject.set(objectId, summary.company);
    }
  }

  auditStatsSource("PAY_MAP", {
    date,
    foremanTgId,
    source: "ROAD_END.salaryPacks",
    resolvedEventId: approvedPayloads.map((p) => p.__eventId).join(","),
    refEventId: approvedPayloads.map((p) => p.__refEventId).filter(Boolean).join(","),
    status: approvedPayloads.map((p) => p.__status).join(","),
    type: "ROAD_END",
    resolvedFrom: "approved",
    objects: moneyByObject.size,
    totalEarnings: [...payByObjectEmp.values()].reduce((a, v) => a + Number(v ?? 0), 0),
  });

  return {
    moneyByObject,
    payByObjectEmp,
    companyByObject,
    roleSummaryByObject,
  };
} 

  const aggAll = await computeFromRts({ date, foremanTgId });
  const workRows = (await computeWorkMoneyFromRts({ date, foremanTgId })) as any[];

  const allEmployeeIds = uniq(
    aggAll
      .map((r: any) => String(r.employeeId ?? ""))
      .filter(Boolean),
  );

  const brigadierEmployeeIds: string[] = [];

  const oneBrigadier = await pickBrigadierFromPeople(allEmployeeIds);
  if (oneBrigadier) {
    brigadierEmployeeIds.push(String(oneBrigadier));
  }

  const seniorEmployeeIds: string[] = [];

  for (const empId of allEmployeeIds) {
    if (await isSenior(empId)) {
      seniorEmployeeIds.push(String(empId));
    }
  }

  const moneyByObject = new Map<string, number>();

  for (const r of workRows) {
    const oid = String(r.objectId ?? "");
    moneyByObject.set(
      oid,
      (moneyByObject.get(oid) ?? 0) + Number(r.amount ?? 0),
    );
  }

  const pointsByObjectEmp = new Map<string, number>();

  for (const r of aggAll) {
    const oid = String(r.objectId ?? "");
    const empId = String(r.employeeId ?? "");
    if (!oid || !empId) continue;

    const hours = roundToQuarterHours(Number(r.sec ?? 0) / 3600);
    const coef =
      Number(r.disciplineCoef ?? 1.0) *
      Number(r.productivityCoef ?? 1.0);

    const points = Math.round(hours * coef * 100) / 100;
    const key = `${oid}||${empId}`;

    pointsByObjectEmp.set(
      key,
      (pointsByObjectEmp.get(key) ?? 0) + points,
    );
  }

  const payByObjectEmp = new Map<string, number>();
  const companyByObject = new Map<string, number>();
  const roleSummaryByObject = new Map<
    string,
    {
      workers: number;
      brigadiers: number;
      seniors: number;
      company: number;
    }
  >();

  for (const [objectId, objectTotal] of moneyByObject.entries()) {
    const objectEmpRows = [...pointsByObjectEmp.entries()]
      .filter(([key]) => key.startsWith(`${objectId}||`))
      .map(([key, points]) => {
        const empId = key.split("||")[1] ?? "";
        return { empId, points };
      })
      .filter((r) => r.empId && r.points > 0);

    const brigadierSet = new Set(brigadierEmployeeIds.map(String));
    const seniorSet = new Set(seniorEmployeeIds.map(String));

    const brigadierRows = objectEmpRows.filter((r) =>
      brigadierSet.has(String(r.empId)),
    );

    const seniorRows = objectEmpRows.filter((r) =>
      seniorSet.has(String(r.empId)),
    );

    const hasBrigadier = brigadierRows.length > 0;
    const hasSenior = seniorRows.length > 0;

const workerPercent = hasBrigadier ? 0.7 : 0.9;
const brigadierPercent = hasBrigadier ? 0.2 : 0;
const seniorPercent = hasSenior ? 0.1 : 0;
const companyPercent = hasSenior ? 0 : 0.1;

    const workerRows = objectEmpRows.filter((r) => {
      const id = String(r.empId);

      if (hasBrigadier && brigadierSet.has(id)) return false;
      if (hasSenior && seniorSet.has(id)) return false;

      return true;
    });

    const sumWorkerPoints = workerRows.reduce(
      (a, r) => a + Number(r.points ?? 0),
      0,
    );

    const brigadierTotalPay = objectTotal * brigadierPercent;
    const seniorTotalPay = objectTotal * seniorPercent;
    const companyPay = objectTotal * companyPercent;

    const brigadierOnePay =
      brigadierRows.length > 0
        ? brigadierTotalPay / brigadierRows.length
        : 0;

    const seniorOnePay =
      seniorRows.length > 0
        ? seniorTotalPay / seniorRows.length
        : 0;

    let workersTotalPay = 0;

    for (const r of objectEmpRows) {
      let pay = 0;

      if (hasBrigadier && brigadierSet.has(String(r.empId))) {
        pay = brigadierOnePay;
      } else if (hasSenior && seniorSet.has(String(r.empId))) {
        pay = seniorOnePay;
      } else {
        pay =
          sumWorkerPoints > 0
            ? (objectTotal * workerPercent * Number(r.points ?? 0)) / sumWorkerPoints
            : 0;

        workersTotalPay += pay;
      }

      payByObjectEmp.set(
        `${objectId}||${r.empId}`,
        Math.round(pay * 100) / 100,
      );
    }

    companyByObject.set(objectId, Math.round(companyPay * 100) / 100);

    roleSummaryByObject.set(objectId, {
      workers: Math.round(workersTotalPay * 100) / 100,
      brigadiers: Math.round(brigadierTotalPay * 100) / 100,
      seniors: Math.round(seniorTotalPay * 100) / 100,
      company: Math.round(companyPay * 100) / 100,
    });
  }

  auditStatsSource("PAY_MAP", {
    date,
    foremanTgId,
    source: "live_rts_events",
    resolvedEventId: "",
    status: "",
    objects: moneyByObject.size,
    totalEarnings: [...payByObjectEmp.values()].reduce((a, v) => a + Number(v ?? 0), 0),
  });

  return {
    moneyByObject,
    payByObjectEmp,
    companyByObject,
    roleSummaryByObject,
  };
}











async function buildObjectView(params: {
  st: State;
  prefix: string;
  date: string;
  foremanTgId: number;
  objectId: string;
}): Promise<Screen> {
  const { st, prefix, date, foremanTgId, objectId } = params;

  const day = await buildRoadDayStats({ date, foremanTgId });
  const obj = day.objects[objectId];

const payloads = await getResolvedRoadEndPayloads({ date, foremanTgId });
const objectPayloads = payloadsForObject(payloads, objectId);
const payloadPackRows = objectPayloads.flatMap((payload) =>
  (payload?.payrollPacks ?? [])
    .filter((p: any) => String(p.objectId) === String(objectId))
    .flatMap((p: any) => p.rows ?? []),
);

const peopleLines = payloadPackRows.length
  ? payloadPackRows
      .map(
        (r: any) =>
          `• ${mdEscapeSimple(String(r.employeeName ?? empName(st, r.employeeId)))}: *${fmtNum(r.hours)} год*`,
      )
      .join("\n")
  : Object.entries(obj?.secByEmployee ?? {})
      .sort((a, b) => Number(b[1]) - Number(a[1]))
      .map(([empId, sec]) => `• ${mdEscapeSimple(empName(st, empId))}: *${(Number(sec) / 3600).toFixed(2)} год*`)
      .join("\n") || "—";

  const carLines =
    (obj?.carIds ?? []).map((cid) => `• ${mdEscapeSimple(carName(st, cid))}`).join("\n") || "—";

  const checklistStatus = await getObjectStatusSafe(date, objectId, foremanTgId);
const objectApproved = objectPayloads.some((payload) => isApprovedStatus(payload?.__status));
const displayDayStatus = objectApproved ? "ЗАТВЕРДЖЕНО" : checklistStatus || String(obj?.statusDay ?? "—");
const displayNowStatus = objectApproved ? "ДЕНЬ ЗАВЕРШЕНО" : String(obj?.statusNow || "—");

const canShowMoney =
  isApprovedStatus(checklistStatus) ||
  isApprovedStatus(obj?.statusDay) ||
  objectApproved;

const payMap = await buildStatsPayMap({ date, foremanTgId });
const totalAmount = payMap.moneyByObject.get(String(objectId)) ?? 0;
const workRowsForObject = objectPayloads
  .flatMap((payload) => payload.workMoneyRows ?? [])
  .filter((row: any) => String(row.objectId ?? "") === String(objectId));
const workByKey = new Map<string, { name: string; unit: string; qty: number; amount: number }>();

for (const row of workRowsForObject) {
  const workId = String(row.workId ?? row.workName ?? "").trim();
  const key = workId || String(row.workName ?? "");
  if (!key) continue;
  const cur = workByKey.get(key) ?? {
    name: String(row.workName ?? workId),
    unit: String(row.unit ?? "").trim(),
    qty: 0,
    amount: 0,
  };
  cur.qty += Number(row.qty ?? 0);
  cur.amount += Number(row.amount ?? 0);
  workByKey.set(key, cur);
}

const workLines =
  [...workByKey.values()]
    .map((row) => {
      const qty = Math.round(Number(row.qty ?? 0) * 100) / 100;
      return `• ${mdEscapeSimple(row.name)}: *${fmtNum(qty)} ${mdEscapeSimple(row.unit)}*`;
    })
    .join("\n") || "—";

auditStatsSource("OBJECT_VIEW", {
  date,
  foremanTgId,
  objectId,
  objectName: objectName(st, objectId),
  sourceEventsCount: day.events.filter((ev: any) => String(ev.objectId ?? "") === String(objectId)).length,
  approvedRoadEventsForObject: objectPayloads.filter((payload) => isApprovedStatus(payload?.__status)).map((p) => p.__eventId),
  eventId: objectPayloads.map((p) => p.__eventId).join(","),
  refEventId: objectPayloads.map((p) => p.__refEventId).filter(Boolean).join(","),
  status: objectPayloads.map((p) => p.__status).join(","),
  type: "ROAD_END",
  source: objectPayloads.length ? "resolved_road_end" : "live_events",
  resolvedFinalEvent: objectPayloads.map((p) => p.__eventId).join(","),
  currentPhase: st.phase,
  currentObject: objectId,
  currentCar: obj?.lastCarId ?? "",
  currentEarnings: totalAmount,
  statusNow: displayNowStatus,
  statusDay: displayDayStatus,
  activePeople: obj?.presentEmployeeIds ?? [],
  workingPeople: obj?.workingEmployeeIds ?? [],
  workRowsCount: workRowsForObject.length,
  workTotal: totalAmount,
  salaryRowsCount: [...payMap.payByObjectEmp.keys()].filter((key) => key.startsWith(`${objectId}||`)).length,
});

const payLines =
  [...payMap.payByObjectEmp.entries()]
    .filter(([key]) => key.startsWith(`${objectId}||`))
.map(([key, pay]) => {
  const parts = key.split("||");
  const empId = parts[1];

  if (!empId) return null;

  return `• ${mdEscapeSimple(empName(st, empId))}: *${fmtNum(pay)}*`;
})
.filter(Boolean)
    .join("\n") || "—";

    const roleSummary = payMap.roleSummaryByObject.get(String(objectId));

const roleLines = roleSummary
  ? [
      `👷 Працівники: *${fmtNum(roleSummary.workers)}*`,
      roleSummary.brigadiers > 0
        ? `👨‍🔧 Бригадири: *${fmtNum(roleSummary.brigadiers)}*`
        : "",
      roleSummary.seniors > 0
        ? `🌿 Старші садівники: *${fmtNum(roleSummary.seniors)}*`
        : "",
      `🏢 Фірма: *${fmtNum(roleSummary.company)}*`,
    ].filter(Boolean).join("\n")
  : "—";

const presentLines =
  (obj?.presentEmployeeIds ?? [])
    .map((empId) => `• ${mdEscapeSimple(empName(st, empId))}`)
    .join("\n") || "—";

const workingLines =
  (obj?.workingEmployeeIds ?? [])
    .map((empId) => `• ${mdEscapeSimple(empName(st, empId))}`)
    .join("\n") || "—";


const text =
  `🏗 *Статистика обʼєкта*\n\n` +
  `Обʼєкт: *${mdEscapeSimple(objectName(st, objectId))}*\n` +
  `📅 ${mdEscapeSimple(date)}\n` +
  `Статус дня: *${mdEscapeSimple(displayDayStatus)}*\n` +
  `Статус зараз: *${mdEscapeSimple(displayNowStatus)}*\n\n` +
  `🚗 Машини:\n${carLines}\n\n` +
  `👥 Зараз на обʼєкті:\n${presentLines}\n\n` +
  `🧱 Зараз працюють:\n${workingLines}\n\n` +
  `📏 Роботи / обсяги:\n${workLines}\n\n` +
  `⏱ Люди / години:\n${peopleLines}\n\n` +
  (
    canShowMoney
      ? `💰 Разом по роботах: *${fmtNum(totalAmount)}*\n\n📊 Розподіл:\n${roleLines}\n\n💵 Кому скільки:\n${payLines}`
      : `💰 Разом по роботах: *приховано до затвердження*`
  );

  return {
    text,
    parse_mode: "Markdown",
    kb: {
      inline_keyboard: [
        [{ text: "⬅️ Назад", callback_data: cbx(prefix, STATS_CB.OBJECTS) }],
        [{ text: TEXTS.common.backToMenu, callback_data: cbx(prefix, "MENU") }],
      ],
    },
  };
}




async function buildPersonView(params: {
  st: State;
  prefix: string;
  date: string;
  foremanTgId: number;
  employeeId: string;
}): Promise<Screen> {
  const { st, prefix, date, foremanTgId, employeeId } = params;

  const day = await buildRoadDayStats({ date, foremanTgId });
  const emp = day.employees[employeeId];

const payloads = await getResolvedRoadEndPayloads({ date, foremanTgId });
const employeePayloads = payloadsForEmployee(payloads, employeeId);
const employeeHoursByObject = new Map<string, { objectName: string; hours: number }>();

for (const payload of employeePayloads) {
  for (const pack of payload?.payrollPacks ?? []) {
    const objectId = String(pack.objectId ?? "");
    if (!objectId) continue;

    for (const row of pack.rows ?? []) {
      if (String(row.employeeId ?? "") !== String(employeeId)) continue;
      const cur = employeeHoursByObject.get(objectId) ?? {
        objectName: String(pack.objectName ?? getPayloadObjectName(payload, objectId, st)),
        hours: 0,
      };
      cur.hours += Number(row.hours ?? 0);
      employeeHoursByObject.set(objectId, cur);
    }
  }
}

const payloadObjRows = [...employeeHoursByObject.entries()].map(([objectId, row]) => ({
  objectId,
  objectName: row.objectName,
  hours: Math.round(row.hours * 100) / 100,
}));

const objLines = payloadObjRows.length
  ? payloadObjRows
      .map(
        (r: any) =>
          `• ${mdEscapeSimple(r.objectName)}: *${fmtNum(r.hours)} год*`,
      )
      .join("\n")
  : Object.entries(emp?.secByObject ?? {})
      .sort((a, b) => Number(b[1]) - Number(a[1]))
      .map(([oid, sec]) => `• ${mdEscapeSimple(objectName(st, oid))}: *${(Number(sec) / 3600).toFixed(2)} год*`)
      .join("\n") || "—";

const payloadApproved = employeePayloads.some((payload) => isApprovedStatus(payload?.__status));

const allApproved =
  payloadApproved ||
  (
    (emp?.objectIds ?? []).length > 0 &&
    (emp?.objectIds ?? []).every((oid) =>
      isApprovedStatus(day.objects[oid]?.statusDay)
    )
  );

const payMap = await buildStatsPayMap({ date, foremanTgId });

const totalAmount = [...payMap.payByObjectEmp.entries()]
  .filter(([key]) => key.endsWith(`||${employeeId}`))
  .reduce((a, [, pay]) => a + Number(pay ?? 0), 0);

auditStatsSource("PERSON_VIEW", {
  date,
  foremanTgId,
  employeeId,
  employeeName: empName(st, employeeId),
  sourceEventsCount: day.events.filter((ev: any) => {
    const ids = String(ev.employeeIds ?? "").split(",").map((x: string) => x.trim());
    return ids.includes(String(employeeId));
  }).length,
  lastRelevantEventId: (emp as any)?.lastEventId ?? "",
  lastRelevantEventType: emp?.lastEventType ?? "",
  resolvedObjectId: emp?.whereNowObjectId ?? "",
  resolvedObjectName: emp?.whereNowObjectId ? objectName(st, emp.whereNowObjectId) : "",
  resolvedCarId: emp?.whereNowCarId ?? "",
  resolvedCarName: emp?.whereNowCarId ? carName(st, emp.whereNowCarId) : "",
  approvedRoadEventsForEmployee: employeePayloads.filter((payload) => isApprovedStatus(payload?.__status)).map((p) => p.__eventId),
  salaryRowsCount: [...payMap.payByObjectEmp.keys()].filter((key) => key.endsWith(`||${employeeId}`)).length,
  salaryTotal: totalAmount,
  worksByObject: payloadObjRows.map((r: any) => ({ objectId: r.objectId, hours: r.hours })),
  eventId: employeePayloads.map((p) => p.__eventId).join(","),
  refEventId: employeePayloads.map((p) => p.__refEventId).filter(Boolean).join(","),
  status: employeePayloads.map((p) => p.__status).join(","),
  type: "ROAD_END",
  source: employeePayloads.length ? "resolved_road_end" : "live_events",
  resolvedFinalEvent: employeePayloads.map((p) => p.__eventId).join(","),
  currentPhase: st.phase,
  currentObject: emp?.whereNowObjectId ?? "",
  currentCar: emp?.whereNowCarId ?? "",
  currentEarnings: totalAmount,
  statusNow: emp?.statusNow ?? "",
  currentWork: emp?.currentWorkName ?? "",
});

const payLines =
  [...payMap.payByObjectEmp.entries()]
    .filter(([key]) => key.endsWith(`||${employeeId}`))
.map(([key, pay]) => {
  const parts = key.split("||");
  const objectId = parts[0];

  if (!objectId) return null;

  return `• ${mdEscapeSimple(objectName(st, objectId))}: *${fmtNum(pay)}*`;
})
.filter(Boolean)
.join("\n") || "—";

const roleTotals = {
  workers: 0,
  brigadiers: 0,
  seniors: 0,
  company: 0,
};

for (const [objectId, summary] of payMap.roleSummaryByObject.entries()) {
  roleTotals.workers += summary.workers;
  roleTotals.brigadiers += summary.brigadiers;
  roleTotals.seniors += summary.seniors;
  roleTotals.company += summary.company;
}

const roleLines = [
  `👷 Працівники: *${fmtNum(roleTotals.workers)}*`,
  roleTotals.brigadiers > 0
    ? `👨‍🔧 Бригадири: *${fmtNum(roleTotals.brigadiers)}*`
    : "",
  roleTotals.seniors > 0
    ? `🌿 Старші садівники: *${fmtNum(roleTotals.seniors)}*`
    : "",
  `🏢 Фірма: *${fmtNum(roleTotals.company)}*`,
]
  .filter(Boolean)
  .join("\n");


const dayFinished =
  payloadApproved ||
  st.phase === "FINISHED" ||
  st.odoEndKm !== undefined ||
  Boolean((st as any).submittedForApproval);

const statusNow = dayFinished
  ? "НА БАЗІ"
  : String(emp?.statusNow || "—");

const nowWhere = dayFinished
  ? "База"
  : emp?.whereNowObjectId
    ? `🏗 ${objectName(st, emp.whereNowObjectId)}`
    : emp?.whereNowCarId
      ? `🚗 ${carName(st, emp.whereNowCarId)}`
      : "—";

const nowWork = dayFinished
  ? "—"
  : emp?.currentWorkName
    ? `🧱 ${emp.currentWorkName}`
    : "—";

const text =
  `👤 *Статистика працівника*\n\n` +
  `Працівник: *${mdEscapeSimple(empName(st, employeeId))}*\n` +
  `📅 ${mdEscapeSimple(date)}\n` +
  `Статус зараз: *${mdEscapeSimple(statusNow)}*\n` +
  `Де зараз: *${mdEscapeSimple(nowWhere)}*\n` +
  `Що робить зараз: *${mdEscapeSimple(nowWork)}*\n\n` +
  `🏗 Обʼєкти / години:\n${objLines}\n\n` +
  (
    allApproved
      ? `💰 Разом по роботах: *${fmtNum(totalAmount)}*\n\n💵 По обʼєктах:\n${payLines}`
      : `💰 Разом по роботах: *приховано до затвердження*`
  );

  return {
    text,
    parse_mode: "Markdown",
    kb: {
      inline_keyboard: [
        [{ text: "⬅️ Назад", callback_data: cbx(prefix, STATS_CB.PEOPLE) }],
        [{ text: TEXTS.common.backToMenu, callback_data: cbx(prefix, "MENU") }],
      ],
    },
  };
}

async function buildLogisticsView(params: {
  st: State;
  prefix: string;
  date: string;
  foremanTgId: number;
  logisticId: string;
}): Promise<Screen> {
  const { st, prefix, date, foremanTgId, logisticId } = params;

  const events = await fetchEvents({ date, foremanTgId } as any);

  const logisticsEvents = (events ?? []).filter(
    (e: any) => String(e.type ?? "") === "ЛОГІСТИКА"
  );

  let logisticName = logisticId;
  let totalQty = 0;
  let totalApprovedAmount = 0;

  const allPeople = new Set<string>();
  const statusCounts = new Map<string, number>();

  for (const ev of logisticsEvents) {
    let payload: any = {};
    try {
      payload = typeof ev.payload === "string" ? JSON.parse(ev.payload) : (ev.payload ?? {});
    } catch {
      payload = {};
    }

    const items = Array.isArray(payload.items) ? payload.items : [];
    const eventStatus = String(ev.status ?? "");

    for (const it of items) {
      if (String(it.logisticId ?? "") !== String(logisticId)) continue;

      logisticName = String(it.logisticName ?? logisticName);
      totalQty += Number(it.qty ?? 0);

      const stKey = logisticStatusLabel(eventStatus);
      statusCounts.set(stKey, (statusCounts.get(stKey) ?? 0) + 1);

      for (const empId of (it.employeeIds ?? [])) {
        allPeople.add(String(empId));
      }

      if (isApprovedStatus(eventStatus)) {
        totalApprovedAmount += Number(it.tariff ?? 0) * Number(it.qty ?? 0);
      }
    }
  }

  const statusLines =
    [...statusCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([status, count]) => `• ${mdEscapeSimple(status)}: *${fmtNum(count)}*`)
      .join("\n") || "—";

  const peopleLines =
    [...allPeople]
      .map((empId) => `• ${mdEscapeSimple(empName(st, empId))}`)
      .join("\n") || "—";

  const text =
    `🚚 *Статистика логістики*\n\n` +
    `Напрямок: *${mdEscapeSimple(logisticName)}*\n` +
    `📅 ${mdEscapeSimple(date)}\n\n` +
    `🏗 Загальна к-сть обʼєктів: *${fmtNum(totalQty)}*\n\n` +
    `📌 Статуси:\n${statusLines}\n\n` +
    `👥 Люди:\n${peopleLines}\n\n` +
    `💰 Затверджена сума: *${fmtNum(totalApprovedAmount)}*`;

  return {
    text,
    parse_mode: "Markdown",
    kb: {
      inline_keyboard: [
        [{ text: "⬅️ Назад", callback_data: cbx(prefix, STATS_CB.LOGISTICS) }],
        [{ text: TEXTS.common.backToMenu, callback_data: cbx(prefix, "MENU") }],
      ],
    },
  };
}

/* ========================================================= 
 * Main handler: callbacks for stats
 * ========================================================= */
export async function handleRoadStatsCallbacks(params: {
  bot: TelegramBot;
  q: TelegramBot.CallbackQuery;
  s: any;
  data: string;

  // flow context
  prefix: string; // PREFIX з roadTimesheet.cb
  st: State;
  chatId: number;
  msgId: number;
  foremanTgId: number;
}) {
  const { bot, q, s, data, prefix, st, chatId, msgId, foremanTgId } = params;

  const date = String((st as any).date ?? todayISO());

  const d = String(data);

  // stats callbacks — тільки наші
  const isStats =
    d === cbx(prefix, STATS_CB.MENU) ||
    d === cbx(prefix, STATS_CB.CARS) ||
    d === cbx(prefix, STATS_CB.OBJECTS) ||
    d === cbx(prefix, STATS_CB.PEOPLE) ||
    d === cbx(prefix, STATS_CB.LOGISTICS) ||
    d.startsWith(cbx(prefix, STATS_CB.CAR_VIEW)) ||
    d.startsWith(cbx(prefix, STATS_CB.OBJECT_VIEW)) ||
    d.startsWith(cbx(prefix, STATS_CB.PERSON_VIEW)) ||
    d.startsWith(cbx(prefix, STATS_CB.LOGISTICS_VIEW)) ||
    d.startsWith(cbx(prefix, STATS_CB.BACK));

  if (!isStats) return false;

  // ensure meta (на випадок якщо у state не піднялось)
  await ensureCarsMeta(st);
  await ensureObjectsMeta(st);
  await ensureEmployees(st);

  // MENU
  // MENU
  if (d === cbx(prefix, STATS_CB.MENU)) {
    const scr = buildStatsMenu(prefix);
    setScreen(st, "STATS_MENU" as any, scr);

    await bot.answerCallbackQuery(q.id).catch(() => {});
    await safeEditMessageText(bot, chatId, msgId, scr.text, {
      parse_mode: scr.parse_mode,
      reply_markup: scr.kb,
    }).catch(() => {});
    return true;
  }

  if (d === cbx(prefix, STATS_CB.CARS)) {
    const scr = buildCarsList(st, prefix);
    setScreen(st, "STATS_CARS" as any, scr);

    await bot.answerCallbackQuery(q.id).catch(() => {});
    await safeEditMessageText(bot, chatId, msgId, scr.text, {
      parse_mode: scr.parse_mode,
      reply_markup: scr.kb,
    }).catch(() => {});
    return true;
  }

  if (d === cbx(prefix, STATS_CB.OBJECTS)) {
    const scr = buildObjectsList(st, prefix);
    setScreen(st, "STATS_OBJECTS" as any, scr);

    await bot.answerCallbackQuery(q.id).catch(() => {});
    await safeEditMessageText(bot, chatId, msgId, scr.text, {
      parse_mode: scr.parse_mode,
      reply_markup: scr.kb,
    }).catch(() => {});
    return true;
  }

  if (d === cbx(prefix, STATS_CB.PEOPLE)) {
    const scr = buildPeopleList(st, prefix);
    setScreen(st, "STATS_PEOPLE" as any, scr);

    await bot.answerCallbackQuery(q.id).catch(() => {});
    await safeEditMessageText(bot, chatId, msgId, scr.text, {
      parse_mode: scr.parse_mode,
      reply_markup: scr.kb,
    }).catch(() => {});
    return true;
  }

  if (d === cbx(prefix, STATS_CB.LOGISTICS)) {
    const scr = await buildLogisticsList({ st, prefix, date, foremanTgId });
    setScreen(st, "STATS_LOGISTICS" as any, scr);

    await bot.answerCallbackQuery(q.id).catch(() => {});
    await safeEditMessageText(bot, chatId, msgId, scr.text, {
      parse_mode: scr.parse_mode,
      reply_markup: scr.kb,
    }).catch(() => {});
    return true;
  }






 if (d.startsWith(cbx(prefix, STATS_CB.BACK))) {
  const scr = buildStatsMenu(prefix);
  setScreen(st, "STATS_MENU" as any, scr);

  await bot.answerCallbackQuery(q.id).catch(() => {});
  await safeEditMessageText(bot, chatId, msgId, scr.text, {
    parse_mode: scr.parse_mode,
    reply_markup: scr.kb,
  }).catch(() => {});
  return true;
}

  if (d.startsWith(cbx(prefix, STATS_CB.CAR_VIEW))) {
    const carId = d.slice(cbx(prefix, STATS_CB.CAR_VIEW).length).trim();
    const scr = await buildCarView({ st, prefix, date, foremanTgId, carId });
    setScreen(st, "STATS_CAR_VIEW" as any, scr);

    await bot.answerCallbackQuery(q.id).catch(() => {});
    await safeEditMessageText(bot, chatId, msgId, scr.text, {
      parse_mode: scr.parse_mode,
      reply_markup: scr.kb,
    }).catch(() => {});
    return true;
  }

  if (d.startsWith(cbx(prefix, STATS_CB.OBJECT_VIEW))) {
    const objectId = d.slice(cbx(prefix, STATS_CB.OBJECT_VIEW).length).trim();
    const scr = await buildObjectView({ st, prefix, date, foremanTgId, objectId });
    setScreen(st, "STATS_OBJECT_VIEW" as any, scr);

    await bot.answerCallbackQuery(q.id).catch(() => {});
    await safeEditMessageText(bot, chatId, msgId, scr.text, {
      parse_mode: scr.parse_mode,
      reply_markup: scr.kb,
    }).catch(() => {});
    return true;
  }

  if (d.startsWith(cbx(prefix, STATS_CB.PERSON_VIEW))) {
    const employeeId = d.slice(cbx(prefix, STATS_CB.PERSON_VIEW).length).trim();
    const scr = await buildPersonView({ st, prefix, date, foremanTgId, employeeId });
    setScreen(st, "STATS_PERSON_VIEW" as any, scr);

    await bot.answerCallbackQuery(q.id).catch(() => {});
    await safeEditMessageText(bot, chatId, msgId, scr.text, {
      parse_mode: scr.parse_mode,
      reply_markup: scr.kb,
    }).catch(() => {});
    return true;
  }

  if (d.startsWith(cbx(prefix, STATS_CB.LOGISTICS_VIEW))) {
    const logisticId = d.slice(cbx(prefix, STATS_CB.LOGISTICS_VIEW).length).trim();
    const scr = await buildLogisticsView({ st, prefix, date, foremanTgId, logisticId });
    setScreen(st, "STATS_LOGISTICS_VIEW" as any, scr);

    await bot.answerCallbackQuery(q.id).catch(() => {});
    await safeEditMessageText(bot, chatId, msgId, scr.text, {
      parse_mode: scr.parse_mode,
      reply_markup: scr.kb,
    }).catch(() => {});
    return true;
  }



  return true;
}

export async function openRoadStatsMenu(params: {
  bot: TelegramBot;
  chatId: number;
  s: any;
  st: State;
  prefix: string;
  foremanTgId: number;
}) {
  const { bot, chatId, st, prefix } = params;

  await ensureCarsMeta(st);
  await ensureObjectsMeta(st);
  await ensureEmployees(st);

  const scr = buildStatsMenu(prefix);
  setScreen(st, "STATS_MENU" as any, scr);

  // ✅ просто шлемо новим повідомленням
  await bot.sendMessage(chatId, scr.text, {
    parse_mode: scr.parse_mode,
    reply_markup: scr.kb,
  });
}
