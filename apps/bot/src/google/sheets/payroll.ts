// src/google/sheets/payroll.ts
import { SHEET_NAMES } from "./names.js";
import { REPORTS_HEADERS, WORKS_HEADERS, TIMESHEET_HEADERS, EVENTS_HEADERS, ODOMETER_HEADERS, SETTINGS_HEADERS } from "./headers.js";
import { loadSheet, getCell, requireHeaders } from "./core.js";
import { parseNumber, type TripClass } from "./utils.js";
import { fetchEmployees, getFixedAllowances } from "./dictionaries.js";


/**
 * ======================
 * Types
 * ======================
 */



export type PayrollRole = "WORKER" | "BRIGADIER" | "SENIOR";

export type PayrollPersonInput = {
  employeeId: string;
  employeeName: string;
  hours: number;
  coefDiscipline: number;     // 1 якщо пусто
  coefProductivity: number;   // 1 якщо пусто
  roleCoef: number;           // 1 якщо пусто (можна лишити, але для 20/5 це не ключове)
};

export type PayrollPersonComputed = PayrollPersonInput & {
  points: number;
  share: number;   // share в межах своєї "корзини" (workers pool), 0..1
  amount: number;  // total amount (workers part + manager parts if any)
  breakdown: {
    workersAmount: number;
    brigadierBonus: number;
    seniorBonus: number;
    tripAllowance: number;
    logisticsAllowance: number;
  };
};

export type PayrollSplitMeta = {
  fund: number;

  brigadierEmployeeId: string;
  seniorEmployeeId?: string;

  pct: {
    brigadier: number; // 0.20
    senior: number;    // 0 або 0.05
    workers: number;   // 0.75..0.80
  };

  pools: {
    brigadierFund: number;
    seniorFund: number;
    workersFund: number;
  };

  totalWorkersPoints: number;
};

export type PayrollSplitResult = {
  meta: PayrollSplitMeta;
  people: PayrollPersonComputed[];
};

/**
 * ======================
 * 1) FUND
 * ======================
 * MVP фонд = Σ(volume * tariff(workId)) з REPORTS для date+objectId
 * tariff беремо з WORKS по workId (JOIN)
 */
export async function computeFundByObject(date: string, objectId: string): Promise<number> {
  // 1) WORKS -> map workId -> tariff
  const worksSh = await loadSheet(SHEET_NAMES.works);

  requireHeaders(worksSh.map, [WORKS_HEADERS.id, WORKS_HEADERS.tariff], SHEET_NAMES.works);

  const tariffByWorkId = new Map<string, number>();
  for (const r of worksSh.data) {
    const id = String(getCell(r, worksSh.map, WORKS_HEADERS.id) ?? "").trim();
    if (!id) continue;

    const tariff = parseNumber(getCell(r, worksSh.map, WORKS_HEADERS.tariff));
    if (Number.isFinite(tariff)) tariffByWorkId.set(id, tariff);
  }

  // 2) REPORTS -> sum volume * tariff(workId)
  const repSh = await loadSheet(SHEET_NAMES.reports);

  requireHeaders(
    repSh.map,
    [REPORTS_HEADERS.date, REPORTS_HEADERS.objectId, REPORTS_HEADERS.workId, REPORTS_HEADERS.volume],
    SHEET_NAMES.reports
  );

  let fund = 0;

  for (const r of repSh.data) {
    const d = String(getCell(r, repSh.map, REPORTS_HEADERS.date) ?? "").trim();
    const o = String(getCell(r, repSh.map, REPORTS_HEADERS.objectId) ?? "").trim();
    if (d !== date || o !== objectId) continue;

    const workId = String(getCell(r, repSh.map, REPORTS_HEADERS.workId) ?? "").trim();
    const volume = parseNumber(getCell(r, repSh.map, REPORTS_HEADERS.volume));

    if (!workId) continue;
    if (!Number.isFinite(volume) || volume <= 0) continue;

    const tariff = tariffByWorkId.get(workId);

    // строгий режим — щоб одразу бачити косяк даних
    if (!Number.isFinite(tariff as any)) {
      throw new Error(`PAYROLL: не знайдено tariff для workId="${workId}" у листі WORKS`);
    }

    fund += volume * (tariff as number);
  }

  return round2(fund);
}

/**
 * ======================
 * 2) POINTS
 * ======================
 * points = hours * coefDiscipline * coefProductivity * roleCoef
 */
export function computePoints(
  hours: number,
  coefDiscipline: number,
  coefProductivity: number,
  roleCoef = 1
): number {
  const h = safePos(hours);
  const cd = safePos(coefDiscipline, 1);
  const cp = safePos(coefProductivity, 1);
  const rc = safePos(roleCoef, 1);

  if (h <= 0) return 0;
  return round3(h * cd * cp * rc);
}

/**
 * ======================
 * 3) SPLIT: 20% / 5% / 75–80
 * ======================
 *
 * - 20% -> brigadier
 * - 5% -> senior (якщо є)
 * - решта -> workers pool, ділимо по points між усіма з табелю
 *
 * IMPORTANT:
 * - якщо бригадир/старший також у табелі, вони отримають і "bonus", і "workers part".
 * - якщо senior немає, 5% переходить у workers pool (=> workers 80%).
 */
export function splitFund_20_5_workers(
  fund: number,
  people: PayrollPersonInput[],
  opts: {
    brigadierEmployeeId: string;
    seniorEmployeeId?: string;
    seniorSharePct?: number; // default 0.05
    brigadierSharePct?: number; // default 0.20
  }
): PayrollSplitResult {
  const cleanFund = round2(Math.max(0, Number(fund) || 0));

  const BRIG_PCT = clamp01(opts.brigadierSharePct ?? 0.2);
  const SEN_PCT_BASE = clamp01(opts.seniorSharePct ?? 0.05);

  const brigadierEmployeeId = String(opts.brigadierEmployeeId ?? "").trim();
  if (!brigadierEmployeeId) {
    throw new Error("PAYROLL: brigadierEmployeeId is required for 20% split");
  }

  const seniorEmployeeId = String(opts.seniorEmployeeId ?? "").trim() || undefined;
  const hasSenior = Boolean(seniorEmployeeId);

  const seniorPct = hasSenior ? SEN_PCT_BASE : 0;
  const workersPct = clamp01(1 - BRIG_PCT - seniorPct);

  const brigadierFund = round2(cleanFund * BRIG_PCT);
  const seniorFund = round2(cleanFund * seniorPct);
  const workersFund = round2(cleanFund - brigadierFund - seniorFund);

  // compute points
  const computedBase: PayrollPersonComputed[] = people.map((p) => {
    const points = computePoints(p.hours, p.coefDiscipline, p.coefProductivity, p.roleCoef);
    return {
      ...p,
      points,
      share: 0,
      amount: 0,
      breakdown: {
        workersAmount: 0,
        brigadierBonus: 0,
        seniorBonus: 0,
        tripAllowance: 0,
        logisticsAllowance: 0,
      },
    };
  });

  const totalWorkersPoints = round3(computedBase.reduce((sum, p) => sum + (Number(p.points) || 0), 0));

  // workers split by points
  let allocatedWorkers = 0;

  if (workersFund > 0 && totalWorkersPoints > 0 && computedBase.length > 0) {
    for (const [i, p] of computedBase.entries()) {
      const share = p.points / totalWorkersPoints;

      const workersAmount =
        i === computedBase.length - 1
          ? Math.round((workersFund - allocatedWorkers) * 100) / 100
          : Math.round(workersFund * share * 100) / 100;

      computedBase[i] = {
        ...p,
        share,
        breakdown: { ...p.breakdown, workersAmount },
      };

      allocatedWorkers += workersAmount;
    }
  }

  // add bonuses (20% brigadier, 5% senior)
  for (const [i, p] of computedBase.entries()) {
    const brigadierBonus = p.employeeId === brigadierEmployeeId ? brigadierFund : 0;
    const seniorBonus = seniorEmployeeId && p.employeeId === seniorEmployeeId ? seniorFund : 0;

    const workersAmount = p.breakdown.workersAmount;

    const tripAllowance = p.breakdown?.tripAllowance ?? 0;

    computedBase[i] = {
      ...p,
      breakdown: {
        workersAmount,
        brigadierBonus: round2(brigadierBonus),
        seniorBonus: round2(seniorBonus),
        tripAllowance,
        logisticsAllowance: 0,
      },
      amount: round2(workersAmount + brigadierBonus + seniorBonus),
    };
  }

  // якщо бригадир/старший НЕ в табелі — їм все одно треба видати bonus
  // (інакше гроші "зникнуть"). У такому випадку додаємо технічний рядок.
  let peopleOut = [...computedBase];

  const hasBrigadierRow = peopleOut.some((p) => p.employeeId === brigadierEmployeeId);
  if (!hasBrigadierRow && brigadierFund > 0) {
    peopleOut.push({
      employeeId: brigadierEmployeeId,
      employeeName: "Бригадир",
      hours: 0,
      coefDiscipline: 1,
      coefProductivity: 1,
      roleCoef: 1,
      points: 0,
      share: 0,
      breakdown: {
        workersAmount: 0,
        brigadierBonus: brigadierFund,
        seniorBonus: 0,
        tripAllowance: 0,
        logisticsAllowance: 0,
      },
      amount: brigadierFund,
    });
  }

  const hasSeniorRow = seniorEmployeeId ? peopleOut.some((p) => p.employeeId === seniorEmployeeId) : true;
  if (seniorEmployeeId && !hasSeniorRow && seniorFund > 0) {
    peopleOut.push({
      employeeId: seniorEmployeeId,
      employeeName: "Старший",
      hours: 0,
      coefDiscipline: 1,
      coefProductivity: 1,
      roleCoef: 1,
      points: 0,
      share: 0,
      breakdown: {
        workersAmount: 0,
        brigadierBonus: 0,
        seniorBonus: seniorFund,
        tripAllowance: 0,
        logisticsAllowance: 0,
      },
      amount: seniorFund,
    });
  }

  // стабільний порядок (щоб не стрибало)
  peopleOut.sort((a, b) => a.employeeId.localeCompare(b.employeeId));

  return {
    meta: {
      fund: cleanFund,
      brigadierEmployeeId,
      ...(seniorEmployeeId ? { seniorEmployeeId } : {}),
      pct: {
        brigadier: BRIG_PCT,
        senior: seniorPct,
        workers: workersPct,
      },
      pools: {
        brigadierFund,
        seniorFund,
        workersFund,
      },
      totalWorkersPoints,
    },
    people: peopleOut,
  };
}

/**
 * ======================
 * READY-TO-USE: compute payroll for object
 * ======================
 * - fund через REPORTS+WORKS
 * - люди з TIMESHEET (date+objectId)
 * - brigadier/senior визначаємо по EMPLOYEES.role (якщо є), або можна передати override
 *
 * Важливо:
 * - якщо бригадир працював фізично — він буде у табелі => отримає workers part + 20%
 */
export async function computePayrollByObject(
  date: string,
  objectId: string,
  foremanTgId: number,
  overrides?: {
    brigadierEmployeeId?: string;
    seniorEmployeeId?: string; // якщо хочеш примусово вказати
  }
): Promise<PayrollSplitResult> {
  const fund = await computeFundByObject(date, objectId);

  // timesheet read
  const tsSh = await loadSheet(SHEET_NAMES.timesheet);

  requireHeaders(
    tsSh.map,
    [
      TIMESHEET_HEADERS.date,
      TIMESHEET_HEADERS.objectId,
      TIMESHEET_HEADERS.employeeId,
      TIMESHEET_HEADERS.employeeName,
      TIMESHEET_HEADERS.hours,
    ],
    SHEET_NAMES.timesheet
  );

  const hasCoefDiscipline = tsSh.map[TIMESHEET_HEADERS.disciplineCoef] !== undefined;
  const hasCoefProductivity = tsSh.map[TIMESHEET_HEADERS.productivityCoef] !== undefined;

  // employees role maps (optional, but бажано щоб було)
  const roleByEmployeeId = await buildRoleMapSafe();

  const people: PayrollPersonInput[] = [];

  for (const r of tsSh.data) {
    const d = String(getCell(r, tsSh.map, TIMESHEET_HEADERS.date) ?? "").trim();
    const o = String(getCell(r, tsSh.map, TIMESHEET_HEADERS.objectId) ?? "").trim();
    if (d !== date || o !== objectId) continue;

    const employeeId = String(getCell(r, tsSh.map, TIMESHEET_HEADERS.employeeId) ?? "").trim();
    const employeeName = String(getCell(r, tsSh.map, TIMESHEET_HEADERS.employeeName) ?? "").trim();

    const hours = parseNumber(getCell(r, tsSh.map, TIMESHEET_HEADERS.hours));
    if (!employeeId || !employeeName) continue;
    if (!Number.isFinite(hours) || hours <= 0) continue;

    const coefDiscipline = hasCoefDiscipline
      ? parseNumber(getCell(r, tsSh.map, TIMESHEET_HEADERS.disciplineCoef))
      : 1;

    const coefProductivity = hasCoefProductivity
      ? parseNumber(getCell(r, tsSh.map, TIMESHEET_HEADERS.productivityCoef))
      : 1;

    // roleCoef тут залишаємо як є (на майбутнє), але на 20/5 він не впливає.
    const roleCoef = 1;

    people.push({
      employeeId,
      employeeName,
      hours,
      coefDiscipline: Number.isFinite(coefDiscipline) && coefDiscipline > 0 ? coefDiscipline : 1,
      coefProductivity: Number.isFinite(coefProductivity) && coefProductivity > 0 ? coefProductivity : 1,
      roleCoef,
    });
  }

  // stable order
  people.sort((a, b) => a.employeeId.localeCompare(b.employeeId));

  // determine brigadier/senior
  const brigadierEmployeeId =
    String(overrides?.brigadierEmployeeId ?? "").trim() ||
    findByRoleInTimesheet(people, roleByEmployeeId, "BRIGADIER") ||
    ""; // якщо пусто — нижче кинемо помилку

  const seniorEmployeeId =
    String(overrides?.seniorEmployeeId ?? "").trim() ||
    pickSeniorCandidate(people, roleByEmployeeId); // undefined якщо нема

  if (!brigadierEmployeeId) {
    throw new Error(
      `PAYROLL: не можу визначити бригадира для date=${date} objectId=${objectId}. ` +
      `Передай overrides.brigadierEmployeeId або заповни роль BRIGADIER у EMPLOYEES.`
    );
  }

    // ===== Trip allowance (виїзд) =====
  const { road } = await getFixedAllowances();
  const tripDay = await getTripDayByForeman(date, foremanTgId);
  const roadPeople = await getRoadPeopleFromTimeline(date, foremanTgId);

  let tripClass: TripClass | null = null;
  let tripKmDay = 0;
  let tripTotal = 0;
  let tripPerPerson = 0;

  if (tripDay && roadPeople.length) {
    tripClass = tripDay.tripClass;
    tripKmDay = tripDay.kmDay;
    tripTotal = tripClass ? Math.max(0, Number(road[tripClass]) || 0) : 0;
    tripPerPerson = roadPeople.length ? Math.round((tripTotal / roadPeople.length) * 100) / 100 : 0;
  }

   

  const res = splitFund_20_5_workers(fund, people, {
    brigadierEmployeeId,
    ...(seniorEmployeeId ? { seniorEmployeeId } : {}),
  });

  const roadSet = new Set(roadPeople);

  for (const p of res.people) {
    const add = tripPerPerson > 0 && roadSet.has(p.employeeId) ? tripPerPerson : 0;

    p.breakdown.tripAllowance = add;
    p.amount = round2(p.amount + add);
  }

  // (опційно) додай в meta інфу про виїзд, щоб в UI показувати
  (res.meta as any).trip = {
    class: tripClass ?? "",
    kmDay: tripKmDay,
    total: tripTotal,
    perPerson: tripPerPerson,
    people: roadPeople,
  };

    // ===== Logistics allowance (логістика) =====
  const logistics = await getLogisticsFromEvents(date, objectId, foremanTgId);

  // Якщо хочеш дефолт, коли в події не передали суму:
  // const fixed = await getFixedAllowances();
  // const logisticsTotal = logistics.total > 0 ? logistics.total : (Number(fixed?.logistics) || 0);
  // const logisticsPerPerson = splitEqual(logisticsTotal, logistics.people);

  const logisticsPerPerson = splitEqual(logistics.total, logistics.people);
  const logisticsSet = new Set(logistics.people);

  for (const p of res.people) {
    const add = logisticsPerPerson > 0 && logisticsSet.has(p.employeeId) ? logisticsPerPerson : 0;

    p.breakdown.logisticsAllowance = add;
    p.amount = round2(p.amount + add);
  }

  (res.meta as any).logistics = {
    total: logistics.total,
    perPerson: logisticsPerPerson,
    people: logistics.people,
  };


  return res;


}

/**
 * ======================
 * Helpers
 * ======================
 */

function round2(n: number) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function round3(n: number) {
  return Math.round((Number(n) || 0) * 1000) / 1000;
}

function safePos(n: number, fallback = 0) {
  const v = Number(n);
  if (!Number.isFinite(v)) return fallback;
  if (v < 0) return fallback;
  return v;
}

function clamp01(x: number) {
  const n = Number(x);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

async function buildRoleMapSafe(): Promise<Map<string, PayrollRole>> {
  try {
    const emps = await fetchEmployees();
    const m = new Map<string, PayrollRole>();

    for (const e of emps as any[]) {
      const id = String(e?.id ?? "").trim();
      if (!id) continue;

      const raw = String(e?.role ?? e?.position ?? e?.grade ?? "").trim().toLowerCase();

      // ТУТ підлаштуєш під свої значення з EMPLOYEES:
      // "бригадир", "старший", "робітник" / "worker" etc
      if (raw.includes("бригадир") || raw.includes("brig")) m.set(id, "BRIGADIER");
      else if (raw.includes("старш") || raw.includes("senior")) m.set(id, "SENIOR");
      else m.set(id, "WORKER");
    }

    return m;
  } catch {
    return new Map();
  }
}

function findByRoleInTimesheet(
  people: PayrollPersonInput[],
  roleByEmployeeId: Map<string, PayrollRole>,
  role: PayrollRole
): string | undefined {
  for (const p of people) {
    if (roleByEmployeeId.get(p.employeeId) === role) return p.employeeId;
  }
  return undefined;
}

/**
 * Якщо старших кілька — беремо того, у кого більше points (логічно як "старший зміни").
 * Якщо взагалі нема — undefined і 5% піде в workers pool.
 */
function pickSeniorCandidate(
  people: PayrollPersonInput[],
  roleByEmployeeId: Map<string, PayrollRole>
): string | undefined {
  let bestId: string | undefined;
  let bestPoints = -1;

  for (const p of people) {
    if (roleByEmployeeId.get(p.employeeId) !== "SENIOR") continue;

    const pts = computePoints(p.hours, p.coefDiscipline, p.coefProductivity, p.roleCoef);
    if (pts > bestPoints) {
      bestPoints = pts;
      bestId = p.employeeId;
    }
  }

  return bestId;
}

async function getTripDayByForeman(date: string, foremanTgId: number) {
  const sh = await loadSheet(SHEET_NAMES.odometerDay);
  requireHeaders(
    sh.map,
    [
      ODOMETER_HEADERS.date,
      ODOMETER_HEADERS.foremanTgId,
      ODOMETER_HEADERS.kmDay,
      ODOMETER_HEADERS.tripClass,
    ],
    SHEET_NAMES.odometerDay
  );

  // якщо за день може бути кілька авто — беремо максимальний кмDay (найлогічніше)
  let best: { kmDay: number; tripClass: TripClass } | null = null;

  for (const r of sh.data) {
    const d = String(getCell(r, sh.map, ODOMETER_HEADERS.date) ?? "").trim();
    const f = parseNumber(getCell(r, sh.map, ODOMETER_HEADERS.foremanTgId));
    if (d !== date || f !== foremanTgId) continue;

    const kmDay = parseNumber(getCell(r, sh.map, ODOMETER_HEADERS.kmDay));
    const tc = String(getCell(r, sh.map, ODOMETER_HEADERS.tripClass) ?? "").trim() as TripClass;

    if (!tc) continue;
    if (kmDay == null || !Number.isFinite(kmDay)) continue;
    if (!best || kmDay > best.kmDay) best = { kmDay, tripClass: tc };
  }

  return best; // null якщо нема виїзду
}

async function getRoadPeopleFromTimeline(date: string, foremanTgId: number): Promise<string[]> {
  // беремо останній ROAD_END з objectId="" (timeline)
  const sh = await loadSheet(SHEET_NAMES.events);
  requireHeaders(
    sh.map,
    [EVENTS_HEADERS.date, EVENTS_HEADERS.foremanTgId, EVENTS_HEADERS.type, EVENTS_HEADERS.objectId, EVENTS_HEADERS.employeeIds, EVENTS_HEADERS.ts, EVENTS_HEADERS.status],
    SHEET_NAMES.events
  );

  let bestTs = "";
  let bestIds: string[] = [];

  for (const r of sh.data) {
    const d = String(getCell(r, sh.map, EVENTS_HEADERS.date) ?? "").trim();
    const f = parseNumber(getCell(r, sh.map, EVENTS_HEADERS.foremanTgId));
    if (d !== date || f !== foremanTgId) continue;

    const status = String(getCell(r, sh.map, EVENTS_HEADERS.status) ?? "").trim();
    if (status && status !== "АКТИВНА") continue;

    const type = String(getCell(r, sh.map, EVENTS_HEADERS.type) ?? "").trim();
    if (type !== "ROAD_END") continue;

    const objectId = String(getCell(r, sh.map, EVENTS_HEADERS.objectId) ?? "").trim();
    if (objectId !== "") continue; // саме timeline

    const ts = String(getCell(r, sh.map, EVENTS_HEADERS.ts) ?? "").trim();
    const idsCsv = String(getCell(r, sh.map, EVENTS_HEADERS.employeeIds) ?? "").trim();

    if (!idsCsv) continue;
    if (ts >= bestTs) {
      bestTs = ts;
      bestIds = idsCsv.split(",").map(x => x.trim()).filter(Boolean);
    }
  }

  return bestIds;
}

async function getLogisticsFromEvents(date: string, objectId: string, foremanTgId: number): Promise<{
  total: number;
  people: string[];
}> {
  const sh = await loadSheet(SHEET_NAMES.events);

  // Мінімально потрібні
  requireHeaders(
    sh.map,
    [EVENTS_HEADERS.date, EVENTS_HEADERS.objectId, EVENTS_HEADERS.foremanTgId, EVENTS_HEADERS.type, EVENTS_HEADERS.status, EVENTS_HEADERS.ts],
    SHEET_NAMES.events
  );

  const hasEmployeeIdsCol = sh.map[EVENTS_HEADERS.employeeIds] !== undefined;
  const hasPayloadCol = sh.map[EVENTS_HEADERS.payload] !== undefined;

  // price/amount можуть називатись по-різному — пробуємо обидва варіанти
  const hasPriceCol = (sh.map as any)[EVENTS_HEADERS.price] !== undefined;
  const hasAmountCol = (sh.map as any)[EVENTS_HEADERS.amount] !== undefined;

  let bestTs = "";
  let bestRow: any | null = null;

  for (const r of sh.data) {
    const d = String(getCell(r, sh.map, EVENTS_HEADERS.date) ?? "").trim();
    const o = String(getCell(r, sh.map, EVENTS_HEADERS.objectId) ?? "").trim();
    const f = String(getCell(r, sh.map, EVENTS_HEADERS.foremanTgId) ?? "").trim();
    const type = String(getCell(r, sh.map, EVENTS_HEADERS.type) ?? "").trim();
    const st = String(getCell(r, sh.map, EVENTS_HEADERS.status) ?? "").trim();

    if (d !== date || o !== objectId || f !== String(foremanTgId)) continue;
    if (type !== "ЛОГІСТИКА") continue;
    if (st && st !== "АКТИВНА") continue;

    const ts = String(getCell(r, sh.map, EVENTS_HEADERS.ts) ?? "").trim();
    if (!bestRow || ts >= bestTs) {
      bestTs = ts;
      bestRow = r;
    }
  }

  if (!bestRow) return { total: 0, people: [] };

  // --- people ---
  let people: string[] = [];

  if (hasEmployeeIdsCol) {
    const csv = String(getCell(bestRow, sh.map, EVENTS_HEADERS.employeeIds) ?? "").trim();
    if (csv) people = csv.split(",").map(x => x.trim()).filter(Boolean);
  }

  // fallback: payload.employeeIds
  if (!people.length && hasPayloadCol) {
    try {
      const p = JSON.parse(String(getCell(bestRow, sh.map, EVENTS_HEADERS.payload) ?? "{}"));
      const raw = p?.employeeIds;
      if (Array.isArray(raw)) people = raw.map((x: any) => String(x).trim()).filter(Boolean);
      else if (typeof raw === "string") people = raw.split(",").map((x: string) => x.trim()).filter(Boolean);
    } catch {}
  }

  // --- total ---
  let total = 0;

  if (hasPriceCol) {
    total = parseNumber(getCell(bestRow, sh.map as any, (EVENTS_HEADERS as any).price));
  } else if (hasAmountCol) {
    total = parseNumber(getCell(bestRow, sh.map as any, (EVENTS_HEADERS as any).amount));
  }

  if (!Number.isFinite(total) || total <= 0) {
    // fallback: payload.price / payload.amount
    if (hasPayloadCol) {
      try {
        const p = JSON.parse(String(getCell(bestRow, sh.map, EVENTS_HEADERS.payload) ?? "{}"));
        total = parseNumber(p?.price ?? p?.amount);
      } catch {}
    }
  }

  total = Number.isFinite(total) && total > 0 ? total : 0;

  return { total: round2(total), people };
}

function splitEqual(total: number, people: string[]): number {
  const t = round2(Math.max(0, Number(total) || 0));
  const n = people.length;
  if (!n || t <= 0) return 0;
  return Math.round((t / n) * 100) / 100;
}
