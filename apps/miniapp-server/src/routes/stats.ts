import { Router } from "express";
import { db, schema } from "@landscape/core";
import { and, eq, gte, lte, sql } from "drizzle-orm";

export const statsRouter = Router();

const round2 = (n: number) => Math.round(n * 100) / 100;

type SalaryRowPayload = { employeeId: string; employeeName: string; pay: number };
type SalaryPackPayload = { objectId: string; objectName: string; objectTotal: number; rows: SalaryRowPayload[] };
type WorkPayload = { workId: string; workName: string; volume?: string | number; employeeIds?: string[] };
type ObjectPayload = { objectId: string; objectName: string; works?: WorkPayload[] };
type RtsSavePayload = {
  km?: number;
  tripClass?: string;
  objects?: ObjectPayload[];
  salaryPacks?: SalaryPackPayload[];
  roadAllowance?: { perPerson: number };
};

/**
 * GET /api/stats/range?from=YYYY-MM-DD&to=YYYY-MM-DD — aggregated stats over
 * a date range, grouped by object / employee / car. Money and per-work
 * "who did it" come from the RTS_SAVE event payload (the only place the
 * bot's role-split payroll numbers are actually persisted -- reports/
 * timesheetEntries have volumes and hours but not pay); real hours and
 * volumes come from timesheetEntries/reports since those already reflect
 * edit/resubmit reconciliation. If a day was submitted more than once, only
 * the latest submission counts (matches how editing-and-resubmitting is
 * meant to fully replace the previous attempt everywhere else in this app).
 * Scoped to the caller's own foreman data -- unless they're an ADMIN, in
 * which case every foreman's data is included, unfiltered and unmasked.
 */
statsRouter.get("/range", async (req, res) => {
  const from = String(req.query.from || "");
  const to = String(req.query.to || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    res.status(400).json({ error: "from and to (YYYY-MM-DD) query params are required" });
    return;
  }
  // Admins see every foreman's data in range; a brigadier only ever sees
  // their own -- same rule as everywhere else in the app (role comes from
  // the КОРИСТУВАЧІ dictionary via requireTelegramAuth, not client input).
  const isAdmin = req.user!.role === "ADMIN";
  const foremanTgId = BigInt(req.user!.tgId);

  const [eventRows, reportRows, odoRows, timesheetRows, worksDict, objectsDict, employeesDict, carsDict] = await Promise.all([
    db
      .select()
      .from(schema.events)
      .where(
        isAdmin
          ? and(eq(schema.events.type, "RTS_SAVE"), gte(schema.events.date, from), lte(schema.events.date, to))
          : and(eq(schema.events.type, "RTS_SAVE"), eq(schema.events.foremanTgId, foremanTgId), gte(schema.events.date, from), lte(schema.events.date, to)),
      ),
    db
      .select()
      .from(schema.reports)
      .where(
        isAdmin
          ? and(gte(schema.reports.date, from), lte(schema.reports.date, to))
          : and(eq(schema.reports.foremanTgId, foremanTgId), gte(schema.reports.date, from), lte(schema.reports.date, to)),
      ),
    db
      .select()
      .from(schema.odometerDays)
      .where(
        isAdmin
          ? and(gte(schema.odometerDays.date, from), lte(schema.odometerDays.date, to))
          : and(eq(schema.odometerDays.foremanTgId, foremanTgId), gte(schema.odometerDays.date, from), lte(schema.odometerDays.date, to)),
      ),
    db.select().from(schema.timesheetEntries).where(and(gte(schema.timesheetEntries.date, from), lte(schema.timesheetEntries.date, to))),
    db.select().from(schema.works),
    db.select().from(schema.objects),
    db.select().from(schema.employees),
    db.select().from(schema.cars),
  ]);

  const workUnitById = new Map(worksDict.map((w) => [w.id, w.unit ?? ""]));
  const objectNameById = new Map(objectsDict.map((o) => [o.id, o.name]));
  const employeeNameById = new Map(employeesDict.map((e) => [e.id, e.name]));
  const carNameById = new Map(carsDict.map((c) => [c.id, c.name]));

  // Only the latest RTS_SAVE per (date, foreman) counts -- a resubmit fully
  // replaces it. Keyed by foreman too (not just date), since an admin's
  // query spans every foreman -- two different foremen submitting on the
  // same date must not clobber each other down to a single "latest" row.
  const latestEventByDate = new Map<string, (typeof eventRows)[number]>();
  for (const e of eventRows) {
    const key = `${e.date}|${e.foremanTgId}`;
    const cur = latestEventByDate.get(key);
    if (!cur || e.ts > cur.ts) latestEventByDate.set(key, e);
  }

  // Same rule as /road-timesheet/day-status: a day only counts as approved
  // once the admin flow sets the event's status to "ЗАТВЕРДЖЕНО". If any date
  // in range is still pending, mask all money in the response -- showing a
  // mix of approved and pending amounts in one aggregated total would let a
  // brigadier back out the pending day's numbers by diffing totals. Doesn't
  // apply to admins -- they already see real, unmasked amounts everywhere
  // else (e.g. the "Затвердження" review screen), so masking here would
  // just be inconsistent.
  const pendingDates = isAdmin
    ? []
    : [...latestEventByDate.entries()]
        .filter(([, e]) => e.status !== "ЗАТВЕРДЖЕНО")
        .map(([, e]) => e.date)
        .sort();
  const moneyApproved = isAdmin || pendingDates.length === 0;

  const parsedEvents = [...latestEventByDate.values()].map((e) => {
    let payload: RtsSavePayload = {};
    try {
      payload = JSON.parse(e.payload ?? "{}");
    } catch {
      payload = {};
    }
    let employeeIds: string[] = [];
    try {
      employeeIds = JSON.parse(e.employeeIds ?? "[]");
    } catch {
      employeeIds = [];
    }
    return { date: e.date, carId: e.carId, employeeIds, ...payload };
  });

  // (date, employeeId) pairs this foreman actually submitted a trip for --
  // timesheetEntries has no foremanTgId column (an employee can only be one
  // place at a time, so it's a single shared record per date+object), so
  // this is how we scope it to "mine". Keyed by employee, not just
  // date+objectId: two different foremen can each submit to the SAME object
  // on the SAME date with different crews, and a date+objectId-only key
  // would leak the other foreman's employees' hours into this one's totals.
  const myDateEmployeeKeys = new Set<string>();
  for (const e of parsedEvents) for (const empId of e.employeeIds) myDateEmployeeKeys.add(`${e.date}|${empId}`);

  type ObjAgg = {
    objectId: string;
    objectName: string;
    totalFund: number;
    works: Map<string, { workName: string; unit: string; totalVolume: number; employeeNames: Set<string> }>;
    employees: Map<string, { employeeName: string; hours: number; pay: number }>;
  };
  const objAggs = new Map<string, ObjAgg>();
  function getObjAgg(objectId: string, objectName: string): ObjAgg {
    let agg = objAggs.get(objectId);
    if (!agg) {
      agg = { objectId, objectName, totalFund: 0, works: new Map(), employees: new Map() };
      objAggs.set(objectId, agg);
    }
    return agg;
  }

  for (const r of reportRows) {
    const vol = Number(r.volume);
    if (!Number.isFinite(vol)) continue;
    const agg = getObjAgg(r.objectId, objectNameById.get(r.objectId) ?? r.objectId);
    const w = agg.works.get(r.workId) ?? { workName: r.workName, unit: workUnitById.get(r.workId) ?? "", totalVolume: 0, employeeNames: new Set<string>() };
    w.totalVolume += vol;
    agg.works.set(r.workId, w);
  }

  for (const e of parsedEvents) {
    for (const o of e.objects ?? []) {
      const agg = getObjAgg(o.objectId, o.objectName);
      for (const w of o.works ?? []) {
        const wAgg = agg.works.get(w.workId) ?? { workName: w.workName, unit: workUnitById.get(w.workId) ?? "", totalVolume: 0, employeeNames: new Set<string>() };
        for (const empId of w.employeeIds ?? []) wAgg.employeeNames.add(employeeNameById.get(empId) ?? empId);
        agg.works.set(w.workId, wAgg);
      }
    }
    for (const pack of e.salaryPacks ?? []) {
      const agg = getObjAgg(pack.objectId, pack.objectName);
      agg.totalFund += pack.objectTotal ?? 0;
      for (const row of pack.rows ?? []) {
        const emp = agg.employees.get(row.employeeId) ?? { employeeName: row.employeeName, hours: 0, pay: 0 };
        emp.pay += row.pay ?? 0;
        agg.employees.set(row.employeeId, emp);
      }
    }
  }

  for (const t of timesheetRows) {
    if (!myDateEmployeeKeys.has(`${t.date}|${t.employeeId}`)) continue;
    const agg = getObjAgg(t.objectId, objectNameById.get(t.objectId) ?? t.objectId);
    const emp = agg.employees.get(t.employeeId) ?? { employeeName: t.employeeName, hours: 0, pay: 0 };
    emp.hours += t.hours ?? 0;
    agg.employees.set(t.employeeId, emp);
  }

  // Road allowance is per-trip, not per-object -- tracked separately per employee.
  const allowanceByEmployee = new Map<string, number>();
  for (const e of parsedEvents) {
    if (!e.roadAllowance) continue;
    for (const empId of e.employeeIds) {
      allowanceByEmployee.set(empId, (allowanceByEmployee.get(empId) ?? 0) + e.roadAllowance.perPerson);
    }
  }

  type EmpAgg = {
    employeeId: string;
    employeeName: string;
    totalHours: number;
    totalPay: number;
    objects: Map<string, { objectId: string; objectName: string; hours: number; pay: number }>;
  };
  const empAggs = new Map<string, EmpAgg>();
  for (const o of objAggs.values()) {
    for (const [employeeId, e] of o.employees) {
      const agg = empAggs.get(employeeId) ?? {
        employeeId,
        employeeName: e.employeeName,
        totalHours: 0,
        totalPay: 0,
        objects: new Map(),
      };
      agg.totalHours += e.hours;
      agg.totalPay += e.pay;
      agg.objects.set(o.objectId, { objectId: o.objectId, objectName: o.objectName, hours: round2(e.hours), pay: round2(e.pay) });
      empAggs.set(employeeId, agg);
    }
  }
  // Riders who took the trip but did no billable object work still show up
  // (with 0 hours/pay) so the road allowance itself is visible per person.
  for (const e of parsedEvents) {
    for (const empId of e.employeeIds) {
      if (!empAggs.has(empId)) {
        empAggs.set(empId, { employeeId: empId, employeeName: employeeNameById.get(empId) ?? empId, totalHours: 0, totalPay: 0, objects: new Map() });
      }
    }
  }

  const odoByDateCar = new Map(odoRows.map((o) => [`${o.date}|${o.carId}`, o.kmDay ?? 0]));
  type CarAgg = {
    carId: string;
    carName: string;
    totalKm: number;
    days: Array<{ date: string; km: number; tripClass: string; riderNames: string[]; objectNames: string[] }>;
  };
  const carAggs = new Map<string, CarAgg>();
  for (const e of parsedEvents) {
    if (!e.carId) continue;
    const agg = carAggs.get(e.carId) ?? { carId: e.carId, carName: carNameById.get(e.carId) ?? e.carId, totalKm: 0, days: [] };
    const km = odoByDateCar.get(`${e.date}|${e.carId}`) ?? e.km ?? 0;
    agg.totalKm += km;
    agg.days.push({
      date: e.date,
      km: round2(km),
      tripClass: e.tripClass ?? "",
      riderNames: e.employeeIds.map((id) => employeeNameById.get(id) ?? id),
      objectNames: (e.objects ?? []).map((o) => o.objectName),
    });
    carAggs.set(e.carId, agg);
  }

  res.json({
    from,
    to,
    moneyApproved,
    pendingDates,
    byObject: [...objAggs.values()]
      .map((o) => ({
        objectId: o.objectId,
        objectName: o.objectName,
        totalFund: round2(o.totalFund),
        works: [...o.works.values()]
          .map((w) => ({ workName: w.workName, unit: w.unit, totalVolume: round2(w.totalVolume), employeeNames: [...w.employeeNames] }))
          .sort((a, b) => a.workName.localeCompare(b.workName)),
        employees: [...o.employees.values()]
          .map((e) => ({ employeeName: e.employeeName, hours: round2(e.hours), pay: round2(e.pay) }))
          .sort((a, b) => a.employeeName.localeCompare(b.employeeName)),
      }))
      .sort((a, b) => a.objectName.localeCompare(b.objectName)),
    byEmployee: [...empAggs.values()]
      .map((e) => {
        const allowance = allowanceByEmployee.get(e.employeeId) ?? 0;
        return {
          employeeId: e.employeeId,
          employeeName: e.employeeName,
          totalHours: round2(e.totalHours),
          totalPay: round2(e.totalPay + allowance),
          roadAllowance: round2(allowance),
          objects: [...e.objects.values()].sort((a, b) => a.objectName.localeCompare(b.objectName)),
        };
      })
      .sort((a, b) => a.employeeName.localeCompare(b.employeeName)),
    byCar: [...carAggs.values()]
      .map((c) => ({ ...c, totalKm: round2(c.totalKm), days: c.days.sort((a, b) => a.date.localeCompare(b.date)) }))
      .sort((a, b) => a.carName.localeCompare(b.carName)),
  });
});

/** GET /api/stats?date=YYYY-MM-DD — day summary, mirrors the bot's day checklist. */
statsRouter.get("/", async (req, res) => {
  const date = String(req.query.date || "");
  if (!date) {
    res.status(400).json({ error: "date query param is required" });
    return;
  }

  const foremanTgId = BigInt(req.user!.tgId);

  const [logisticsEvents, materialMoves, odometerDays, timesheetHours, dayStatus] = await Promise.all([
    db
      .select()
      .from(schema.events)
      .where(and(eq(schema.events.date, date), eq(schema.events.type, "ЛОГІСТИКА"), eq(schema.events.foremanTgId, foremanTgId))),
    db.select().from(schema.materialMoves).where(and(eq(schema.materialMoves.date, date), eq(schema.materialMoves.foremanTgId, foremanTgId))),
    db.select().from(schema.odometerDays).where(and(eq(schema.odometerDays.date, date), eq(schema.odometerDays.foremanTgId, foremanTgId))),
    db
      .select({
        employeeId: schema.timesheetEntries.employeeId,
        employeeName: schema.timesheetEntries.employeeName,
        hours: sql<number>`sum(${schema.timesheetEntries.hours})`,
      })
      .from(schema.timesheetEntries)
      .where(eq(schema.timesheetEntries.date, date))
      .groupBy(schema.timesheetEntries.employeeId, schema.timesheetEntries.employeeName),
    db.select().from(schema.dayStatuses).where(and(eq(schema.dayStatuses.date, date), eq(schema.dayStatuses.foremanTgId, foremanTgId))),
  ]);

  res.json({
    date,
    checklist: {
      hasLogistics: logisticsEvents.length > 0,
      hasMaterials: materialMoves.length > 0,
      hasRoad: odometerDays.length > 0,
      hasOdoStart: odometerDays.some((o) => o.startValue !== null),
      hasOdoEnd: odometerDays.some((o) => o.endValue !== null),
      hasTimesheet: timesheetHours.length > 0,
    },
    logistics: { count: logisticsEvents.length },
    materials: { count: materialMoves.length, moves: materialMoves },
    road: { odometerDays },
    hoursByEmployee: timesheetHours,
    dayStatuses: dayStatus,
  });
});
