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
  withLock,
  type LockedTx,
} from "@landscape/core";
import { and, eq, inArray, desc, lt } from "drizzle-orm";

/** Thrown to signal a 409 (reservation conflict) from inside a withLock() callback. */
class ReservationConflictError extends Error {}

/** Bounds coefficients server-side -- the client UI only offers 0.7-1.2 presets, but a
 * direct API call could send anything, and this number directly drives payroll splits. */
function clampCoef(value: number | undefined): number {
  return Number.isFinite(value) ? Math.min(2, Math.max(0.1, value as number)) : 1;
}

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
  notes?: string;
  photoUrls?: string[];
};

/**
 * Computes trip class + payroll split for a road timesheet day, without
 * writing anything. Shared by the /preview endpoint (so the brigadier sees
 * the fund breakdown on the review screen before submitting, matching the
 * mockup's step 3.13) and the real POST / save (which additionally persists
 * everything). Never mutates the database.
 */
async function computePayroll(params: { odoStart: number; odoEnd: number; employeeIds: string[]; objects: ObjectInput[] }) {
  const { odoStart, odoEnd, employeeIds, objects } = params;

  const km = Number.isFinite(odoEnd) && Number.isFinite(odoStart) ? odoEnd - odoStart : undefined;
  const tripClass: "S" | "M" | "L" | "XL" =
    km === undefined || km <= 0 ? "S" : km <= 20 ? "S" : km <= 50 ? "M" : km <= 100 ? "L" : "XL";

  const allWorkIds = [...new Set(objects.flatMap((o) => (o.works ?? []).map((w) => w.workId)))];
  const [workRows, employeeRows, settingRows] = await Promise.all([
    allWorkIds.length ? db.select().from(schema.works).where(inArray(schema.works.id, allWorkIds)) : Promise.resolve([]),
    employeeIds?.length ? db.select().from(schema.employees).where(inArray(schema.employees.id, employeeIds)) : Promise.resolve([]),
    db.select().from(schema.settings).where(eq(schema.settings.key, `ROAD_ALLOWANCE_${tripClass}`)),
  ]);
  const tariffByWorkId = new Map(workRows.map((w) => [w.id, w.tariff]));
  const employeeById = new Map(employeeRows.map((e) => [e.id, { name: e.name, position: e.position, active: e.active }]));

  const payrollObjectInputs: Array<{
    objectId: string;
    objectName: string;
    objectTotal: number;
    rows: Array<{ employeeId: string; employeeName: string; hours: number; disciplineCoef: number; productivityCoef: number }>;
  }> = [];

  const perObjectHours: Array<{ objectId: string; hoursByEmployee: Map<string, { name: string; ms: number }> }> = [];

  for (const obj of objects) {
    const hoursByEmployee = new Map<string, { name: string; ms: number }>();
    for (const s of obj.sessions ?? []) {
      const start = new Date(s.droppedAt).getTime();
      const end = new Date(s.pickedUpAt ?? new Date().toISOString()).getTime();
      const ms = Math.max(0, end - start);
      const cur = hoursByEmployee.get(s.employeeId) ?? { name: s.employeeName, ms: 0 };
      cur.ms += ms;
      hoursByEmployee.set(s.employeeId, cur);
    }
    perObjectHours.push({ objectId: obj.objectId, hoursByEmployee });

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
        disciplineCoef: clampCoef(coefByEmployee.get(employeeId)?.disciplineCoef),
        productivityCoef: clampCoef(coefByEmployee.get(employeeId)?.productivityCoef),
      })),
    });
  }

  const brigadierEmployeeId = pickBrigadierFromRiders(employeeIds ?? [], employeeById);
  const seniorEmployeeIds = pickSeniorsFromRiders(employeeIds ?? [], employeeById);
  const salaryPacks = buildSalaryPacksWithRoles({ objects: payrollObjectInputs, brigadierEmployeeId, seniorEmployeeIds });

  const roadAllowanceTotal =
    settingRows.length && Number.isFinite(Number(settingRows[0].value))
      ? Number(settingRows[0].value)
      : DEFAULT_ROAD_ALLOWANCE_BY_CLASS[tripClass];
  const riders = employeeIds ?? [];
  const perPerson = riders.length ? roadAllowanceTotal / riders.length : 0;

  return {
    km,
    tripClass,
    salaryPacks,
    roadAllowance: { total: roadAllowanceTotal, perPerson: Math.round(perPerson * 100) / 100 },
    brigadierEmployeeId,
    seniorEmployeeIds,
    employeeById,
    perObjectHours,
  };
}

/**
 * POST /api/road-timesheet/preview — same computation as the final save, but
 * read-only: shows the brigadier the fund breakdown on the review screen
 * (mockup step 3.13) before they commit to "Відправити на підтвердження".
 */
roadTimesheetRouter.post("/preview", async (req, res) => {
  const { odoStart, odoEnd, employeeIds, objects } = req.body as {
    odoStart: number;
    odoEnd: number;
    employeeIds: string[];
    objects: ObjectInput[];
  };
  const result = await computePayroll({ odoStart, odoEnd, employeeIds, objects });
  res.json({
    km: result.km,
    tripClass: result.tripClass,
    salaryPacks: result.salaryPacks,
    roadAllowance: result.roadAllowance,
    brigadierEmployeeId: result.brigadierEmployeeId,
    seniorEmployeeIds: result.seniorEmployeeIds,
  });
});

/** Employee ids among `employeeIds` already claimed by a DIFFERENT foreman today
 * (via an earlier /reserve or a final save), per the same "latest wins, RTS_SAVE
 * frees them" rule as GET /people-status. Runs inside the caller's locked
 * transaction so the check and the write that follows are atomic together. */
async function findEmployeeConflicts(tx: LockedTx, date: string, employeeIds: string[], myForemanTgId: number): Promise<string[]> {
  if (!employeeIds.length) return [];
  const events = await tx
    .select()
    .from(schema.events)
    .where(and(eq(schema.events.date, date), inArray(schema.events.type, ["RTS_RESERVE_PEOPLE", "RTS_SAVE"])));

  const latestByEmployee = new Map<string, { type: string; ts: Date }>();
  for (const e of events) {
    if (Number(e.foremanTgId) === myForemanTgId) continue;
    let ids: string[] = [];
    try {
      ids = JSON.parse(e.employeeIds ?? "[]");
    } catch {
      ids = [];
    }
    for (const id of ids) {
      const cur = latestByEmployee.get(id);
      if (!cur || e.ts > cur.ts) latestByEmployee.set(id, { type: e.type, ts: e.ts });
    }
  }

  const takenIds = new Set([...latestByEmployee.entries()].filter(([, v]) => v.type !== "RTS_SAVE").map(([id]) => id));
  return employeeIds.filter((id) => takenIds.has(id));
}

/** This foreman's most recent submission for `date`, if any -- used to reconcile
 * (soft-cancel) objects/works that were part of a previous submission but are
 * missing from the current one, so editing-and-resubmitting never leaves stale
 * "ghost" rows behind in reports/timesheet/dayStatus. */
async function fetchPreviousSubmission(date: string, foremanTgId: number): Promise<{ objects: ObjectInput[] } | null> {
  const rows = await db
    .select()
    .from(schema.events)
    .where(and(eq(schema.events.date, date), eq(schema.events.foremanTgId, BigInt(foremanTgId)), eq(schema.events.type, "RTS_SAVE")))
    .orderBy(desc(schema.events.ts))
    .limit(1);
  const latest = rows[0];
  if (!latest) return null;
  try {
    const payload = JSON.parse(latest.payload ?? "{}") as { objects?: ObjectInput[] };
    return { objects: payload.objects ?? [] };
  } catch {
    return null;
  }
}

/**
 * POST /api/road-timesheet — final save for the day, submitted once the
 * whole trip (drive out -> visit objects -> drop off/pick up people ->
 * drive back) is finished on the client. Mirrors the bot's road timesheet
 * flow (apps/bot/src/bot/flows/roadTimesheet.flow.ts). Can be called more
 * than once for the same day (editing an unapproved submission) -- each call
 * overwrites the same date's rows and reconciles anything removed since the
 * last submission.
 */
roadTimesheetRouter.post("/", async (req, res) => {
  const { date, carId, odoStart, odoStartPhoto, odoEnd, odoEndPhoto, employeeIds, objects, idempotencyKey } = req.body as {
    date: string;
    carId: string;
    odoStart: number;
    odoStartPhoto?: string;
    odoEnd: number;
    odoEndPhoto?: string;
    employeeIds: string[];
    objects: ObjectInput[];
    idempotencyKey?: string;
  };

  if (!date || !carId || !Array.isArray(objects) || !objects.length) {
    res.status(400).json({ error: "date, carId and at least one object are required" });
    return;
  }

  const foremanTgId = req.user!.tgId;

  // Read-only work (dictionary lookups, payroll math, diffing against the
  // previous submission) happens before the lock so we hold it -- and block
  // other foremen's reservation calls -- for as little time as possible.
  const { salaryPacks, roadAllowance, brigadierEmployeeId, seniorEmployeeIds, employeeById, perObjectHours, km, tripClass } =
    await computePayroll({ odoStart, odoEnd, employeeIds, objects });
  const previous = await fetchPreviousSubmission(date, foremanTgId);

  // The idempotency key (generated once per "Відправити" tap on the client,
  // reused across its own network retries) makes the eventId stable across
  // retries of the *same* attempt, so a lost response + automatic retry
  // reuses/updates one event row instead of appending a duplicate "attempt"
  // to the audit trail. A genuinely new submission later gets a new key.
  const safeKey = idempotencyKey && /^[a-zA-Z0-9_-]{8,80}$/.test(idempotencyKey) ? idempotencyKey : null;
  const eventId = safeKey ? `RTS_${safeKey}` : makeEventId("RTS");

  try {
    await withLock(`reserve:${date}`, async (tx) => {
      // Enforce the car reservation server-side too, not just as a UI hint --
      // and do the check-then-write atomically under the lock, so two
      // concurrent requests can't both pass the check before either commits.
      const existingForCar = await tx
        .select()
        .from(schema.odometerDays)
        .where(and(eq(schema.odometerDays.date, date), eq(schema.odometerDays.carId, carId)));
      const takenBySomeoneElse = existingForCar.find((r) => Number(r.foremanTgId) !== foremanTgId);
      if (takenBySomeoneElse) throw new ReservationConflictError("Це авто вже зарезервоване іншим бригадиром на сьогодні");

      const employeeConflicts = await findEmployeeConflicts(tx, date, employeeIds ?? [], foremanTgId);
      if (employeeConflicts.length) {
        throw new ReservationConflictError(`Деякі люди вже зайняті іншим бригадиром сьогодні: ${employeeConflicts.join(", ")}`);
      }

      await writeOdometerDay(
        { date, carId, foremanTgId, startValue: odoStart, startPhoto: odoStartPhoto, endValue: odoEnd, endPhoto: odoEndPhoto },
        tx,
      );

      const currentObjectIds = new Set(objects.map((o) => o.objectId));

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
            tx,
          );
        }

        const hoursByEmployee = perObjectHours.find((h) => h.objectId === obj.objectId)!.hoursByEmployee;
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
            tx,
          );
        }

        const allVolumesFilled = (obj.works ?? []).every((w) => w.volume !== undefined && w.volume !== "" && w.volume !== "?");
        await writeDayStatus(
          {
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
          },
          tx,
        );
      }

      // Reconcile against the previous submission: anything reported before
      // but missing now gets soft-cancelled (status set to СКАСОВАНО / hours
      // zeroed), never physically deleted, so admin-side views can still see
      // what happened but stop counting it -- editing-and-resubmitting must
      // not leave stale "ghost" data that silently inflates totals.
      if (previous) {
        for (const prevObj of previous.objects) {
          const currentObj = objects.find((o) => o.objectId === prevObj.objectId);
          const currentWorkIds = new Set((currentObj?.works ?? []).map((w) => w.workId));
          const removedWorks = (prevObj.works ?? []).filter((w) => !currentWorkIds.has(w.workId));

          if (removedWorks.length) {
            await writeReports(
              removedWorks.map((w) => ({
                date,
                objectId: prevObj.objectId,
                foremanTgId,
                workId: w.workId,
                workName: w.workName,
                volume: w.volume,
                volumeStatus: "НЕ_ЗАПОВНЕНО",
                dayStatus: "СКАСОВАНО",
              })),
              tx,
            );
          }

          if (!currentObjectIds.has(prevObj.objectId)) {
            const prevEmployeeIds = [...new Set((prevObj.sessions ?? []).map((s) => s.employeeId))];
            if (prevEmployeeIds.length) {
              await writeTimesheetRows(
                prevEmployeeIds.map((employeeId) => ({
                  date,
                  objectId: prevObj.objectId,
                  employeeId,
                  employeeName: employeeById.get(employeeId)?.name ?? employeeId,
                  hours: 0,
                  source: "ROAD_СКАСОВАНО",
                })),
                tx,
              );
            }
            await writeDayStatus({ date, objectId: prevObj.objectId, foremanTgId, status: "СКАСОВАНО" }, tx);
          }
        }
      }

      // Road allowance: a fixed per-trip amount by trip class, split evenly
      // among everyone who rode along (not just those who worked), written
      // as its own ROAD_TRIP allowance row per rider -- matches the bot.
      const riders = employeeIds ?? [];
      if (riders.length) {
        await writeAllowanceRows(
          riders.map((employeeId) => ({
            date,
            foremanTgId,
            type: "ROAD_TRIP",
            employeeId,
            employeeName: employeeById.get(employeeId)?.name ?? employeeId,
            objectId: "ROAD",
            amount: roadAllowance.perPerson,
            meta: JSON.stringify({ km, tripClass, carId }),
            dayStatus: "ЧЕРНЕТКА",
          })),
          tx,
        );
      }

      await writeEvent(
        {
          eventId,
          status: "АКТИВНА",
          date,
          foremanTgId,
          type: "RTS_SAVE",
          carId,
          employeeIds: JSON.stringify(employeeIds ?? []),
          payload: JSON.stringify({ odoStart, odoEnd, km, tripClass, objects, salaryPacks, roadAllowance }),
        },
        tx,
      );
    });
  } catch (e) {
    if (e instanceof ReservationConflictError) {
      res.status(409).json({ error: e.message });
      return;
    }
    throw e;
  }

  res.json({ eventId, km, tripClass, salaryPacks, roadAllowance, brigadierEmployeeId, seniorEmployeeIds });
});

/**
 * POST /api/road-timesheet/reserve — called right after PICK_CAR and
 * PICK_PEOPLE are confirmed, before the rest of the day is planned. Mirrors
 * the bot's real-time car/people locking (buildBusyCarsMap/buildBusyEmployeesMap
 * in roadTimesheet.utils.ts): without an early write, two foremen could pick
 * the same car or the same person, since the mini-app otherwise only saves
 * everything in one batch at the very end of the day. Uses the same
 * per-date lock as the final save, so the two can't race each other either.
 */
roadTimesheetRouter.post("/reserve", async (req, res) => {
  const { date, carId, employeeIds } = req.body as { date: string; carId?: string; employeeIds?: string[] };
  if (!date) {
    res.status(400).json({ error: "date is required" });
    return;
  }
  const foremanTgId = req.user!.tgId;

  try {
    await withLock(`reserve:${date}`, async (tx) => {
      if (carId) {
        const existingForCar = await tx
          .select()
          .from(schema.odometerDays)
          .where(and(eq(schema.odometerDays.date, date), eq(schema.odometerDays.carId, carId)));
        const takenBySomeoneElse = existingForCar.find((r) => Number(r.foremanTgId) !== foremanTgId);
        if (takenBySomeoneElse) throw new ReservationConflictError("Це авто вже зарезервоване іншим бригадиром на сьогодні");
        // A "draft" row with no odometer values yet -- writeOdometerDay upserts on
        // date+carId, so the real ODO_START value submitted later just updates it.
        await writeOdometerDay({ date, carId, foremanTgId }, tx);
      }

      if (employeeIds?.length) {
        const employeeConflicts = await findEmployeeConflicts(tx, date, employeeIds, foremanTgId);
        if (employeeConflicts.length) {
          throw new ReservationConflictError(`Деякі люди вже зайняті іншим бригадиром сьогодні: ${employeeConflicts.join(", ")}`);
        }
        await writeEvent(
          {
            eventId: makeEventId("RTSRSV"),
            status: "АКТИВНА",
            date,
            foremanTgId,
            type: "RTS_RESERVE_PEOPLE",
            employeeIds: JSON.stringify(employeeIds),
          },
          tx,
        );
      }
    });
  } catch (e) {
    if (e instanceof ReservationConflictError) {
      res.status(409).json({ error: e.message });
      return;
    }
    throw e;
  }

  res.json({ ok: true });
});

/**
 * GET /api/road-timesheet/cars-last-odometer — the most recent known
 * odometer value per car (any date), shown next to each car in the PICK_CAR
 * screen so the foreman can sanity-check the new reading against it.
 */
roadTimesheetRouter.get("/cars-last-odometer", async (_req, res) => {
  const rows = await db.select().from(schema.odometerDays).orderBy(desc(schema.odometerDays.date), desc(schema.odometerDays.updatedAt));
  const lastByCarId = new Map<string, number>();
  for (const r of rows) {
    if (lastByCarId.has(r.carId)) continue;
    const v = r.endValue ?? r.startValue;
    if (v !== null) lastByCarId.set(r.carId, v);
  }
  res.json({ lastOdometer: Object.fromEntries(lastByCarId) });
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

/**
 * GET /api/road-timesheet/day-status?date=YYYY-MM-DD — has this foreman
 * submitted (RTS_SAVE) a road timesheet for this date, and has an admin
 * already approved it (status "ЗАТВЕРДЖЕНО" on the event, set by the admin
 * approval flow)? A submission that isn't approved yet is NOT locked -- the
 * foreman can keep viewing and re-editing it (each save just overwrites the
 * same date's rows and appends a new RTS_SAVE event for the audit trail).
 * Only an approved day is locked, with "request edit" as the escape hatch.
 */
roadTimesheetRouter.get("/day-status", async (req, res) => {
  const date = String(req.query.date || "");
  if (!date) {
    res.status(400).json({ error: "date query param is required" });
    return;
  }
  const foremanTgId = BigInt(req.user!.tgId);

  const [saveRows, editRequestRows] = await Promise.all([
    db
      .select()
      .from(schema.events)
      .where(and(eq(schema.events.date, date), eq(schema.events.foremanTgId, foremanTgId), eq(schema.events.type, "RTS_SAVE")))
      .orderBy(desc(schema.events.ts)),
    db
      .select()
      .from(schema.events)
      .where(and(eq(schema.events.date, date), eq(schema.events.foremanTgId, foremanTgId), eq(schema.events.type, "RTS_EDIT_REQUEST")))
      .orderBy(desc(schema.events.ts))
      .limit(1),
  ]);

  res.json({
    hasSubmission: saveRows.length > 0,
    approved: saveRows.some((r) => r.status === "ЗАТВЕРДЖЕНО"),
    eventId: saveRows[0]?.eventId ?? null,
    editRequested: editRequestRows.length > 0,
  });
});

/**
 * GET /api/road-timesheet/submitted-today?date=YYYY-MM-DD — the foreman's
 * latest submission for today, in a shape that can be loaded straight back
 * into the editable client state (so a re-opened, not-yet-approved day shows
 * exactly what was sent and can be corrected/resubmitted).
 */
roadTimesheetRouter.get("/submitted-today", async (req, res) => {
  const date = String(req.query.date || "");
  if (!date) {
    res.status(400).json({ error: "date query param is required" });
    return;
  }
  const foremanTgId = BigInt(req.user!.tgId);

  const [saveRows, odometerRows] = await Promise.all([
    db
      .select()
      .from(schema.events)
      .where(and(eq(schema.events.date, date), eq(schema.events.foremanTgId, foremanTgId), eq(schema.events.type, "RTS_SAVE")))
      .orderBy(desc(schema.events.ts))
      .limit(1),
    db
      .select()
      .from(schema.odometerDays)
      .where(and(eq(schema.odometerDays.date, date), eq(schema.odometerDays.foremanTgId, foremanTgId)))
      .limit(1),
  ]);

  const latest = saveRows[0];
  if (!latest) {
    res.json({ found: false });
    return;
  }

  let payload: { odoStart?: number; odoEnd?: number; objects?: ObjectInput[] } = {};
  try {
    payload = JSON.parse(latest.payload ?? "{}");
  } catch {
    payload = {};
  }
  let employeeIds: string[] = [];
  try {
    employeeIds = JSON.parse(latest.employeeIds ?? "[]");
  } catch {
    employeeIds = [];
  }
  const odo = odometerRows[0];

  res.json({
    found: true,
    eventId: latest.eventId,
    carId: latest.carId,
    employeeIds,
    odoStart: payload.odoStart ?? odo?.startValue ?? null,
    odoStartPhoto: odo?.startPhoto ?? null,
    odoEnd: payload.odoEnd ?? odo?.endValue ?? null,
    odoEndPhoto: odo?.endPhoto ?? null,
    objects: payload.objects ?? [],
  });
});

/**
 * POST /api/road-timesheet/request-edit — after a day is approved and
 * locked, the foreman can ask an admin to unlock it instead of the mini-app
 * silently allowing (or silently refusing) further edits. Just logs an event
 * for the admin to see -- no automatic unlocking happens here.
 */
roadTimesheetRouter.post("/request-edit", async (req, res) => {
  const { date, eventId, reason } = req.body as { date: string; eventId?: string; reason?: string };
  if (!date) {
    res.status(400).json({ error: "date is required" });
    return;
  }
  const foremanTgId = req.user!.tgId;

  await writeEvent({
    eventId: makeEventId("RTSEDIT"),
    status: "АКТИВНА",
    date,
    foremanTgId,
    type: "RTS_EDIT_REQUEST",
    refEventId: eventId,
    payload: JSON.stringify({ reason: reason ?? "" }),
  });

  res.json({ ok: true });
});

/**
 * GET /api/road-timesheet/last-trip?before=YYYY-MM-DD — the foreman's most
 * recently submitted road timesheet strictly before the given date, used to
 * offer "repeat yesterday's route" on a fresh empty day instead of making
 * the foreman re-enter a route they drive every week.
 */
roadTimesheetRouter.get("/last-trip", async (req, res) => {
  const before = String(req.query.before || "");
  if (!before) {
    res.status(400).json({ error: "before query param is required" });
    return;
  }
  const foremanTgId = BigInt(req.user!.tgId);

  const rows = await db
    .select()
    .from(schema.events)
    .where(and(eq(schema.events.foremanTgId, foremanTgId), eq(schema.events.type, "RTS_SAVE"), lt(schema.events.date, before)))
    .orderBy(desc(schema.events.date), desc(schema.events.ts))
    .limit(1);

  const prior = rows[0];
  if (!prior) {
    res.json({ found: false });
    return;
  }

  let payload: { objects?: ObjectInput[] } = {};
  try {
    payload = JSON.parse(prior.payload ?? "{}");
  } catch {
    payload = {};
  }
  let employeeIds: string[] = [];
  try {
    employeeIds = JSON.parse(prior.employeeIds ?? "[]");
  } catch {
    employeeIds = [];
  }

  res.json({
    found: true,
    date: prior.date,
    carId: prior.carId,
    employeeIds,
    objects: (payload.objects ?? []).map((o) => ({
      objectId: o.objectId,
      objectName: o.objectName,
      works: (o.works ?? []).map((w) => ({ workId: w.workId, workName: w.workName })),
    })),
  });
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
