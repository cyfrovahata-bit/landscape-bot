import { Router } from "express";
import multer from "multer";
import {
  db,
  schema,
  writeEvent,
  writeOdometerDay,
  writeReports,
  writeTimesheetRows,
  writeDayStatus,
  writeAllowanceRows,
  makeEventId,
  uploadPhotoFromBuffer,
  pickBrigadierFromRiders,
  pickSeniorsFromRiders,
  buildSalaryPacksWithRoles,
  DEFAULT_ROAD_ALLOWANCE_BY_CLASS,
} from "@landscape/core";
import { and, eq, inArray } from "drizzle-orm";

export const roadTimesheetRouter = Router();

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

/**
 * POST /api/road-timesheet/photo — uploads one odometer photo to Drive,
 * used by the ODO_START / ODO_END steps. Returns a viewable URL that gets
 * stored alongside the odometer row, same as the bot's `odoStartPhotoFileId`.
 */
roadTimesheetRouter.post("/photo", upload.single("photo"), async (req, res) => {
  if (!req.file) {
    res.status(400).json({ error: "photo file is required" });
    return;
  }
  const fileName = `odo_${req.user!.tgId}_${Date.now()}.jpg`;
  const url = await uploadPhotoFromBuffer(fileName, req.file.buffer);
  res.json({ url });
});

// A work session: an employee was dropped at an object and (usually) later picked back up.
type WorkSession = { employeeId: string; employeeName: string; droppedAt: string; pickedUpAt?: string };
// employeeIds: who was specifically assigned to this work (so it's visible who did what,
// not just that the object had some work done) -- stored in the event payload for record.
type WorkInput = { workId: string; workName: string; volume?: string | number; employeeIds?: string[] };
// disciplineCoef/productivityCoef default to 1.0, same as the bot -- the foreman can
// adjust them per employee per object (affects only how the *worker* share of the
// object's payroll fund is split between workers, not the fund total itself).
type CoefInput = { employeeId: string; disciplineCoef?: number; productivityCoef?: number };
type ObjectInput = {
  objectId: string;
  objectName: string;
  works: WorkInput[];
  sessions: WorkSession[];
  coefs?: CoefInput[];
};

/**
 * POST /api/road-timesheet — final save for the day, submitted once the
 * whole trip (drive out -> visit objects -> drop off/pick up people ->
 * drive back) is finished on the client. Mirrors the bot's road timesheet
 * flow (apps/bot/src/bot/flows/roadTimesheet.flow.ts): pick car -> record
 * start odometer (+optional photo) -> pick people -> pick route objects ->
 * plan works per object -> drive -> drop off/pick up people per object
 * (hours are derived from those timestamps, same idea as the bot's
 * AT_OBJECT_RUN session timer) -> record end odometer (+optional photo).
 */
roadTimesheetRouter.post("/", async (req, res) => {
  const {
    date,
    carId,
    odoStart,
    odoStartPhoto,
    odoEnd,
    odoEndPhoto,
    employeeIds,
    objects,
  } = req.body as {
    date: string;
    carId: string;
    odoStart: number;
    odoStartPhoto?: string;
    odoEnd: number;
    odoEndPhoto?: string;
    employeeIds: string[];
    objects: ObjectInput[];
  };

  if (!date || !carId || !Array.isArray(objects) || !objects.length) {
    res.status(400).json({ error: "date, carId and at least one object are required" });
    return;
  }

  const foremanTgId = req.user!.tgId;

  // Enforce the car reservation server-side too, not just as a UI hint: a car
  // already started by a different foreman today can't be double-booked.
  const existingForCar = await db
    .select()
    .from(schema.odometerDays)
    .where(and(eq(schema.odometerDays.date, date), eq(schema.odometerDays.carId, carId)));
  const takenBySomeoneElse = existingForCar.find((r) => Number(r.foremanTgId) !== foremanTgId);
  if (takenBySomeoneElse) {
    res.status(409).json({ error: "Це авто вже зарезервоване іншим бригадиром на сьогодні" });
    return;
  }

  const { km, tripClass } = await writeOdometerDay({
    date,
    carId,
    foremanTgId,
    startValue: odoStart,
    startPhoto: odoStartPhoto,
    endValue: odoEnd,
    endPhoto: odoEndPhoto,
  });

  // Needed to compute payroll: work tariffs (objectTotal = Sum(volume * tariff))
  // and employee position/active (to find the trip's brigadier/seniors), exactly
  // like the bot's roleFromPosition / isBrigadier / isSenior checks.
  const allWorkIds = [...new Set(objects.flatMap((o) => (o.works ?? []).map((w) => w.workId)))];
  const [workRows, employeeRows] = await Promise.all([
    allWorkIds.length ? db.select().from(schema.works).where(inArray(schema.works.id, allWorkIds)) : Promise.resolve([]),
    employeeIds?.length ? db.select().from(schema.employees).where(inArray(schema.employees.id, employeeIds)) : Promise.resolve([]),
  ]);
  const tariffByWorkId = new Map(workRows.map((w) => [w.id, w.tariff]));
  const employeeById = new Map(employeeRows.map((e) => [e.id, { name: e.name, position: e.position, active: e.active }]));

  const payrollObjectInputs: Array<{
    objectId: string;
    objectName: string;
    objectTotal: number;
    rows: Array<{ employeeId: string; employeeName: string; hours: number; disciplineCoef: number; productivityCoef: number }>;
  }> = [];

  for (const obj of objects) {
    if (obj.works?.length) {
      await writeReports(
        obj.works.map((w) => ({
          date,
          objectId: obj.objectId,
          foremanTgId,
          workId: w.workId,
          workName: w.workName,
          volume: w.volume,
          volumeStatus: w.volume === undefined || w.volume === "" || w.volume === "?" ? "НЕ_ЗАПОВНЕНО" : "ЗАПОВНЕНО",
          dayStatus: "ЗДАНО",
        })),
      );
    }

    // Hours per employee at this object = sum of (pickedUpAt - droppedAt) across
    // their sessions there (an employee can be dropped off and picked up more
    // than once at the same object over the course of the trip).
    const hoursByEmployee = new Map<string, { name: string; ms: number }>();
    for (const s of obj.sessions ?? []) {
      const start = new Date(s.droppedAt).getTime();
      const end = new Date(s.pickedUpAt ?? new Date().toISOString()).getTime();
      const ms = Math.max(0, end - start);
      const cur = hoursByEmployee.get(s.employeeId) ?? { name: s.employeeName, ms: 0 };
      cur.ms += ms;
      hoursByEmployee.set(s.employeeId, cur);
    }

    if (hoursByEmployee.size) {
      await writeTimesheetRows(
        [...hoursByEmployee.entries()].map(([employeeId, v]) => ({
          date,
          objectId: obj.objectId,
          employeeId,
          employeeName: v.name,
          hours: Math.round((v.ms / 3_600_000) * 100) / 100,
          source: "ROAD",
        })),
      );
    }

    const allVolumesFilled = (obj.works ?? []).every((w) => w.volume !== undefined && w.volume !== "" && w.volume !== "?");
    await writeDayStatus({
      date,
      objectId: obj.objectId,
      foremanTgId,
      status: "ЗДАНО",
      hasReports: (obj.works ?? []).length > 0,
      hasReportsVolumeOk: allVolumesFilled,
      hasTimesheet: hoursByEmployee.size > 0,
      hasRoad: true,
      hasOdoStart: odoStart !== undefined,
      hasOdoEnd: odoEnd !== undefined,
    });

    // objectTotal = Sum(volume * tariff) across the works actually done at this
    // object -- matches computeWorkMoneyFromRts + workTotalsByObject in the bot
    // (their per-employee split algebraically cancels back out to this sum).
    const objectTotal = (obj.works ?? []).reduce((acc, w) => {
      const vol = Number(w.volume);
      const tariff = tariffByWorkId.get(w.workId) ?? 0;
      return acc + (Number.isFinite(vol) ? vol : 0) * tariff;
    }, 0);

    const coefByEmployee = new Map((obj.coefs ?? []).map((c) => [c.employeeId, c]));
    payrollObjectInputs.push({
      objectId: obj.objectId,
      objectName: obj.objectName,
      objectTotal,
      rows: [...hoursByEmployee.entries()].map(([employeeId, v]) => ({
        employeeId,
        employeeName: v.name,
        hours: v.ms / 3_600_000,
        disciplineCoef: coefByEmployee.get(employeeId)?.disciplineCoef ?? 1,
        productivityCoef: coefByEmployee.get(employeeId)?.productivityCoef ?? 1,
      })),
    });
  }

  // Payroll split (display-only, same as the bot: it's computed on demand for
  // review/accounting, not written back as its own sheet rows).
  const brigadierEmployeeId = pickBrigadierFromRiders(employeeIds ?? [], employeeById);
  const seniorEmployeeIds = pickSeniorsFromRiders(employeeIds ?? [], employeeById);
  const salaryPacks = buildSalaryPacksWithRoles({
    objects: payrollObjectInputs,
    brigadierEmployeeId,
    seniorEmployeeIds,
  });

  // Road allowance: a fixed per-trip amount by trip class, split evenly among
  // everyone who rode along (not just those who worked), written as its own
  // ROAD_TRIP allowance row per rider -- matches the bot exactly.
  const settingRows = await db
    .select()
    .from(schema.settings)
    .where(eq(schema.settings.key, `ROAD_ALLOWANCE_${tripClass}`));
  const roadAllowanceTotal =
    settingRows.length && Number.isFinite(Number(settingRows[0].value))
      ? Number(settingRows[0].value)
      : DEFAULT_ROAD_ALLOWANCE_BY_CLASS[tripClass as "S" | "M" | "L" | "XL"];
  const riders = employeeIds ?? [];
  const perPerson = riders.length ? roadAllowanceTotal / riders.length : 0;

  if (riders.length) {
    await writeAllowanceRows(
      riders.map((employeeId) => ({
        date,
        foremanTgId,
        type: "ROAD_TRIP",
        employeeId,
        employeeName: employeeById.get(employeeId)?.name ?? employeeId,
        objectId: "ROAD",
        amount: Math.round(perPerson * 100) / 100,
        meta: JSON.stringify({ km, tripClass, carId }),
        dayStatus: "ЧЕРНЕТКА",
      })),
    );
  }

  const eventId = makeEventId("RTS");
  await writeEvent({
    eventId,
    status: "АКТИВНА",
    date,
    foremanTgId,
    type: "RTS_SAVE",
    carId,
    employeeIds: JSON.stringify(employeeIds ?? []),
    payload: JSON.stringify({ odoStart, odoEnd, km, tripClass, objects, salaryPacks, roadAllowance: { total: roadAllowanceTotal, perPerson } }),
  });

  res.json({
    eventId,
    km,
    tripClass,
    salaryPacks,
    roadAllowance: { total: roadAllowanceTotal, perPerson: Math.round(perPerson * 100) / 100 },
    brigadierEmployeeId,
    seniorEmployeeIds,
  });
});

/**
 * POST /api/road-timesheet/reserve — called right after PICK_CAR and
 * PICK_PEOPLE are confirmed, before the rest of the day is planned. Mirrors
 * the bot's real-time car/people locking (buildBusyCarsMap/buildBusyEmployeesMap
 * in roadTimesheet.utils.ts): without an early write, two foremen could pick
 * the same car or the same person, since the mini-app otherwise only saves
 * everything in one batch at the very end of the day.
 */
roadTimesheetRouter.post("/reserve", async (req, res) => {
  const { date, carId, employeeIds } = req.body as { date: string; carId?: string; employeeIds?: string[] };
  if (!date) {
    res.status(400).json({ error: "date is required" });
    return;
  }
  const foremanTgId = req.user!.tgId;

  if (carId) {
    const existingForCar = await db
      .select()
      .from(schema.odometerDays)
      .where(and(eq(schema.odometerDays.date, date), eq(schema.odometerDays.carId, carId)));
    const takenBySomeoneElse = existingForCar.find((r) => Number(r.foremanTgId) !== foremanTgId);
    if (takenBySomeoneElse) {
      res.status(409).json({ error: "Це авто вже зарезервоване іншим бригадиром на сьогодні" });
      return;
    }
    // A "draft" row with no odometer values yet -- writeOdometerDay upserts on
    // date+carId, so the real ODO_START value submitted later just updates it.
    await writeOdometerDay({ date, carId, foremanTgId });
  }

  if (employeeIds?.length) {
    await writeEvent({
      eventId: makeEventId("RTSRSV"),
      status: "АКТИВНА",
      date,
      foremanTgId,
      type: "RTS_RESERVE_PEOPLE",
      employeeIds: JSON.stringify(employeeIds),
    });
  }

  res.json({ ok: true });
});

/**
 * GET /api/road-timesheet/car-status?date=YYYY-MM-DD — which cars are
 * already taken for the day (someone already recorded/reserved a start
 * odometer for them), with the reserving foreman's name, so PICK_CAR can
 * stop two foremen picking the same car -- same intent as the bot's
 * "🔒 [авто] — [бригадир]" busy label.
 */
roadTimesheetRouter.get("/car-status", async (req, res) => {
  const date = String(req.query.date || "");
  if (!date) {
    res.status(400).json({ error: "date query param is required" });
    return;
  }

  const [rows, users] = await Promise.all([
    db.select().from(schema.odometerDays).where(eq(schema.odometerDays.date, date)),
    db.select().from(schema.users),
  ]);
  const nameByTgId = new Map(users.map((u) => [String(u.tgId), u.pib]));
  const myTgId = req.user!.tgId;
  const taken = rows
    .filter((r) => Number(r.foremanTgId) !== myTgId)
    .map((r) => ({ carId: r.carId, foremanName: nameByTgId.get(String(r.foremanTgId)) ?? `Бригадир ${r.foremanTgId}` }));

  res.json({ taken });
});

/**
 * GET /api/road-timesheet/people-status?date=YYYY-MM-DD — which employees
 * are already riding with another foreman today. An employee frees up again
 * once that foreman's day is fully submitted (RTS_SAVE), matching the bot's
 * FREE_TYPES logic in buildBusyEmployeesMap.
 */
roadTimesheetRouter.get("/people-status", async (req, res) => {
  const date = String(req.query.date || "");
  if (!date) {
    res.status(400).json({ error: "date query param is required" });
    return;
  }

  const [events, users] = await Promise.all([
    db
      .select()
      .from(schema.events)
      .where(and(eq(schema.events.date, date), inArray(schema.events.type, ["RTS_RESERVE_PEOPLE", "RTS_SAVE"]))),
    db.select().from(schema.users),
  ]);
  const nameByTgId = new Map(users.map((u) => [String(u.tgId), u.pib]));
  const myTgId = req.user!.tgId;

  const latestByEmployee = new Map<string, { type: string; ts: Date; foremanTgId: string }>();
  for (const e of events) {
    if (Number(e.foremanTgId) === myTgId) continue;
    let ids: string[] = [];
    try {
      ids = JSON.parse(e.employeeIds ?? "[]");
    } catch {
      ids = [];
    }
    for (const id of ids) {
      const cur = latestByEmployee.get(id);
      if (!cur || e.ts > cur.ts) latestByEmployee.set(id, { type: e.type, ts: e.ts, foremanTgId: String(e.foremanTgId) });
    }
  }

  const taken = [...latestByEmployee.entries()]
    .filter(([, v]) => v.type !== "RTS_SAVE")
    .map(([employeeId, v]) => ({ employeeId, foremanName: nameByTgId.get(v.foremanTgId) ?? `Бригадир ${v.foremanTgId}` }));

  res.json({ taken });
});

/** GET /api/road-timesheet/today?date=YYYY-MM-DD — for the review screen. */
roadTimesheetRouter.get("/today", async (req, res) => {
  const date = String(req.query.date || "");
  if (!date) {
    res.status(400).json({ error: "date query param is required" });
    return;
  }

  const foremanTgId = BigInt(req.user!.tgId);

  const [odometer, reports, hours, dayStatuses] = await Promise.all([
    db.select().from(schema.odometerDays).where(and(eq(schema.odometerDays.date, date), eq(schema.odometerDays.foremanTgId, foremanTgId))),
    db.select().from(schema.reports).where(and(eq(schema.reports.date, date), eq(schema.reports.foremanTgId, foremanTgId))),
    db.select().from(schema.timesheetEntries).where(eq(schema.timesheetEntries.date, date)),
    db.select().from(schema.dayStatuses).where(and(eq(schema.dayStatuses.date, date), eq(schema.dayStatuses.foremanTgId, foremanTgId))),
  ]);

  res.json({ date, odometer, reports, hours, dayStatuses });
});
