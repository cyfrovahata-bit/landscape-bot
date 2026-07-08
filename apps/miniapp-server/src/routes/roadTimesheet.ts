import { Router, type Response } from "express";
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
  sendTelegramMessage,
  config,
  type LockedTx,
} from "@landscape/core";
import { and, eq, inArray, desc, lt, gte } from "drizzle-orm";
import { normRole } from "../authMiddleware.js";

/** 403s and returns true if the caller isn't an admin -- lets a route bail with `if (blockNonAdmin(req, res)) return;`. */
function blockNonAdmin(req: import("express").Request, res: Response): boolean {
  if (req.user!.role !== "ADMIN") {
    res.status(403).json({ error: "Admins only" });
    return true;
  }
  return false;
}

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

// A car is actually in use exactly while it has a start odometer but no end
// odometer yet -- the moment the foreman records the return reading (car
// back at base), it's free again for someone else, regardless of whether
// they've gone on to submit the full day's report yet. The odometerDays row
// itself is never deleted (it's the day's permanent km record), so "row
// exists" alone isn't the right "still taken" signal -- endValue is.
function carIsActivelyOut(row: { startValue: number | null; endValue: number | null }): boolean {
  return row.startValue !== null && row.endValue === null;
}

// A "leg" of the day: one car+crew+route submission. Most days have exactly
// one (tripSeq 0), but a foreman can return to base and head out again with
// a different car/crew/objects (e.g. before-lunch vs after-lunch) -- each of
// those is its own tripSeq, shown and edited as its own collapsed report.
type StoredTrip = {
  tripSeq: number;
  eventId: string;
  status: string;
  carId: string | null;
  employeeIds: string[];
  objects: ObjectInput[];
  odoStart?: number;
  odoEnd?: number;
  km?: number;
  tripClass?: string;
};

/** Every leg submitted so far today for this foreman, one entry per tripSeq
 * (latest event wins within a tripSeq -- same edit-and-resubmit rule that
 * used to apply to the whole day). Submissions saved before multi-trip
 * support existed have no tripSeq in their payload and are treated as leg 0. */
async function fetchAllTrips(date: string, foremanTgId: number): Promise<StoredTrip[]> {
  const rows = await db
    .select()
    .from(schema.events)
    .where(and(eq(schema.events.date, date), eq(schema.events.foremanTgId, BigInt(foremanTgId)), eq(schema.events.type, "RTS_SAVE")))
    .orderBy(desc(schema.events.ts));

  const byTripSeq = new Map<number, StoredTrip>();
  for (const row of rows) {
    let payload: { tripSeq?: number; objects?: ObjectInput[]; odoStart?: number; odoEnd?: number; km?: number; tripClass?: string } = {};
    try {
      payload = JSON.parse(row.payload ?? "{}");
    } catch {
      payload = {};
    }
    const tripSeq = payload.tripSeq ?? 0;
    if (byTripSeq.has(tripSeq)) continue; // rows are ts-desc, so the first hit per tripSeq is the latest
    let employeeIds: string[] = [];
    try {
      employeeIds = JSON.parse(row.employeeIds ?? "[]");
    } catch {
      employeeIds = [];
    }
    byTripSeq.set(tripSeq, {
      tripSeq,
      eventId: row.eventId,
      status: row.status,
      carId: row.carId,
      employeeIds,
      objects: payload.objects ?? [],
      odoStart: payload.odoStart,
      odoEnd: payload.odoEnd,
      km: payload.km,
      tripClass: payload.tripClass,
    });
  }
  return [...byTripSeq.values()].sort((a, b) => a.tripSeq - b.tripSeq);
}

/** Merges every leg's own object list into one day-total view: the same
 * object appearing in more than one leg gets its works' volumes summed and
 * its work sessions concatenated, so hours/volumes reported across two
 * separate trips to the same place add up instead of one trip's numbers
 * clobbering the other's -- reports/timesheet/day-status are keyed by
 * date+object(+work/employee) with no notion of "trip" at all, so whatever
 * this merge produces is exactly what ends up written there. */
function mergeObjects(objectsByLeg: ObjectInput[][]): ObjectInput[] {
  const byObjectId = new Map<string, ObjectInput>();
  for (const objects of objectsByLeg) {
    for (const obj of objects) {
      const existing = byObjectId.get(obj.objectId);
      if (!existing) {
        byObjectId.set(obj.objectId, {
          objectId: obj.objectId,
          objectName: obj.objectName,
          works: (obj.works ?? []).map((w) => ({ ...w })),
          sessions: [...(obj.sessions ?? [])],
          coefs: [...(obj.coefs ?? [])],
          notes: obj.notes,
          photoUrls: obj.photoUrls ? [...obj.photoUrls] : [],
        });
        continue;
      }
      for (const w of obj.works ?? []) {
        const existingWork = existing.works.find((ew) => ew.workId === w.workId);
        if (!existingWork) {
          existing.works.push({ ...w });
          continue;
        }
        const a = Number(existingWork.volume);
        const b = Number(w.volume);
        if (Number.isFinite(a) && Number.isFinite(b)) existingWork.volume = a + b;
        else if (Number.isFinite(b)) existingWork.volume = b;
      }
      existing.sessions = [...existing.sessions, ...(obj.sessions ?? [])];
      if (obj.coefs?.length) {
        const coefByEmployee = new Map((existing.coefs ?? []).map((c) => [c.employeeId, c]));
        for (const c of obj.coefs) coefByEmployee.set(c.employeeId, c);
        existing.coefs = [...coefByEmployee.values()];
      }
    }
  }
  return [...byObjectId.values()];
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
  const { date, carId, odoStart, odoStartPhoto, odoEnd, odoEndPhoto, employeeIds, objects, idempotencyKey, tripSeq } = req.body as {
    date: string;
    carId: string;
    odoStart: number;
    odoStartPhoto?: string;
    odoEnd: number;
    odoEndPhoto?: string;
    employeeIds: string[];
    objects: ObjectInput[];
    idempotencyKey?: string;
    tripSeq?: number;
  };

  if (!date || !carId || !Array.isArray(objects) || !objects.length) {
    res.status(400).json({ error: "date, carId and at least one object are required" });
    return;
  }

  const foremanTgId = req.user!.tgId;

  // Read-only work (dictionary lookups, payroll math, diffing against the
  // previous submission) happens before the lock so we hold it -- and block
  // other foremen's reservation calls -- for as little time as possible.
  // This leg's own estimate (its own km/tripClass/fund), shown on its own
  // card -- separate from the day-combined totals computed below.
  const legResult = await computePayroll({ odoStart, odoEnd, employeeIds, objects });

  const allTripsBefore = await fetchAllTrips(date, foremanTgId);
  // No tripSeq from the client = a brand-new leg (the "Розпочати нову
  // поїздку" button never sends one); an explicit tripSeq means "resubmit/
  // edit that specific leg", scoped so it never touches other legs' data.
  const effectiveTripSeq = tripSeq ?? (allTripsBefore.length ? Math.max(...allTripsBefore.map((t) => t.tripSeq)) + 1 : 0);
  const legPrevious = allTripsBefore.find((t) => t.tripSeq === effectiveTripSeq) ?? null;

  const oldMergedObjects = mergeObjects(allTripsBefore.map((t) => t.objects));
  const tripsAfter = [
    ...allTripsBefore.filter((t) => t.tripSeq !== effectiveTripSeq),
    { tripSeq: effectiveTripSeq, eventId: "", carId, employeeIds: employeeIds ?? [], objects, odoStart, odoEnd },
  ];
  const newMergedObjects = mergeObjects(tripsAfter.map((t) => t.objects));
  const unionEmployeeIds = [...new Set(tripsAfter.flatMap((t) => t.employeeIds))];
  const totalKm = tripsAfter.reduce((acc, t) => {
    const legKm = typeof t.odoStart === "number" && typeof t.odoEnd === "number" ? t.odoEnd - t.odoStart : 0;
    return acc + (Number.isFinite(legKm) ? legKm : 0);
  }, 0);
  // Day-combined totals: what actually gets written to reports/timesheet/
  // allowances below, since those tables have no per-trip dimension.
  const combined = await computePayroll({ odoStart: 0, odoEnd: totalKm, employeeIds: unionEmployeeIds, objects: newMergedObjects });

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
      const takenBySomeoneElse = existingForCar.find((r) => Number(r.foremanTgId) !== foremanTgId && carIsActivelyOut(r));
      if (takenBySomeoneElse) throw new ReservationConflictError("Це авто вже зарезервоване іншим бригадиром на сьогодні");

      const employeeConflicts = await findEmployeeConflicts(tx, date, employeeIds ?? [], foremanTgId);
      if (employeeConflicts.length) {
        throw new ReservationConflictError(`Деякі люди вже зайняті іншим бригадиром сьогодні: ${employeeConflicts.join(", ")}`);
      }

      await writeOdometerDay(
        { date, carId, foremanTgId, startValue: odoStart, startPhoto: odoStartPhoto, endValue: odoEnd, endPhoto: odoEndPhoto },
        tx,
      );

      // Releasing THIS leg's old car only -- a different leg (different
      // tripSeq) keeps its own car's odometer row untouched even if it
      // differs from this one.
      if (legPrevious?.carId && legPrevious.carId !== carId) {
        await writeOdometerDay({ date, carId: legPrevious.carId, foremanTgId }, tx);
        await tx
          .delete(schema.odometerDays)
          .where(and(eq(schema.odometerDays.date, date), eq(schema.odometerDays.carId, legPrevious.carId)));
      }

      const currentObjectIds = new Set(newMergedObjects.map((o) => o.objectId));

      for (const obj of newMergedObjects) {
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

        const hoursByEmployee = combined.perObjectHours.find((h) => h.objectId === obj.objectId)?.hoursByEmployee ?? new Map();
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
            hasOdoStart: true,
            hasOdoEnd: true,
          },
          tx,
        );
      }

      // Reconcile at the day level: anything reported by ANY leg before this
      // write but missing from the new day-total gets soft-cancelled (status
      // set to СКАСОВАНО / hours zeroed), never physically deleted, so
      // admin-side views can still see what happened but stop counting it --
      // editing-and-resubmitting must not leave stale "ghost" data behind.
      for (const prevObj of oldMergedObjects) {
        const currentObj = newMergedObjects.find((o) => o.objectId === prevObj.objectId);
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
                employeeName: combined.employeeById.get(employeeId)?.name ?? employeeId,
                hours: 0,
                source: "ROAD_СКАСОВАНО",
              })),
              tx,
            );
          }
          await writeDayStatus({ date, objectId: prevObj.objectId, foremanTgId, status: "СКАСОВАНО" }, tx);
        }
      }

      // Road allowance: ONE combined amount for the whole day (not per leg),
      // based on the day's total km across every car used, split evenly
      // among everyone who rode along in ANY leg today (not just those who
      // worked) -- matches the bot's single-allowance-per-day model.
      if (unionEmployeeIds.length) {
        await writeAllowanceRows(
          unionEmployeeIds.map((employeeId) => ({
            date,
            foremanTgId,
            type: "ROAD_TRIP",
            employeeId,
            employeeName: combined.employeeById.get(employeeId)?.name ?? employeeId,
            objectId: "ROAD",
            amount: combined.roadAllowance.perPerson,
            meta: JSON.stringify({ km: totalKm, tripClass: combined.tripClass }),
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
          payload: JSON.stringify({
            tripSeq: effectiveTripSeq,
            odoStart,
            odoEnd,
            km: legResult.km,
            tripClass: legResult.tripClass,
            objects,
            salaryPacks: legResult.salaryPacks,
            roadAllowance: legResult.roadAllowance,
          }),
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

  const combinedFund = combined.salaryPacks.reduce((a, p) => a + p.objectTotal, 0);
  notifyAdmins(
    [
      `🆕 *Новий звіт на підтвердження*`,
      `👤 Бригадир: ${req.user!.pib}`,
      `📅 Дата: ${date}`,
      `🚗 ${totalKm} км · клас ${combined.tripClass}`,
      `📍 Обʼєкти: ${newMergedObjects.map((o) => o.objectName).join(", ") || "—"}`,
      `💰 Фонд: ${Math.round(combinedFund * 100) / 100} грн`,
    ].join("\n"),
    { date, foremanTgId },
  ).catch((e) => console.log(`[notifyAdmins] failed: ${(e as Error).message}`));

  res.json({
    eventId,
    tripSeq: effectiveTripSeq,
    km: legResult.km,
    tripClass: legResult.tripClass,
    salaryPacks: legResult.salaryPacks,
    roadAllowance: legResult.roadAllowance,
    brigadierEmployeeId: legResult.brigadierEmployeeId,
    seniorEmployeeIds: legResult.seniorEmployeeIds,
    combined: { km: totalKm, tripClass: combined.tripClass, roadAllowance: combined.roadAllowance, salaryPacks: combined.salaryPacks },
  });
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
        const takenBySomeoneElse = existingForCar.find((r) => Number(r.foremanTgId) !== foremanTgId && carIsActivelyOut(r));
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
 * currently out with another foreman today (start odometer recorded, no end
 * odometer yet), with the reserving foreman's name, so PICK_CAR can stop two
 * foremen picking the same car -- same intent as the bot's
 * "🔒 [авто] — [бригадир]" busy label. Frees up the moment that foreman
 * records the return odometer (see carIsActivelyOut / POST /car-return) --
 * not only once they submit the full day's report.
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
    .filter((r) => Number(r.foremanTgId) !== myTgId && carIsActivelyOut(r))
    .map((r) => ({ carId: r.carId, foremanName: nameByTgId.get(String(r.foremanTgId)) ?? `Бригадир ${r.foremanTgId}` }));

  res.json({ taken });
});

/**
 * POST /api/road-timesheet/car-return — called the moment the foreman
 * records the return odometer at the RETURN step (before they've reviewed
 * or submitted the rest of the day), so the car frees up for another
 * foreman right away instead of staying "taken" until the final submit.
 * Includes the already-known start reading too -- writeOdometerDay upserts
 * the whole row, so omitting it here would wipe it back to empty.
 */
roadTimesheetRouter.post("/car-return", async (req, res) => {
  const { date, carId, odoStart, odoStartPhoto, odoEnd, odoEndPhoto } = req.body as {
    date: string;
    carId: string;
    odoStart?: number;
    odoStartPhoto?: string;
    odoEnd: number;
    odoEndPhoto?: string;
  };
  if (!date || !carId || !Number.isFinite(odoEnd)) {
    res.status(400).json({ error: "date, carId and odoEnd are required" });
    return;
  }
  const foremanTgId = req.user!.tgId;

  await writeOdometerDay({ date, carId, foremanTgId, startValue: odoStart, startPhoto: odoStartPhoto, endValue: odoEnd, endPhoto: odoEndPhoto });

  res.json({ ok: true });
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
 * GET /api/road-timesheet/submitted-today?date=YYYY-MM-DD — every leg (trip)
 * submitted so far today, each in a shape that can be loaded straight back
 * into the editable client state (so a re-opened, not-yet-approved day shows
 * exactly what was sent per trip and each trip can be corrected/resubmitted
 * on its own), plus the day-combined totals (km/allowance/fund) that
 * actually get paid out.
 */
roadTimesheetRouter.get("/submitted-today", async (req, res) => {
  const date = String(req.query.date || "");
  if (!date) {
    res.status(400).json({ error: "date query param is required" });
    return;
  }
  const foremanTgId = req.user!.tgId;

  const trips = await fetchAllTrips(date, foremanTgId);
  if (!trips.length) {
    res.json({ found: false, trips: [], combined: null });
    return;
  }

  // Odometer photos live only in the odometerDays table (not the event
  // payload), keyed by car -- fetch them so each trip card can show its own.
  const carIds = [...new Set(trips.map((t) => t.carId).filter((id): id is string => !!id))];
  const odometerRows = carIds.length
    ? await db.select().from(schema.odometerDays).where(and(eq(schema.odometerDays.date, date), inArray(schema.odometerDays.carId, carIds)))
    : [];
  const odoByCarId = new Map(odometerRows.map((r) => [r.carId, r]));

  const mergedObjects = mergeObjects(trips.map((t) => t.objects));
  const unionEmployeeIds = [...new Set(trips.flatMap((t) => t.employeeIds))];
  const totalKm = trips.reduce((acc, t) => {
    const legKm = typeof t.odoStart === "number" && typeof t.odoEnd === "number" ? t.odoEnd - t.odoStart : 0;
    return acc + (Number.isFinite(legKm) ? legKm : 0);
  }, 0);
  const combined = await computePayroll({ odoStart: 0, odoEnd: totalKm, employeeIds: unionEmployeeIds, objects: mergedObjects });

  res.json({
    found: true,
    trips: trips.map((t) => {
      const odo = t.carId ? odoByCarId.get(t.carId) : undefined;
      return {
        tripSeq: t.tripSeq,
        eventId: t.eventId,
        status: t.status,
        carId: t.carId,
        employeeIds: t.employeeIds,
        odoStart: t.odoStart ?? odo?.startValue ?? null,
        odoStartPhoto: odo?.startPhoto ?? null,
        odoEnd: t.odoEnd ?? odo?.endValue ?? null,
        odoEndPhoto: odo?.endPhoto ?? null,
        objects: t.objects,
        km: t.km,
        tripClass: t.tripClass,
      };
    }),
    combined: { km: totalKm, tripClass: combined.tripClass, roadAllowance: combined.roadAllowance, salaryPacks: combined.salaryPacks },
  });
});

/**
 * Sends every active admin (КОРИСТУВАЧІ role "адмін"/"admin") a Telegram
 * message, with a button that opens the Mini App straight to the
 * "Затвердження" screen focused on this foreman+date -- deep-linked into the
 * SAME app (not a standalone page), so after acting on it an admin can still
 * navigate to any other section from the menu. The button is omitted if
 * PUBLIC_APP_URL isn't configured; the text notification still goes out.
 */
async function notifyAdmins(text: string, focus?: { date: string; foremanTgId: number }) {
  const users = await db.select().from(schema.users).where(eq(schema.users.active, true));
  const adminChatIds = users.filter((u) => normRole(u.role) === "ADMIN").map((u) => Number(u.tgId));

  const buttons =
    focus && config.publicUrl
      ? [[{ text: "📄 Відкрити звіт", webAppUrl: `${config.publicUrl}/?approveDate=${focus.date}&approveForeman=${focus.foremanTgId}` }]]
      : undefined;

  await Promise.all(adminChatIds.map((chatId) => sendTelegramMessage(chatId, text, { buttons })));
}

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

  await notifyAdmins(
    `🔓 *Запит на редагування*\n👤 Бригадир: ${req.user!.pib}\n📅 Дата: ${date}${reason ? `\n📝 ${reason}` : ""}`,
  );

  res.json({ ok: true });
});

const RETURN_REASONS: Record<string, string> = {
  NO_PHOTO: "Нема фото",
  WRONG_ODO: "ODO некоректний",
  WRONG_PEOPLE: "Не ті люди",
  WRONG_OBJECTS: "Не ті обʼєкти",
  WRONG_QTY: "Невірні обсяги",
  OTHER: "Інше",
};

/**
 * GET /api/road-timesheet/pending — admin-only. Every foreman+date whose
 * latest RTS_SAVE is still awaiting a decision (status "АКТИВНА" -- not yet
 * "ЗАТВЕРДЖЕНО" or "ПОВЕРНУТО"), with the same day-combined summary the
 * foreman's own DONE screen shows, but for the admin these amounts are real
 * (never masked -- see renderFundBreakdown on the client, which only masks
 * for the submitting brigadier).
 */
roadTimesheetRouter.get("/pending", async (req, res) => {
  if (blockNonAdmin(req, res)) return;

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 60);
  const cutoffIso = cutoff.toISOString().slice(0, 10);

  const [rows, users] = await Promise.all([
    db
      .select()
      .from(schema.events)
      .where(and(eq(schema.events.type, "RTS_SAVE"), gte(schema.events.date, cutoffIso)))
      .orderBy(desc(schema.events.ts)),
    db.select().from(schema.users),
  ]);
  const nameByTgId = new Map(users.map((u) => [String(u.tgId), u.pib]));

  const latestByGroup = new Map<string, (typeof rows)[number]>();
  for (const r of rows) {
    const key = `${r.date}|${r.foremanTgId}`;
    if (!latestByGroup.has(key)) latestByGroup.set(key, r); // rows are ts-desc already
  }
  const pendingGroups = [...latestByGroup.values()].filter((r) => r.status === "АКТИВНА");

  const items = await Promise.all(
    pendingGroups.map(async (r) => {
      const foremanTgId = Number(r.foremanTgId);
      const trips = await fetchAllTrips(r.date, foremanTgId);
      const mergedObjects = mergeObjects(trips.map((t) => t.objects));
      const unionEmployeeIds = [...new Set(trips.flatMap((t) => t.employeeIds))];
      const totalKm = trips.reduce((acc, t) => {
        const legKm = typeof t.odoStart === "number" && typeof t.odoEnd === "number" ? t.odoEnd - t.odoStart : 0;
        return acc + (Number.isFinite(legKm) ? legKm : 0);
      }, 0);
      const combined = await computePayroll({ odoStart: 0, odoEnd: totalKm, employeeIds: unionEmployeeIds, objects: mergedObjects });
      return {
        date: r.date,
        foremanTgId,
        foremanName: nameByTgId.get(String(foremanTgId)) ?? String(foremanTgId),
        submittedAt: r.ts.toISOString(),
        km: totalKm,
        tripClass: combined.tripClass,
        roadAllowance: combined.roadAllowance,
        salaryPacks: combined.salaryPacks,
        objects: mergedObjects.map((o) => ({
          objectId: o.objectId,
          objectName: o.objectName,
          works: (o.works ?? []).map((w) => ({ workId: w.workId, workName: w.workName, volume: w.volume })),
        })),
        employeeIds: unionEmployeeIds,
      };
    }),
  );

  items.sort((a, b) => (a.date === b.date ? a.submittedAt.localeCompare(b.submittedAt) : b.date.localeCompare(a.date)));
  res.json({ items, reasons: RETURN_REASONS });
});

async function setDayStatus(date: string, foremanTgId: number, status: string) {
  const rows = await db
    .select()
    .from(schema.events)
    .where(and(eq(schema.events.date, date), eq(schema.events.foremanTgId, BigInt(foremanTgId)), eq(schema.events.type, "RTS_SAVE")));
  await Promise.all(
    rows.map((r) =>
      writeEvent({
        eventId: r.eventId,
        status,
        refEventId: r.refEventId ?? undefined,
        chatId: r.chatId ? Number(r.chatId) : undefined,
        ts: r.ts.toISOString(),
        date: r.date,
        foremanTgId: Number(r.foremanTgId),
        type: r.type,
        objectId: r.objectId ?? undefined,
        carId: r.carId ?? undefined,
        employeeIds: r.employeeIds ?? undefined,
        payload: r.payload ?? undefined,
        msgId: r.msgId ?? undefined,
      }),
    ),
  );
  return rows.length;
}

/** POST /api/road-timesheet/pending/approve — admin-only. { date, foremanTgId } */
roadTimesheetRouter.post("/pending/approve", async (req, res) => {
  if (blockNonAdmin(req, res)) return;
  const { date, foremanTgId } = req.body as { date: string; foremanTgId: number };
  if (!date || !foremanTgId) {
    res.status(400).json({ error: "date and foremanTgId are required" });
    return;
  }

  const count = await setDayStatus(date, foremanTgId, "ЗАТВЕРДЖЕНО");
  if (!count) {
    res.status(404).json({ error: "No submission found for that date/foreman" });
    return;
  }

  await sendTelegramMessage(foremanTgId, `✅ *День затверджено адміністратором*\n📅 Дата: ${date}`);
  res.json({ ok: true });
});

/** POST /api/road-timesheet/pending/return — admin-only. { date, foremanTgId, reasonCode, note? } */
roadTimesheetRouter.post("/pending/return", async (req, res) => {
  if (blockNonAdmin(req, res)) return;
  const { date, foremanTgId, reasonCode, note } = req.body as { date: string; foremanTgId: number; reasonCode: string; note?: string };
  if (!date || !foremanTgId || !reasonCode) {
    res.status(400).json({ error: "date, foremanTgId and reasonCode are required" });
    return;
  }

  const count = await setDayStatus(date, foremanTgId, "ПОВЕРНУТО");
  if (!count) {
    res.status(404).json({ error: "No submission found for that date/foreman" });
    return;
  }

  const reasonText = RETURN_REASONS[reasonCode] ?? RETURN_REASONS.OTHER;
  await sendTelegramMessage(
    foremanTgId,
    `🔴 *День повернено адміністратором*\n📅 Дата: ${date}\n📝 Причина: ${reasonText}${note ? ` — ${note}` : ""}\n\nРедагування знову доступне. Відкрий "Дорожній табель", виправ дані і надішли повторно.`,
  );
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
