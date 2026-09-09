import { asyncRouter } from "../asyncRouter.js";
import { type Response } from "express";
import multer from "multer";
import { randomUUID } from "node:crypto";
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
  pickBrigadiersFromRiders,
  pickSeniorsFromRiders,
  buildSalaryPacksWithRoles,
  DEFAULT_ROAD_ALLOWANCE_BY_CLASS,
  withLock,
  sendTelegramMessage,
  config,
  buildAccountingRows,
  writeAccountingReportForDay,
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

/** Today's date in the timezone the crews actually work in, matching the
 * client's todayISO() -- used to tell a genuinely past day from the live one. */
function todayKyivISO(): string {
  return new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Kyiv" });
}

/** Bounds coefficients server-side -- the client UI only offers 0.7-1.2 presets, but a
 * direct API call could send anything, and this number directly drives payroll splits. */
function clampCoef(value: number | undefined): number {
  return Number.isFinite(value) ? Math.min(2, Math.max(0.1, value as number)) : 1;
}

export const roadTimesheetRouter = asyncRouter();

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

/**
 * POST /api/road-timesheet/photo — uploads one photo to Drive (the odometer at
 * ODO_START / ODO_END, or the finished work at an object). Returns a viewable
 * URL that travels with the row it belongs to.
 *
 * The try/catch is not decoration: Express 4 does not catch a rejected promise
 * from an async handler, so a Drive 403 here used to take the whole server
 * down and every foreman with it.
 */
roadTimesheetRouter.post("/photo", upload.single("photo"), async (req, res) => {
  if (!req.file) {
    res.status(400).json({ error: "photo file is required" });
    return;
  }
  const fileName = `photo_${req.user!.tgId}_${Date.now()}.jpg`;
  try {
    const url = await uploadPhotoFromBuffer(fileName, req.file.buffer);
    res.json({ url });
  } catch (e) {
    // A 403 here is a setup problem, not a hiccup: either the JWT lacks the
    // Drive scope or the GOOGLE_FOLDER_ID folder is not shared with the
    // service account. Telling the foreman to "try again" would be a lie, and
    // the one line in the log is what makes it fixable without a stack dump.
    const status = (e as { code?: number; status?: number })?.code ?? (e as { status?: number })?.status;
    console.error(`[photo] Drive upload failed (status ${status ?? "?"}): ${(e as Error)?.message}`);
    res.status(502).json({
      error:
        status === 403
          ? "Google Drive не приймає фото: сервісний акаунт не має доступу до папки. Це налаштування — покажіть це повідомлення адміністратору. День можна вести далі, фото не обовʼязкове."
          : "Не вдалося завантажити фото в Google Drive. Спробуйте ще раз або пропустіть — це не обовʼязково.",
    });
  }
});

// A work session: an employee was dropped at an object and (usually) later picked back up.
type WorkSession = { employeeId: string; employeeName: string; droppedAt: string; pickedUpAt?: string };
// employeeIds: who was specifically assigned to this work (so it's visible who did what,
// not just that the object had some work done) -- stored in the event payload for record.
type WorkInput = { workId: string; workName: string; volume?: string | number; employeeIds?: string[] };
// disciplineCoef/productivityCoef default to 1.0, same as the bot -- the foreman can
// adjust them per employee per object. They are recorded per person and reported in
// the salary pack, but they do NOT move any money: the worker share is split equally
// between everyone who was at the object (see buildSalaryPacksWithRoles).
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
// A "car left on errands while the crew worked" side trip: one of the
// people at the object drives off and comes back, and that mileage
// (odoBack - odoOut) is excluded from the trip-class / allowance km.
type Errand = { driverId?: string; odoOut?: number; odoBack?: number | null };

function sumErrandKm(errands?: Errand[]): number {
  if (!Array.isArray(errands)) return 0;
  return errands.reduce((acc, e) => {
    const out = Number(e?.odoOut);
    const back = Number(e?.odoBack);
    if (!Number.isFinite(out) || !Number.isFinite(back)) return acc; // open (no return yet) or malformed -> ignore
    return acc + Math.max(0, back - out);
  }, 0);
}

/**
 * Links the Telegram user who runs a day to their row in the ПРАЦІВНИКИ
 * dictionary, by name.
 *
 * There is no id shared between КОРИСТУВАЧІ and ПРАЦІВНИКИ -- the sheets were
 * never joined -- so the full name is the only bridge. Matching is forgiving
 * about case, spacing and the three apostrophes Ukrainian text uses
 * interchangeably; an active row wins over an inactive one. No match means no
 * payout target, and the 20% goes to the company rather than to somebody
 * arbitrary.
 */
function normalizeName(v: string): string {
  return String(v ?? "")
    .toLowerCase()
    .replace(/[\u2019\u02BC'`]/g, "ʼ")
    .replace(/\s+/g, " ")
    .trim();
}

async function resolveForemanEmployeeId(
  foremanTgId: number,
  employeeRows: Array<{ id: string; name: string; active: boolean }>,
): Promise<string> {
  const [user] = await db.select().from(schema.users).where(eq(schema.users.tgId, BigInt(foremanTgId)));
  if (!user?.pib) return "";
  const target = normalizeName(user.pib);
  const matches = employeeRows.filter((e) => normalizeName(e.name) === target);
  return (matches.find((e) => e.active) ?? matches[0])?.id ?? "";
}

async function computePayroll(params: {
  odoStart: number;
  odoEnd: number;
  employeeIds: string[];
  objects: ObjectInput[];
  selfTransportIds?: string[];
  excludedKm?: number;
  /** Whose day this is -- the fallback owner of the 20% (see below). */
  foremanTgId?: number;
}) {
  const { odoStart, odoEnd, employeeIds, objects, selfTransportIds = [], excludedKm = 0, foremanTgId } = params;

  // grossKm = what the odometer actually moved. billableKm subtracts any
  // "car left on errands" mileage (see the errands payload) so those side
  // trips don't inflate the trip class / travel allowance -- but grossKm is
  // still what we report as the real distance and store in the odometer row.
  const grossKm = Number.isFinite(odoEnd) && Number.isFinite(odoStart) ? odoEnd - odoStart : undefined;
  const billableKm = grossKm === undefined ? undefined : Math.max(0, grossKm - Math.max(0, excludedKm));
  const tripClass: "S" | "M" | "L" | "XL" =
    billableKm === undefined || billableKm <= 0 ? "S" : billableKm <= 20 ? "S" : billableKm <= 50 ? "M" : billableKm <= 100 ? "L" : "XL";

  const allWorkIds = [...new Set(objects.flatMap((o) => (o.works ?? []).map((w) => w.workId)))];
  const [workRows, employeeRows, settingRows] = await Promise.all([
    allWorkIds.length ? db.select().from(schema.works).where(inArray(schema.works.id, allWorkIds)) : Promise.resolve([]),
    employeeIds?.length ? db.select().from(schema.employees).where(inArray(schema.employees.id, employeeIds)) : Promise.resolve([]),
    db.select().from(schema.settings).where(eq(schema.settings.key, `ROAD_ALLOWANCE_${tripClass}`)),
  ]);
  const tariffByWorkId = new Map(workRows.map((w) => [w.id, w.tariff]));
  const employeeById = new Map(employeeRows.map((e) => [e.id, { name: e.name, position: e.position, active: e.active }]));
  // Needed before the per-object loop: the brigadiers' 20% (split between them
  // when there is more than one) and the seniors' 10% are owed on every object
  // of the trip, including ones where they never clocked in, so each object's
  // rows must carry them even at zero hours.
  let brigadierEmployeeIds = pickBrigadiersFromRiders(employeeIds ?? [], employeeById);
  // The 20% is for RUNNING the day, so it is always owed to somebody. If no
  // brigadier rode along, that somebody is whoever runs this day: the foreman
  // who filled it in -- which is also the brigadier an admin planned it for,
  // since they are the one who submits it. Only when that person cannot be
  // matched to an employee row does the 20% fall to the company.
  if (!brigadierEmployeeIds.length && foremanTgId) {
    const fallback = await resolveForemanEmployeeId(foremanTgId, employeeRows);
    if (fallback) brigadierEmployeeIds = [fallback];
    else {
      // Loud on purpose: this silently moves 20% of every object's fund to the
      // company, and the only fix is editing ПІБ in КОРИСТУВАЧІ to match
      // ПРАЦІВНИКИ. The foreman sees it on the review screen too.
      console.warn(`[payroll] no brigadier and no employee row for foremanTgId=${foremanTgId} — 20% goes to the company`);
    }
  }
  const seniorEmployeeIds = pickSeniorsFromRiders(employeeIds ?? [], employeeById);
  const roleIds = [...new Set([...brigadierEmployeeIds, ...seniorEmployeeIds].filter(Boolean))];

  const payrollObjectInputs: Array<{
    objectId: string;
    objectName: string;
    objectTotal: number;
    works: Array<{ workId: string; value: number; employeeIds: string[] }>;
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

    // Each work's own money value, carried through to the payroll split so a
    // work assigned to specific people can pay only them (WorkInput.employeeIds).
    const workValues = (obj.works ?? []).map((w) => {
      const vol = Number(w.volume);
      const tariff = tariffByWorkId.get(w.workId) ?? 0;
      return { workId: w.workId, value: (Number.isFinite(vol) ? vol : 0) * tariff, employeeIds: w.employeeIds ?? [] };
    });
    const objectTotal = workValues.reduce((acc, w) => acc + w.value, 0);

    for (const id of roleIds) {
      if (!hoursByEmployee.has(id)) hoursByEmployee.set(id, { name: employeeById.get(id)?.name ?? id, ms: 0 });
    }

    const coefByEmployee = new Map((obj.coefs ?? []).map((c) => [c.employeeId, c]));
    payrollObjectInputs.push({
      objectId: obj.objectId,
      objectName: obj.objectName,
      objectTotal,
      works: workValues,
      rows: [...hoursByEmployee.entries()].map(([employeeId, v]) => ({
        employeeId,
        employeeName: v.name,
        hours: v.ms / 3_600_000,
        disciplineCoef: clampCoef(coefByEmployee.get(employeeId)?.disciplineCoef),
        productivityCoef: clampCoef(coefByEmployee.get(employeeId)?.productivityCoef),
      })),
    });
  }

  const salaryPacks = buildSalaryPacksWithRoles({ objects: payrollObjectInputs, brigadierEmployeeIds, seniorEmployeeIds });

  // An EMPTY cell in НАЛАШТУВАННЯ is not a setting, it is a missing setting.
  // Number("") is 0 and passes Number.isFinite, so a blank ROAD_ALLOWANCE_*
  // used to silently zero the whole day's travel allowance -- no error, no
  // row in БУХЗВІТ, just nobody paid. A deliberate "0" is still honoured.
  const allowanceSetting = String(settingRows[0]?.value ?? "").trim();
  const roadAllowanceTotal =
    allowanceSetting !== "" && Number.isFinite(Number(allowanceSetting))
      ? Number(allowanceSetting)
      : DEFAULT_ROAD_ALLOWANCE_BY_CLASS[tripClass];
  // Anyone who showed up under their own transport (see /reserve and the
  // AT_OBJECT "Приїхали самі" action) rides free of the travel allowance --
  // they still split the object's work pay like everyone else, just not this.
  const riders = (employeeIds ?? []).filter((id) => !selfTransportIds.includes(id));
  const perPerson = riders.length ? roadAllowanceTotal / riders.length : 0;

  return {
    km: grossKm,
    billableKm,
    excludedKm: Math.max(0, excludedKm),
    tripClass,
    salaryPacks,
    roadAllowance: { total: roadAllowanceTotal, perPerson: Math.round(perPerson * 100) / 100 },
    brigadierEmployeeIds,
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
  const { odoStart, odoEnd, employeeIds, objects, selfTransportIds, errands } = req.body as {
    odoStart: number;
    odoEnd: number;
    employeeIds: string[];
    objects: ObjectInput[];
    selfTransportIds?: string[];
    errands?: Errand[];
  };
  const result = await computePayroll({
    odoStart,
    odoEnd,
    employeeIds,
    objects,
    selfTransportIds,
    excludedKm: sumErrandKm(errands),
    foremanTgId: req.user!.tgId,
  });
  res.json({
    km: result.km,
    billableKm: result.billableKm,
    excludedKm: result.excludedKm,
    tripClass: result.tripClass,
    salaryPacks: result.salaryPacks,
    roadAllowance: result.roadAllowance,
    brigadierEmployeeIds: result.brigadierEmployeeIds,
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
    .where(and(eq(schema.events.date, date), inArray(schema.events.type, ["RTS_RESERVE_PEOPLE", ...PEOPLE_RELEASE_TYPES])));

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

  const takenIds = new Set([...latestByEmployee.entries()].filter(([, v]) => !PEOPLE_RELEASE_TYPES.includes(v.type)).map(([id]) => id));
  return employeeIds.filter((id) => takenIds.has(id));
}

// A car frees up once it's returned (RTS_CAR_RETURN, written the moment the
// foreman records the return odometer -- see POST /car-return), the day gets
// fully submitted (RTS_SAVE), or the foreman cancels the reservation outright
// (RTS_RESERVE_CANCEL, written when they reset the day before submitting --
// see POST /reserve/release) -- whichever comes first. Anything else (just
// RTS_RESERVE_CAR) means it's still actively out.
const CAR_RELEASE_TYPES = ["RTS_CAR_RETURN", "RTS_SAVE", "RTS_RESERVE_CANCEL"];
const PEOPLE_RELEASE_TYPES = ["RTS_SAVE", "RTS_RESERVE_CANCEL"];

/** Same "latest event wins, RTS_CAR_RETURN/RTS_SAVE frees it" rule as
 * findEmployeeConflicts, but for a single car. Runs inside the caller's
 * locked transaction so the check and the write that follows are atomic
 * together. */
async function findCarConflict(tx: LockedTx, date: string, carId: string, myForemanTgId: number): Promise<boolean> {
  const events = await tx
    .select()
    .from(schema.events)
    .where(
      and(
        eq(schema.events.date, date),
        eq(schema.events.carId, carId),
        inArray(schema.events.type, ["RTS_RESERVE_CAR", ...CAR_RELEASE_TYPES]),
      ),
    );

  let latest: { type: string; ts: Date } | null = null;
  for (const e of events) {
    if (Number(e.foremanTgId) === myForemanTgId) continue;
    if (!latest || e.ts > latest.ts) latest = { type: e.type, ts: e.ts };
  }
  if (!latest) return false;
  return !CAR_RELEASE_TYPES.includes(latest.type);
}

/** True if `myForemanTgId` is the one currently holding the reservation on
 * `carId` (their own RTS_RESERVE_CAR is the latest event, not yet released
 * by anyone) -- used by POST /reserve/release so a foreman can only cancel a
 * reservation they actually still hold, never one belonging to someone else
 * (which would otherwise let a stale/buggy client "free" another foreman's
 * active car out from under them). Unlike findCarConflict, this does NOT
 * exclude the caller's own events -- it's asking "is the latest event MINE",
 * not "does someone ELSE have it". */
async function callerHoldsCar(tx: LockedTx, date: string, carId: string, myForemanTgId: number): Promise<boolean> {
  const events = await tx
    .select()
    .from(schema.events)
    .where(
      and(
        eq(schema.events.date, date),
        eq(schema.events.carId, carId),
        inArray(schema.events.type, ["RTS_RESERVE_CAR", ...CAR_RELEASE_TYPES]),
      ),
    );

  let latest: { type: string; ts: Date; foremanTgId: number } | null = null;
  for (const e of events) {
    if (!latest || e.ts > latest.ts) latest = { type: e.type, ts: e.ts, foremanTgId: Number(e.foremanTgId) };
  }
  return !!latest && latest.foremanTgId === myForemanTgId && !CAR_RELEASE_TYPES.includes(latest.type);
}

/** Same idea as callerHoldsCar, but for a list of employees -- returns only
 * the subset `myForemanTgId` is currently the one holding (their own
 * RTS_RESERVE_PEOPLE is the latest event for that employee, not yet
 * released). Used by POST /reserve/release so a foreman can't cancel
 * another foreman's crew reservation. */
async function employeesHeldByCaller(tx: LockedTx, date: string, employeeIds: string[], myForemanTgId: number): Promise<string[]> {
  if (!employeeIds.length) return [];
  const events = await tx
    .select()
    .from(schema.events)
    .where(and(eq(schema.events.date, date), inArray(schema.events.type, ["RTS_RESERVE_PEOPLE", ...PEOPLE_RELEASE_TYPES])));

  const latestByEmployee = new Map<string, { type: string; ts: Date; foremanTgId: number }>();
  for (const e of events) {
    let ids: string[] = [];
    try {
      ids = JSON.parse(e.employeeIds ?? "[]");
    } catch {
      ids = [];
    }
    for (const id of ids) {
      const cur = latestByEmployee.get(id);
      if (!cur || e.ts > cur.ts) latestByEmployee.set(id, { type: e.type, ts: e.ts, foremanTgId: Number(e.foremanTgId) });
    }
  }

  return employeeIds.filter((id) => {
    const v = latestByEmployee.get(id);
    return !!v && v.foremanTgId === myForemanTgId && !PEOPLE_RELEASE_TYPES.includes(v.type);
  });
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
  selfTransportIds: string[];
  objects: ObjectInput[];
  odoStart?: number;
  odoEnd?: number;
  km?: number;
  tripClass?: string;
  errands?: Errand[];
};

/** Every leg submitted so far today for this foreman, one entry per tripSeq
 * (latest event wins within a tripSeq -- same edit-and-resubmit rule that
 * used to apply to the whole day). Submissions saved before multi-trip
 * support existed have no tripSeq in their payload and are treated as leg 0. */
async function fetchAllTrips(date: string, foremanTgId: number, executor: typeof db | LockedTx = db): Promise<StoredTrip[]> {
  const rows = await executor
    .select()
    .from(schema.events)
    .where(and(eq(schema.events.date, date), eq(schema.events.foremanTgId, BigInt(foremanTgId)), eq(schema.events.type, "RTS_SAVE")))
    .orderBy(desc(schema.events.ts));

  const byTripSeq = new Map<number, StoredTrip>();
  for (const row of rows) {
    let payload: {
      tripSeq?: number;
      objects?: ObjectInput[];
      odoStart?: number;
      odoEnd?: number;
      km?: number;
      tripClass?: string;
      selfTransportIds?: string[];
      errands?: Errand[];
    } = {};
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
      selfTransportIds: payload.selfTransportIds ?? [],
      objects: payload.objects ?? [],
      odoStart: payload.odoStart,
      odoEnd: payload.odoEnd,
      km: payload.km,
      tripClass: payload.tripClass,
      errands: payload.errands ?? [],
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
        // Same work item logged in more than one leg -- merge who's tagged
        // on it too, not just the first leg's list, so buildAccountingRows
        // (which tags an employee's pay to a work by employeeIds) doesn't
        // fall back to the untagged full-pool split for someone who only
        // did this work in a later leg.
        if (w.employeeIds?.length) {
          existingWork.employeeIds = [...new Set([...(existingWork.employeeIds ?? []), ...w.employeeIds])];
        }
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
/**
 * Перерахунок ДНЯ після будь-якої зміни складу його поїздок.
 *
 * reports / timesheet_entries / allowances не мають виміру «поїздка» -- туди
 * пишуться обʼєднані по дню значення (mergeObjects). Тому і здача поїздки, і
 * її видалення означають одне й те саме: взяти день, яким він був, день, яким
 * він став, і звести різницю -- дописати нове, а зникле погасити (СКАСОВАНО /
 * нуль годин), ніколи не видаляючи фізично.
 *
 * Винесено спільним саме тому, що шляхів стало два. Копія цієї логіки в
 * ендпоінті видалення розійшлася б із оригіналом на першій же правці, а
 * розходяться тут не рядки таблиці, а суми в людей.
 */
async function reconcileDayTotals(
  tx: LockedTx,
  params: { date: string; foremanTgId: number; allTripsBefore: StoredTrip[]; tripsAfter: Array<Pick<StoredTrip, "employeeIds" | "selfTransportIds" | "objects" | "odoStart" | "odoEnd" | "errands">> },
) {
  const { date, foremanTgId, allTripsBefore, tripsAfter } = params;

  const oldMergedObjects = mergeObjects(allTripsBefore.map((t) => t.objects));
  const newMergedObjects = mergeObjects(tripsAfter.map((t) => t.objects));
  const unionEmployeeIds = [...new Set(tripsAfter.flatMap((t) => t.employeeIds))];
  const unionSelfTransportIds = [...new Set(tripsAfter.flatMap((t) => t.selfTransportIds ?? []))];
  const totalKm = tripsAfter.reduce((acc, t) => {
    const legKm = typeof t.odoStart === "number" && typeof t.odoEnd === "number" ? t.odoEnd - t.odoStart : 0;
    return acc + (Number.isFinite(legKm) ? legKm : 0);
  }, 0);
  // Errand km summed across every leg of the day -- excluded from the
  // combined trip class / allowance below (but NOT from totalKm, which
  // stays the real odometer distance shown in the report).
  const totalExcludedKm = tripsAfter.reduce((acc, t) => acc + sumErrandKm(t.errands), 0);
  // Day-combined totals: what actually gets written to reports/timesheet/
  // allowances below, since those tables have no per-trip dimension.
  const combined = await computePayroll({
    odoStart: 0,
    odoEnd: totalKm,
    employeeIds: unionEmployeeIds,
    objects: newMergedObjects,
    selfTransportIds: unionSelfTransportIds,
    excludedKm: totalExcludedKm,
    foremanTgId,
  });

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
      } else {
        // The object itself is still in the day, but an employee who had
        // hours there before might have been dropped from it in this
        // resubmit (their session removed while others at the same object
        // stayed) -- the main write loop above only writes hours for
        // employees CURRENTLY at the object, so a removed one's old row
        // would otherwise never get zeroed and would keep inflating their
        // pay/hours forever.
        const currentHoursByEmployee = combined.perObjectHours.find((h) => h.objectId === prevObj.objectId)?.hoursByEmployee ?? new Map();
        const prevEmployeeIds = new Set((prevObj.sessions ?? []).map((s) => s.employeeId));
        const droppedEmployeeIds = [...prevEmployeeIds].filter((id) => !currentHoursByEmployee.has(id));
        if (droppedEmployeeIds.length) {
          await writeTimesheetRows(
            droppedEmployeeIds.map((employeeId) => ({
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
      }
    }

    // Road allowance: ONE combined amount for the whole day (not per leg),
    // based on the day's total km across every car used, split evenly
    // among everyone who rode along in ANY leg today (not just those who
    // worked) -- matches the bot's single-allowance-per-day model.
    // Anyone who showed up under their own transport doesn't get a travel
    // allowance row at all (not even a zero one) -- they still get their
    // work pay via the reports/timesheet writes above.
    const allowanceEligibleIds = unionEmployeeIds.filter((id) => !unionSelfTransportIds.includes(id));
    if (allowanceEligibleIds.length) {
      await writeAllowanceRows(
        allowanceEligibleIds.map((employeeId) => ({
          date,
          foremanTgId,
          type: "ROAD_TRIP",
          employeeId,
          employeeName: combined.employeeById.get(employeeId)?.name ?? employeeId,
          objectId: "ROAD",
          amount: combined.roadAllowance.perPerson,
          meta: JSON.stringify({ km: totalKm, excludedKm: totalExcludedKm, billableKm: combined.billableKm, tripClass: combined.tripClass }),
          dayStatus: "ЧЕРНЕТКА",
        })),
        tx,
      );
    }

    // Anyone who WAS allowance-eligible before this write (rode along in an
    // earlier leg, not self-transport) but isn't anymore -- dropped from
    // the day entirely, or reclassified as self-transport -- keeps a
    // stale, nonzero ROAD_TRIP row otherwise: the write above only ever
    // touches CURRENTLY eligible people, the same gap the reports/
    // timesheet reconciliation above this already closes for volumes/hours.
    const oldUnionEmployeeIds = [...new Set(allTripsBefore.flatMap((t) => t.employeeIds))];
    const oldUnionSelfTransportIds = [...new Set(allTripsBefore.flatMap((t) => t.selfTransportIds ?? []))];
    const oldAllowanceEligibleIds = oldUnionEmployeeIds.filter((id) => !oldUnionSelfTransportIds.includes(id));
    const droppedFromAllowance = oldAllowanceEligibleIds.filter((id) => !allowanceEligibleIds.includes(id));
    if (droppedFromAllowance.length) {
      await writeAllowanceRows(
        droppedFromAllowance.map((employeeId) => ({
          date,
          foremanTgId,
          type: "ROAD_TRIP",
          employeeId,
          employeeName: combined.employeeById.get(employeeId)?.name ?? employeeId,
          objectId: "ROAD",
          amount: 0,
          meta: JSON.stringify({ km: totalKm, excludedKm: totalExcludedKm, billableKm: combined.billableKm, tripClass: combined.tripClass }),
          dayStatus: "СКАСОВАНО",
        })),
        tx,
      );
    }

  return { combined, totalKm, totalExcludedKm, newMergedObjects };
}

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
    idempotencyKey,
    tripSeq,
    selfTransportIds,
    errands,
    backdated,
  } = req.body as {
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
    selfTransportIds?: string[];
    errands?: Errand[];
    backdated?: boolean;
  };

  if (!date || !carId || !Array.isArray(objects) || !objects.length || !Array.isArray(employeeIds) || !employeeIds.length) {
    res.status(400).json({ error: "date, carId, at least one employee and at least one object are required" });
    return;
  }

  // The client already blocks these (disabled Save/Continue buttons), but
  // that's only a UI courtesy -- a direct API call could otherwise submit a
  // negative-km trip, which feeds straight into the road-allowance/trip-
  // class calculation and the accountant's report.
  if (!Number.isFinite(odoStart) || !Number.isFinite(odoEnd) || odoEnd < odoStart) {
    res.status(400).json({ error: "Одометр на фініші не може бути меншим за одометр на старті" });
    return;
  }

  const foremanTgId = req.user!.tgId;

  // Same "can't be less than the last known reading" rule as the client's
  // ODO_START screen. Only rows from STRICTLY EARLIER dates count: this
  // skips THIS date's own row (unique per date+carId), so resubmitting/
  // editing an already-saved trip with an unchanged odoStart never compares
  // against its own later odoEnd -- and it skips LATER dates too, so a day
  // entered after the fact (see the retro-entry screen) is checked against
  // where the car actually stood back then, not against today's reading,
  // which is naturally higher and would reject every backdated entry.
  const priorOdoRows = await db
    .select()
    .from(schema.odometerDays)
    .where(and(eq(schema.odometerDays.carId, carId), lt(schema.odometerDays.date, date)))
    .orderBy(desc(schema.odometerDays.date), desc(schema.odometerDays.updatedAt))
    .limit(1);
  const lastKnownOdo = priorOdoRows[0] ? (priorOdoRows[0].endValue ?? priorOdoRows[0].startValue) : null;
  if (lastKnownOdo !== null && odoStart < lastKnownOdo) {
    res.status(400).json({ error: `Одометр на старті не може бути меншим за попереднє відоме значення (${lastKnownOdo} км)` });
    return;
  }

  // This leg's own estimate (its own km/tripClass/fund), shown on its own
  // card -- separate from the day-combined totals computed below. Read-only
  // dictionary lookups, doesn't depend on any other foreman's/leg's state,
  // so it's fine to compute before the lock.
  const legResult = await computePayroll({
    odoStart,
    odoEnd,
    employeeIds,
    objects,
    selfTransportIds,
    excludedKm: sumErrandKm(errands),
    foremanTgId,
  });

  // The idempotency key (generated once per "Відправити" tap on the client,
  // reused across its own network retries) makes the eventId stable across
  // retries of the *same* attempt, so a lost response + automatic retry
  // reuses/updates one event row instead of appending a duplicate "attempt"
  // to the audit trail. A genuinely new submission later gets a new key.
  const safeKey = idempotencyKey && /^[a-zA-Z0-9_-]{8,80}$/.test(idempotencyKey) ? idempotencyKey : null;
  const eventId = safeKey ? `RTS_${safeKey}` : makeEventId("RTS");

  // Everything below reads and writes this foreman's own set of trips for
  // the day, so it all has to happen inside the SAME locked transaction --
  // reading "trips so far" outside the lock let two near-simultaneous
  // submissions (a double-tap, or a lost response + automatic client retry)
  // both compute the same "next tripSeq" from the same stale snapshot, with
  // the second one silently clobbering/reconciling against the first's
  // just-written data instead of being serialized against it.
  let effectiveTripSeq = 0;
  let totalKm = 0;
  let totalExcludedKm = 0;
  let combined!: Awaited<ReturnType<typeof computePayroll>>;
  let newMergedObjectsForNotify: ObjectInput[] = [];

  // Car/people reservations exist to stop two foremen double-booking the
  // SAME car or person while a day is being worked in real time. On a day
  // that's already over there's no such race to lose: whatever those two
  // actually did is now just a fact being recorded, and a stale lock (say,
  // another foreman reserved the car that day and never submitted) would
  // block the record forever. So the backdated-entry screen opts out --
  // but only for a genuinely past date, so a client can't send the flag to
  // wave away a real conflict on today's live day.
  const skipReservationChecks = backdated === true && date < todayKyivISO();

  try {
    await withLock(`reserve:${date}`, async (tx) => {
      // Enforce the car reservation server-side too, not just as a UI hint --
      // and do the check-then-write atomically under the lock, so two
      // concurrent requests can't both pass the check before either commits.
      if (!skipReservationChecks && (await findCarConflict(tx, date, carId, foremanTgId))) {
        throw new ReservationConflictError("Це авто вже зарезервоване іншим бригадиром на сьогодні");
      }

      const employeeConflicts = skipReservationChecks ? [] : await findEmployeeConflicts(tx, date, employeeIds ?? [], foremanTgId);
      if (employeeConflicts.length) {
        throw new ReservationConflictError(`Деякі люди вже зайняті іншим бригадиром сьогодні: ${employeeConflicts.join(", ")}`);
      }

      const allTripsBefore = await fetchAllTrips(date, foremanTgId, tx);

      // A lost response + the client's automatic retry resends this exact
      // same request (same idempotencyKey => same eventId), with no tripSeq
      // learned from the failed first attempt. Without this check that retry
      // would look exactly like "no tripSeq from the client" below and get
      // assigned the NEXT tripSeq -- a second, near-identical leg, doubling
      // this day's volumes/hours/allowance in Reports/Timesheet/Allowance
      // even though the event log itself stays idempotent (same eventId).
      const existingForKey = safeKey ? allTripsBefore.find((t) => t.eventId === eventId) : undefined;
      // No tripSeq from the client = a brand-new leg (the "Розпочати нову
      // поїздку" button never sends one); an explicit tripSeq means "resubmit/
      // edit that specific leg", scoped so it never touches other legs' data.
      effectiveTripSeq =
        tripSeq ?? existingForKey?.tripSeq ?? (allTripsBefore.length ? Math.max(...allTripsBefore.map((t) => t.tripSeq)) + 1 : 0);
      const legPrevious = allTripsBefore.find((t) => t.tripSeq === effectiveTripSeq) ?? null;

      // An already-approved (and possibly already exported to БУХЗВІТ) leg
      // must not be silently overwritten by a resubmit -- the UI's "day is
      // locked once approved" rule is currently only a client-side disabled
      // button; enforce it here too so a direct API call can't bypass it and
      // trigger a second, duplicate approval+export later.
      if (legPrevious?.status === "ЗАТВЕРДЖЕНО") {
        throw new ReservationConflictError("Цей день уже затверджено -- редагування недоступне без запиту на редагування");
      }

      const tripsAfter = [
        ...allTripsBefore.filter((t) => t.tripSeq !== effectiveTripSeq),
        {
          tripSeq: effectiveTripSeq,
          eventId: "",
          carId,
          employeeIds: employeeIds ?? [],
          selfTransportIds: selfTransportIds ?? [],
          objects,
          odoStart,
          odoEnd,
          errands: errands ?? [],
        },
      ];
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

      const { combined: dayCombined, totalKm: dayKm, totalExcludedKm: dayExcludedKm, newMergedObjects } =
        await reconcileDayTotals(tx, { date, foremanTgId, allTripsBefore, tripsAfter });
      combined = dayCombined;
      totalKm = dayKm;
      totalExcludedKm = dayExcludedKm;
      newMergedObjectsForNotify = newMergedObjects;

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
            selfTransportIds: selfTransportIds ?? [],
            errands: errands ?? [],
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
      `🚗 ${totalKm} км · клас ${combined.tripClass}${totalExcludedKm > 0 ? ` (−${totalExcludedKm} км по справам)` : ""}`,
      `📍 Обʼєкти: ${newMergedObjectsForNotify.map((o) => o.objectName).join(", ") || "—"}`,
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
    brigadierEmployeeIds: legResult.brigadierEmployeeIds,
    seniorEmployeeIds: legResult.seniorEmployeeIds,
    combined: {
      km: totalKm,
      excludedKm: totalExcludedKm,
      billableKm: combined.billableKm,
      tripClass: combined.tripClass,
      roadAllowance: combined.roadAllowance,
      salaryPacks: combined.salaryPacks,
    },
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
        if (await findCarConflict(tx, date, carId, foremanTgId)) {
          throw new ReservationConflictError("Це авто вже зарезервоване іншим бригадиром на сьогодні");
        }
        // A "draft" row with no odometer values yet -- writeOdometerDay upserts on
        // date+carId, so the real ODO_START value submitted later just updates it.
        await writeOdometerDay({ date, carId, foremanTgId }, tx);
        await writeEvent(
          {
            eventId: makeEventId("RTSRSV"),
            status: "АКТИВНА",
            date,
            foremanTgId,
            type: "RTS_RESERVE_CAR",
            carId,
          },
          tx,
        );
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
 * POST /api/road-timesheet/reserve/release — called when the foreman resets
 * the day (🗑 "Скинути день") before the final submit, so the car/people they
 * had reserved stop showing as taken for everyone else right away instead of
 * staying locked with nothing to ever release them (a plain client-side
 * reset never touches the server-side RTS_RESERVE_CAR/RTS_RESERVE_PEOPLE
 * events, so without this the reservation would otherwise last forever).
 * Only cancels a car/employee the CALLER is actually the current holder of
 * (checked under the same per-date lock used by /reserve and POST / to keep
 * it atomic with any concurrent reservation) -- a stale client still holding
 * an old carId/employeeIds after someone else has since taken it over must
 * not be able to free that other foreman's active reservation.
 */
roadTimesheetRouter.post("/reserve/release", async (req, res) => {
  const { date, carId, employeeIds } = req.body as { date: string; carId?: string; employeeIds?: string[] };
  if (!date) {
    res.status(400).json({ error: "date is required" });
    return;
  }
  const foremanTgId = req.user!.tgId;

  await withLock(`reserve:${date}`, async (tx) => {
    if (carId && (await callerHoldsCar(tx, date, carId, foremanTgId))) {
      await writeEvent(
        {
          eventId: makeEventId("RTSRSV"),
          status: "АКТИВНА",
          date,
          foremanTgId,
          type: "RTS_RESERVE_CANCEL",
          carId,
        },
        tx,
      );
    }

    const mineEmployeeIds = await employeesHeldByCaller(tx, date, employeeIds ?? [], foremanTgId);
    if (mineEmployeeIds.length) {
      await writeEvent(
        {
          eventId: makeEventId("RTSRSV"),
          status: "АКТИВНА",
          date,
          foremanTgId,
          type: "RTS_RESERVE_CANCEL",
          employeeIds: JSON.stringify(mineEmployeeIds),
        },
        tx,
      );
    }
  });

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
 * currently reserved by another foreman today, with the reserving foreman's
 * name, so PICK_CAR can stop two foremen picking the same car -- same intent
 * as the bot's "🔒 [авто] — [бригадир]" busy label. Same "latest event wins"
 * rule as GET /people-status: a car locks the moment it's picked+odometer
 * entered (RTS_RESERVE_CAR) and frees up the moment it's returned to base
 * (RTS_CAR_RETURN) or the day is submitted (RTS_SAVE).
 */
roadTimesheetRouter.get("/car-status", async (req, res) => {
  const date = String(req.query.date || "");
  if (!date) {
    res.status(400).json({ error: "date query param is required" });
    return;
  }

  const [events, users] = await Promise.all([
    db
      .select()
      .from(schema.events)
      .where(and(eq(schema.events.date, date), inArray(schema.events.type, ["RTS_RESERVE_CAR", ...CAR_RELEASE_TYPES]))),
    db.select().from(schema.users),
  ]);
  const nameByTgId = new Map(users.map((u) => [String(u.tgId), u.pib]));
  const myTgId = req.user!.tgId;

  const latestByCarId = new Map<string, { type: string; ts: Date; foremanTgId: string }>();
  for (const e of events) {
    if (Number(e.foremanTgId) === myTgId || !e.carId) continue;
    const cur = latestByCarId.get(e.carId);
    if (!cur || e.ts > cur.ts) latestByCarId.set(e.carId, { type: e.type, ts: e.ts, foremanTgId: String(e.foremanTgId) });
  }

  const taken = [...latestByCarId.entries()]
    .filter(([, v]) => !CAR_RELEASE_TYPES.includes(v.type))
    .map(([carId, v]) => ({ carId, foremanName: nameByTgId.get(v.foremanTgId) ?? `Бригадир ${v.foremanTgId}` }));

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
  if (typeof odoStart === "number" && Number.isFinite(odoStart) && odoEnd < odoStart) {
    res.status(400).json({ error: "Одометр на фініші не може бути меншим за одометр на старті" });
    return;
  }
  const foremanTgId = req.user!.tgId;

  await writeOdometerDay({ date, carId, foremanTgId, startValue: odoStart, startPhoto: odoStartPhoto, endValue: odoEnd, endPhoto: odoEndPhoto });
  await writeEvent({
    eventId: makeEventId("RTSRSV"),
    status: "АКТИВНА",
    date,
    foremanTgId,
    type: "RTS_CAR_RETURN",
    carId,
  });

  res.json({ ok: true });
});

/**
 * GET /api/road-timesheet/people-status?date=YYYY-MM-DD — which employees
 * are already riding with another foreman today. An employee frees up again
 * once that foreman's day is fully submitted (RTS_SAVE) or the reservation is
 * cancelled outright (RTS_RESERVE_CANCEL -- see POST /reserve/release).
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
      .where(and(eq(schema.events.date, date), inArray(schema.events.type, ["RTS_RESERVE_PEOPLE", ...PEOPLE_RELEASE_TYPES]))),
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
    .filter(([, v]) => !PEOPLE_RELEASE_TYPES.includes(v.type))
    .map(([employeeId, v]) => ({ employeeId, foremanName: nameByTgId.get(v.foremanTgId) ?? `Бригадир ${v.foremanTgId}` }));

  res.json({ taken });
});

/**
 * POST /api/road-timesheet/progress — the foreman's phone reporting where the
 * brigade is, so an admin can watch a day that has not been submitted yet.
 *
 * Fire-and-forget by design: the client never waits on it and never shows its
 * failure. Nothing is computed from this row -- it is a display, and a phone
 * out of signal must make the admin's screen stale, never the day wrong.
 */
roadTimesheetRouter.post("/progress", async (req, res) => {
  const { date, state, objectName, peopleCount } = req.body as {
    date?: string;
    state?: string;
    objectName?: string;
    peopleCount?: number;
  };
  const allowed = ["DRIVING", "AT_OBJECT", "WORKING", "RETURNING", "AT_BASE"];
  if (!date || !state || !allowed.includes(state)) {
    res.status(400).json({ error: "date and a known state are required" });
    return;
  }
  const foremanTgId = req.user!.tgId;
  const cleanObject = String(objectName ?? "").slice(0, 200);

  // Append, but never twice in a row for the same thing: the client reports on
  // mount as well as on transitions, so reopening the app would otherwise
  // stamp "started work" again an hour after they started.
  const [last] = await db
    .select()
    .from(schema.tripProgress)
    .where(and(eq(schema.tripProgress.date, date), eq(schema.tripProgress.foremanTgId, BigInt(foremanTgId))))
    .orderBy(desc(schema.tripProgress.updatedAt))
    .limit(1);
  if (last && last.state === state && last.objectName === cleanObject) {
    res.json({ ok: true, skipped: true });
    return;
  }

  await db.insert(schema.tripProgress).values({
    id: randomUUID(),
    date,
    foremanTgId: BigInt(foremanTgId),
    state,
    objectName: cleanObject,
    peopleCount: Number.isFinite(peopleCount) ? Number(peopleCount) : 0,
    updatedAt: new Date(),
  });
  res.json({ ok: true });
});

/**
 * GET /api/road-timesheet/admin/overview?date=YYYY-MM-DD — admin-only.
 *
 * What every brigade is doing today, in one call. The foreman-facing screens
 * are all scoped to the caller (car-status and people-status even skip the
 * caller's own reservations, because their job is to warn about OTHER people),
 * so an admin had no way to see the day at all short of reading the sheets.
 *
 * Two halves, because they answer different questions:
 * - `active`: cars reserved and not yet returned -- who is out RIGHT NOW.
 * - `submitted`: days already sent, with their status -- what is done.
 */
roadTimesheetRouter.get("/admin/overview", async (req, res) => {
  if (blockNonAdmin(req, res)) return;
  const date = String(req.query.date || "") || new Date().toISOString().slice(0, 10);

  const [dayEvents, users, cars, employees, progressRows] = await Promise.all([
    db.select().from(schema.events).where(eq(schema.events.date, date)),
    db.select().from(schema.users),
    db.select().from(schema.cars),
    db.select().from(schema.employees),
    db.select().from(schema.tripProgress).where(eq(schema.tripProgress.date, date)),
  ]);
  // Oldest first: the card reads top-to-bottom as the day happened.
  const timelineByForeman = new Map<string, Array<{ state: string; objectName: string; at: string }>>();
  for (const r of [...progressRows].sort((a, b) => a.updatedAt.getTime() - b.updatedAt.getTime())) {
    const key = String(r.foremanTgId);
    const list = timelineByForeman.get(key) ?? [];
    list.push({ state: r.state, objectName: r.objectName, at: r.updatedAt.toISOString() });
    timelineByForeman.set(key, list);
  }
  const nameByTgId = new Map(users.map((u) => [String(u.tgId), u.pib]));
  const carById = new Map(cars.map((c) => [c.id, c.name]));
  const employeeById = new Map(employees.map((e) => [e.id, e.name]));
  const foremanName = (tgId: unknown) => nameByTgId.get(String(tgId)) ?? `Бригадир ${tgId}`;

  // Latest event per car decides whether it is still out (same rule as
  // car-status, minus the "skip my own" filter -- an admin wants all of them).
  const latestByCar = new Map<string, { type: string; ts: Date; foremanTgId: string }>();
  for (const e of dayEvents) {
    if (!e.carId || !["RTS_RESERVE_CAR", ...CAR_RELEASE_TYPES].includes(e.type)) continue;
    const cur = latestByCar.get(e.carId);
    if (!cur || e.ts > cur.ts) latestByCar.set(e.carId, { type: e.type, ts: e.ts, foremanTgId: String(e.foremanTgId) });
  }
  const latestByEmployee = new Map<string, { type: string; ts: Date; foremanTgId: string }>();
  for (const e of dayEvents) {
    if (!["RTS_RESERVE_PEOPLE", ...PEOPLE_RELEASE_TYPES].includes(e.type)) continue;
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

  const heldPeopleByForeman = new Map<string, string[]>();
  for (const [employeeId, v] of latestByEmployee) {
    if (PEOPLE_RELEASE_TYPES.includes(v.type)) continue;
    const list = heldPeopleByForeman.get(v.foremanTgId) ?? [];
    list.push(employeeById.get(employeeId) ?? employeeId);
    heldPeopleByForeman.set(v.foremanTgId, list);
  }

  const active = [...latestByCar.entries()]
    .filter(([, v]) => !CAR_RELEASE_TYPES.includes(v.type))
    .map(([carId, v]) => ({
      carId,
      carName: carById.get(carId) ?? carId,
      foremanTgId: Number(v.foremanTgId),
      foremanName: foremanName(v.foremanTgId),
      since: v.ts.toISOString(),
      people: heldPeopleByForeman.get(v.foremanTgId) ?? [],
      // The day's checkpoints, oldest first. Empty until the foreman's app has
      // reported anything (an older build, or no signal since departure).
      timeline: timelineByForeman.get(v.foremanTgId) ?? [],
    }))
    .sort((a, b) => a.since.localeCompare(b.since));

  // Submitted days, newest first, with the status of the LAST event per trip
  // (a resubmission adds an event, it does not rewrite the old one).
  const byForeman = new Map<string, { tgId: string; trips: Map<number, { status: string; ts: Date; objects: string[]; km: number }> }>();
  for (const e of dayEvents) {
    if (e.type !== "RTS_SAVE") continue;
    let payload: { tripSeq?: number; objects?: Array<{ objectName?: string }>; km?: number } = {};
    try {
      payload = JSON.parse(e.payload ?? "{}");
    } catch {
      payload = {};
    }
    const key = String(e.foremanTgId);
    const entry = byForeman.get(key) ?? { tgId: key, trips: new Map() };
    const seq = Number(payload.tripSeq ?? 1);
    const prev = entry.trips.get(seq);
    if (!prev || e.ts > prev.ts) {
      entry.trips.set(seq, {
        status: e.status,
        ts: e.ts,
        objects: (payload.objects ?? []).map((o) => String(o.objectName ?? "")).filter(Boolean),
        km: Number(payload.km ?? 0),
      });
    }
    byForeman.set(key, entry);
  }

  const submitted = [...byForeman.values()]
    .map((f) => {
      const trips = [...f.trips.entries()].map(([tripSeq, t]) => ({
        tripSeq,
        status: t.status,
        submittedAt: t.ts.toISOString(),
        objects: t.objects,
        km: Math.round(t.km * 100) / 100,
      }));
      return {
        foremanTgId: Number(f.tgId),
        foremanName: foremanName(f.tgId),
        trips: trips.sort((a, b) => a.tripSeq - b.tripSeq),
        km: Math.round(trips.reduce((a, t) => a + t.km, 0) * 100) / 100,
        allApproved: trips.length > 0 && trips.every((t) => t.status === "ЗАТВЕРДЖЕНО"),
        // Та сама стрічка, що й у «в дорозі»: день не має уриватись на
        // півслові, коли його здали. Доти картка переїжджала в «Здані» й
        // залишався тільки підсумок -- о котрій виїхали, коли прибули й що
        // робили, ставало невидимим рівно тоді, коли день закінчився.
        timeline: timelineByForeman.get(f.tgId) ?? [],
      };
    })
    .sort((a, b) => a.foremanName.localeCompare(b.foremanName));

  res.json({ date, active, submitted });
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

  const [saveRows, editRequestRows, returnRows] = await Promise.all([
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
    db
      .select()
      .from(schema.events)
      .where(and(eq(schema.events.date, date), eq(schema.events.foremanTgId, foremanTgId), eq(schema.events.type, "RTS_RETURN")))
      .orderBy(desc(schema.events.ts))
      .limit(1),
  ]);

  // Status has to come from the LATEST event per trip, the same rule
  // fetchAllTrips uses -- not from "any RTS_SAVE row says ПОВЕРНУТО". A
  // resubmit appends a fresh АКТИВНА event and leaves the returned one in
  // place as the audit trail, so scanning every row would keep the day
  // flagged as returned forever, long after it was fixed and sent back.
  const trips = await fetchAllTrips(date, req.user!.tgId);
  const returned = trips.some((t) => t.status === "ПОВЕРНУТО");
  let returnReason: string | null = null;
  if (returned && returnRows[0]) {
    try {
      const payload = JSON.parse(returnRows[0].payload ?? "{}") as { reasonText?: string; note?: string };
      returnReason = [payload.reasonText, payload.note].filter(Boolean).join(" — ") || null;
    } catch {
      returnReason = null;
    }
  }

  res.json({
    hasSubmission: saveRows.length > 0,
    approved: trips.some((t) => t.status === "ЗАТВЕРДЖЕНО"),
    returned,
    returnReason,
    eventId: saveRows[0]?.eventId ?? null,
    editRequested: editRequestRows.length > 0,
  });
});

/**
 * GET /api/road-timesheet/returned-days — дні цього бригадира, які адмін
 * повернув на редагування, за БУДЬ-ЯКУ дату.
 *
 * Навіщо: усе інше в табелі прив'язане до однієї дати, і за замовчуванням це
 * сьогодні. День, внесений заднім числом, після повернення ставав невидимим:
 * на сьогоднішньому екрані його немає, а екран внесення заднім числом уміє
 * тільки писати новий і не показує, що вже здано. Бригадир бачив, що звіт
 * повернули, і не мав куди натиснути.
 *
 * Статус береться по ОСТАННІЙ події кожної поїздки (те саме правило, що й у
 * fetchAllTrips): повторна відправка додає нову подію, а повернену лишає в
 * історії, тож «є хоч один RTS_RETURN» показувало б день повернутим назавжди.
 */
roadTimesheetRouter.get("/returned-days", async (req, res) => {
  const foremanTgId = req.user!.tgId;
  const returnRows = await db
    .select()
    .from(schema.events)
    .where(and(eq(schema.events.foremanTgId, BigInt(foremanTgId)), eq(schema.events.type, "RTS_RETURN")))
    .orderBy(desc(schema.events.ts));

  const days: Array<{ date: string; reason: string | null; trips: number }> = [];
  for (const date of [...new Set(returnRows.map((r) => r.date).filter(Boolean))]) {
    const trips = await fetchAllTrips(date, foremanTgId);
    const returnedTrips = trips.filter((t) => t.status === "ПОВЕРНУТО");
    if (!returnedTrips.length) continue;
    let reason: string | null = null;
    const row = returnRows.find((r) => r.date === date);
    if (row) {
      try {
        const payload = JSON.parse(row.payload ?? "{}") as { reasonText?: string; note?: string };
        reason = [payload.reasonText, payload.note].filter(Boolean).join(" — ") || null;
      } catch {
        reason = null;
      }
    }
    days.push({ date, reason, trips: returnedTrips.length });
  }
  days.sort((a, b) => (a.date < b.date ? 1 : -1));
  res.json({ days });
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
  const unionSelfTransportIds = [...new Set(trips.flatMap((t) => t.selfTransportIds ?? []))];
  const totalKm = trips.reduce((acc, t) => {
    const legKm = typeof t.odoStart === "number" && typeof t.odoEnd === "number" ? t.odoEnd - t.odoStart : 0;
    return acc + (Number.isFinite(legKm) ? legKm : 0);
  }, 0);
  const totalExcludedKm = trips.reduce((acc, t) => acc + sumErrandKm(t.errands), 0);
  const combined = await computePayroll({
    odoStart: 0,
    odoEnd: totalKm,
    employeeIds: unionEmployeeIds,
    objects: mergedObjects,
    selfTransportIds: unionSelfTransportIds,
    excludedKm: totalExcludedKm,
    foremanTgId,
  });

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
        selfTransportIds: t.selfTransportIds,
        odoStart: t.odoStart ?? odo?.startValue ?? null,
        odoStartPhoto: odo?.startPhoto ?? null,
        odoEnd: t.odoEnd ?? odo?.endValue ?? null,
        odoEndPhoto: odo?.endPhoto ?? null,
        objects: t.objects,
        km: t.km,
        tripClass: t.tripClass,
        errands: t.errands ?? [],
      };
    }),
    combined: {
      km: totalKm,
      excludedKm: totalExcludedKm,
      billableKm: combined.billableKm,
      tripClass: combined.tripClass,
      roadAllowance: combined.roadAllowance,
      salaryPacks: combined.salaryPacks,
    },
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

  const [rows, users, workRows] = await Promise.all([
    db
      .select()
      .from(schema.events)
      .where(and(eq(schema.events.type, "RTS_SAVE"), gte(schema.events.date, cutoffIso)))
      .orderBy(desc(schema.events.ts)),
    db.select().from(schema.users),
    db.select().from(schema.works),
  ]);
  const nameByTgId = new Map(users.map((u) => [String(u.tgId), u.pib]));
  // Units come from the dictionary, not from the submission -- the payload
  // only carries workId/workName/volume, and a bare "1878" is not a number
  // an admin can sanity-check without knowing whether it's m2 or hours.
  const unitByWorkId = new Map(workRows.map((w) => [w.id, w.unit ?? ""]));

  const latestByGroup = new Map<string, (typeof rows)[number]>();
  for (const r of rows) {
    const key = `${r.date}|${r.foremanTgId}`;
    if (!latestByGroup.has(key)) latestByGroup.set(key, r); // rows are ts-desc already
  }
  const pendingGroups = [...latestByGroup.values()].filter((r) => r.status === "АКТИВНА");

  const items = await Promise.all(
    pendingGroups.map(async (r) => {
      const foremanTgId = Number(r.foremanTgId);
      // Only legs still awaiting a decision -- a leg already approved earlier
      // (possibly days ago, possibly already exported to БУХЗВІТ) must not
      // reappear bundled into a LATER, unrelated leg's pending request just
      // because it shares the same date+foreman.
      const trips = (await fetchAllTrips(r.date, foremanTgId)).filter((t) => t.status !== "ЗАТВЕРДЖЕНО");
      // The same roll-up the approval and the БУХЗВІТ export run on, so what
      // the admin decides from is exactly what gets written. Recomputing the
      // day inline here used to omit excludedKm, quietly showing a higher
      // trip class and travel allowance than approval would then record.
      const { mergedObjects, unionEmployeeIds, unionSelfTransportIds, totalKm, combined } = await computeApprovedDayTotals(trips, foremanTgId);
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
          works: (o.works ?? []).map((w) => ({
            workId: w.workId,
            workName: w.workName,
            volume: w.volume,
            unit: unitByWorkId.get(w.workId) ?? "",
            // Кому призначена робота -- саме це пояснює адміну, чому в однієї
            // людини сума більша за решту бригади на тому ж обʼєкті.
            employeeIds: w.employeeIds ?? [],
          })),
          // Фото виконаних робіт. Бригадир знімає їх на обʼєкті; для адміна
          // це єдиний спосіб побачити, за що він платить, не виїжджаючи.
          photoUrls: o.photoUrls ?? [],
        })),
        employeeIds: unionEmployeeIds,
        selfTransportIds: unionSelfTransportIds,
      };
    }),
  );

  items.sort((a, b) => (a.date === b.date ? a.submittedAt.localeCompare(b.submittedAt) : b.date.localeCompare(a.date)));
  res.json({ items, reasons: RETURN_REASONS });
});

async function setDayStatus(date: string, foremanTgId: number, status: string, tx?: LockedTx) {
  const rows = await (tx ?? db)
    .select()
    .from(schema.events)
    .where(and(eq(schema.events.date, date), eq(schema.events.foremanTgId, BigInt(foremanTgId)), eq(schema.events.type, "RTS_SAVE")));
  // Never re-touch a leg that's already fully approved -- a foreman can add a
  // brand-new leg (tripSeq) to a date after an earlier one was already
  // approved, and that later approve/return action must not drag the
  // already-finalized (and possibly already exported to БУХЗВІТ) leg back
  // into pending or flip it to "returned" alongside the new one.
  const rowsToUpdate = rows.filter((r) => r.status !== "ЗАТВЕРДЖЕНО");
  await Promise.all(
    rowsToUpdate.map((r) =>
      writeEvent(
        {
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
        },
        tx,
      ),
    ),
  );
  return rowsToUpdate.length;
}

/** The whole day rolled up from its legs -- merged objects plus the combined
 * payroll -- computed ONCE and shared by everything that reports on an
 * approved day, so the accountant's БУХЗВІТ rows and the summary the foreman
 * receives can never disagree about the same day's money. */
async function computeApprovedDayTotals(trips: StoredTrip[], foremanTgId?: number) {
  const mergedObjects = mergeObjects(trips.map((t) => t.objects));
  const unionEmployeeIds = [...new Set(trips.flatMap((t) => t.employeeIds))];
  const unionSelfTransportIds = [...new Set(trips.flatMap((t) => t.selfTransportIds ?? []))];
  const totalKm = trips.reduce((acc, t) => {
    const legKm = typeof t.odoStart === "number" && typeof t.odoEnd === "number" ? t.odoEnd - t.odoStart : 0;
    return acc + (Number.isFinite(legKm) ? legKm : 0);
  }, 0);
  // Errand km ("машина вибула по справам") are excluded from the trip class
  // and the travel allowance, exactly as POST / does when it computes the
  // day at submit time. Without this the approved day would be reclassified
  // upward here and pay a bigger allowance into БУХЗВІТ than the foreman was
  // shown when they submitted it.
  const totalExcludedKm = trips.reduce((acc, t) => acc + sumErrandKm(t.errands), 0);
  const combined = await computePayroll({
    odoStart: 0,
    odoEnd: totalKm,
    employeeIds: unionEmployeeIds,
    objects: mergedObjects,
    selfTransportIds: unionSelfTransportIds,
    excludedKm: totalExcludedKm,
    foremanTgId,
  });
  return { mergedObjects, unionEmployeeIds, unionSelfTransportIds, totalKm, totalExcludedKm, combined };
}

type ApprovedDayTotals = Awaited<ReturnType<typeof computeApprovedDayTotals>>;

/** Builds and writes this day's payroll into the shared БУХЗВІТ report for the
 * accountant, split per work item (see buildAccountingRows) -- mirrors what
 * the legacy bot does on ITS OWN approval flow, which never fires for a day
 * approved through the mini-app. Errors are logged, not thrown: the approval
 * itself has already succeeded by the time this runs, and a Sheets hiccup
 * here must not make the admin think the approval failed. */
async function exportApprovedDayToAccounting(
  date: string,
  foremanTgId: number,
  trips: StoredTrip[],
  totals: ApprovedDayTotals,
): Promise<{ ok: boolean; rows: number }> {
  try {
    const { mergedObjects, unionEmployeeIds, unionSelfTransportIds, combined } = totals;

    const workIds = [...new Set(mergedObjects.flatMap((o) => (o.works ?? []).map((w) => w.workId)))];
    const [workRows, foremanUser] = await Promise.all([
      workIds.length ? db.select().from(schema.works).where(inArray(schema.works.id, workIds)) : Promise.resolve([]),
      db.select().from(schema.users).where(eq(schema.users.tgId, BigInt(foremanTgId))).limit(1),
    ]);
    const tariffByWorkId = new Map(workRows.map((w) => [w.id, w.tariff]));
    const unitByWorkId = new Map(workRows.map((w) => [w.id, w.unit ?? ""]));
    const employeeNameById = new Map([...combined.employeeById].map(([id, v]) => [id, v.name]));
    const foremanName = foremanUser[0]?.pib ?? String(foremanTgId);

    const rows = buildAccountingRows({
      date,
      foremanName,
      objects: mergedObjects,
      salaryPacks: combined.salaryPacks,
      roadAllowancePerPerson: combined.roadAllowance.perPerson,
      // Беремо з ТОГО САМОГО computePayroll, що дав суму доплати, а не
      // рахуємо кілометри тут удруге: інакше рядок у БУХЗВІТі міг би з часом
      // розійтися з власною сумою.
      roadKm: combined.km,
      roadBillableKm: combined.billableKm,
      roadTripClass: combined.tripClass,
      // Години з того самого розрахунку, що дав суми: обʼєкт -> людина -> год.
      hoursByObject: new Map(
        combined.perObjectHours.map((h) => [
          h.objectId,
          new Map([...h.hoursByEmployee].map(([id, v]) => [id, Math.round((v.ms / 3_600_000) * 100) / 100])),
        ]),
      ),
      unionEmployeeIds: unionEmployeeIds.filter((id) => !unionSelfTransportIds.includes(id)),
      employeeNameById,
      tariffByWorkId,
      unitByWorkId,
    });

    // Keyed on the trips' own eventIds (not just date+foreman) so a day that
    // gets returned for correction, resubmitted, and re-approved is treated
    // as a NEW state to export -- the corrected numbers must reach the
    // accountant instead of being skipped as "already done" from the first,
    // wrong approval.
    const exportKey = `MINIAPP|${date}|${foremanTgId}|${trips.map((t) => t.eventId).sort().join(",")}`;
    const result = await writeAccountingReportForDay({ key: exportKey, rows });
    return { ok: true, rows: result.rows };
  } catch (e) {
    console.error(`[accounting] failed to export date=${date} foremanTgId=${foremanTgId}: ${(e as Error).message}`);
    return { ok: false, rows: 0 };
  }
}

/** Telegram's legacy Markdown breaks on unescaped _ * [ ` in the text, and a
 * broken message is silently rejected by the API -- which for a payout
 * summary means the foreman just never hears about their money. Object and
 * employee names come from the office's spreadsheets, so they can contain
 * anything. */
function escapeMd(s: string): string {
  return s.replace(/([_*[\]`])/g, "\\$1");
}

function money(n: number): string {
  return String(Math.round(n * 100) / 100);
}

/**
 * The short payout note a foreman gets the moment an admin approves their
 * day: which object, who earned how much there, and the day's total fund.
 * Deliberately brief -- the itemised view (hours, works, volumes, per-object
 * funds) is the ADMIN's, on the approval screen they act from. This is just
 * the outcome, for the person who has to tell the crew what they made.
 *
 * `pay` in a salary pack row is already role-adjusted (the brigadier's 20%
 * and the senior gardener's 10% come off the top, the rest splits between
 * workers by hours), so the rows as listed ARE the real per-person work pay.
 * The travel allowance is per-person and separate from the object funds, so
 * it stays its own line instead of being folded into those numbers -- drop
 * it and the amounts stop adding up to what people actually receive.
 */
function buildApprovalReport(date: string, totals: ApprovedDayTotals): string {
  const { combined } = totals;
  const packs = combined.salaryPacks.filter((p) => p.objectTotal > 0 || p.rows.length > 0);
  const totalFund = packs.reduce((acc, p) => acc + p.objectTotal, 0);

  const head = [`✅ *День затверджено*`, `📅 ${date}`, ``];
  const foot = [
    `➕ Доплата за виїзд: ${money(combined.roadAllowance.perPerson)} грн/особу`,
    `💰 *Загальний фонд: ${money(totalFund)} грн*`,
  ];

  const perObject = (withPeople: boolean) =>
    packs.flatMap((pack) => {
      const lines = [`📍 *${escapeMd(pack.objectName)}*`];
      if (withPeople) {
        if (!pack.rows.length) lines.push(`  _немає годин — оплата не розподілена_`);
        for (const row of pack.rows) lines.push(`  • ${escapeMd(row.employeeName)} — ${money(row.pay)} грн`);
      }
      lines.push(``);
      return lines;
    });

  // Telegram rejects anything over 4096 characters outright. At this size
  // that needs a truly enormous day, but if it ever happens the note sheds
  // the per-person lines rather than its tail -- the total fund is the whole
  // point of the message and always survives.
  const LIMIT = 3900;
  const note = [`_Деталі скорочено — повний розклад у застосунку._`, ``];
  const variants = [
    [...head, ...perObject(true), ...foot],
    [...head, ...perObject(false), ...note, ...foot],
    [...head, ...note, ...foot],
  ];
  const chosen = variants.find((v) => v.join("\n").length <= LIMIT) ?? variants[variants.length - 1];
  return chosen.join("\n").slice(0, LIMIT);
}

/** POST /api/road-timesheet/pending/approve — admin-only. { date, foremanTgId } */
roadTimesheetRouter.post("/pending/approve", async (req, res) => {
  if (blockNonAdmin(req, res)) return;
  const { date, foremanTgId } = req.body as { date: string; foremanTgId: number };
  if (!date || !foremanTgId) {
    res.status(400).json({ error: "date and foremanTgId are required" });
    return;
  }

  // Shares the same per-date lock as POST / (final save) and is itself
  // idempotent-safe under concurrency: a foreman submitting a brand-new leg
  // at the exact moment an admin approves, or an admin double-tapping
  // "Затвердити", would otherwise race outside a lock -- either a
  // just-submitted leg gets marked ЗАТВЕРДЖЕНО without ever being exported
  // (money silently missing from БУХЗВІТ, and unrecoverable since an
  // already-approved leg is filtered out of every future pending list), or
  // two concurrent approvals both see "not yet exported" and both export,
  // double-paying the day. Re-reading pendingTrips INSIDE the lock (not
  // before it) is what actually closes both windows.
  let pendingTrips: StoredTrip[] = [];
  let count = 0;
  await withLock(`reserve:${date}`, async (tx) => {
    // Captured BEFORE setDayStatus flips their status, so the accounting
    // export below only ever covers the legs THIS action just approved --
    // once setDayStatus runs, an already-approved-earlier leg would be
    // indistinguishable from one just approved now (both "ЗАТВЕРДЖЕНО"),
    // which would re-export it and double-count it in БУХЗВІТ.
    pendingTrips = (await fetchAllTrips(date, foremanTgId, tx)).filter((t) => t.status !== "ЗАТВЕРДЖЕНО");
    if (!pendingTrips.length) return;
    count = await setDayStatus(date, foremanTgId, "ЗАТВЕРДЖЕНО", tx);
  });

  if (!pendingTrips.length || !count) {
    res.status(404).json({ error: "No submission found for that date/foreman" });
    return;
  }

  // The approval itself is already committed, so nothing below may fail the
  // request: the accountant's export swallows its own errors, and if the
  // payroll roll-up itself breaks, the foreman still gets told their day was
  // approved -- just without the breakdown.
  let accountingExported = false;
  try {
    const totals = await computeApprovedDayTotals(pendingTrips, foremanTgId);
    accountingExported = (await exportApprovedDayToAccounting(date, foremanTgId, pendingTrips, totals)).ok;
    await sendTelegramMessage(foremanTgId, buildApprovalReport(date, totals));
  } catch (e) {
    console.error(`[approve] summary/export failed date=${date} foremanTgId=${foremanTgId}: ${(e as Error).message}`);
    await sendTelegramMessage(foremanTgId, `✅ *День затверджено адміністратором*\n📅 Дата: ${date}`);
  }

  res.json({ ok: true, accountingExported });
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

  // The reason has to outlive the Telegram message: the foreman reads it once
  // in a chat that keeps scrolling, then opens the app to act on it. GET
  // /day-status serves it back from here so it's on screen the whole time
  // they're fixing the day.
  await writeEvent({
    eventId: makeEventId("RTSRET"),
    status: "АКТИВНА",
    date,
    foremanTgId,
    type: "RTS_RETURN",
    payload: JSON.stringify({ reasonCode, reasonText, note: note ?? "" }),
  });

  await sendTelegramMessage(
    foremanTgId,
    `🔴 *День повернено адміністратором*\n📅 Дата: ${date}\n📝 Причина: ${reasonText}${note ? ` — ${note}` : ""}\n\nРедагування знову доступне. Відкрий "Дорожній табель", виправ дані і надішли повторно.`,
  );
  res.json({ ok: true });
});

/**
 * POST /api/road-timesheet/pending/delete — admin-only. { date, foremanTgId }
 *
 * Removes a day's report entirely: the events, the works, the timesheet rows,
 * the allowances, the day status and the odometer, from the SHEET first and
 * then from Postgres. Sheet first because the sync worker only upserts -- a
 * row deleted from Postgres alone is back within a cycle, and the sheet is
 * the source of truth besides.
 *
 * "Повернути на редагування" is the everyday tool; this is for a day that
 * should never have existed (a test run, a duplicate, the wrong foreman).
 * It cannot be undone, so the client asks twice.
 */
/**
 * POST /api/road-timesheet/trip/delete — { date, tripSeq, foremanTgId? }
 *
 * Прибирає ОДНУ поїздку дня. Доти єдиним способом позбутися зайвої була
 * `/pending/delete`, тобто знесення всього дня — а зайва поїздка зʼявляється
 * саме тоді, коли решта дня правильна й переробляти її нема за чим.
 *
 * Задвоєна поїздка не просто зайва картка: mergeObjects складає сесії та
 * обсяги всіх поїздок дня, тож дубль того самого обʼєкта подвоює і години
 * людей, і фонд обʼєкта. Тому видалення — це перерахунок дня (спільний
 * reconcileDayTotals), а не DELETE рядка.
 *
 * Бригадир видаляє свою поїздку, адмін — будь-чию (`foremanTgId` у тілі).
 * Затверджену не видаляє ніхто: вона вже в БУХЗВІТі. Останню поїздку дня теж
 * ні — «день не потрібен зовсім» це інша дія, вона в адміна.
 */
roadTimesheetRouter.post("/trip/delete", async (req, res) => {
  const { date, tripSeq, foremanTgId: bodyForemanTgId } = req.body as {
    date: string;
    tripSeq: number;
    foremanTgId?: number;
  };
  if (!date || !Number.isFinite(tripSeq)) {
    res.status(400).json({ error: "date and tripSeq are required" });
    return;
  }
  // Чужий день чіпає тільки адмін; бригадиру foremanTgId з тіла не вірять.
  const isAdmin = req.user!.role === "ADMIN";
  const foremanTgId = isAdmin && bodyForemanTgId ? Number(bodyForemanTgId) : req.user!.tgId;

  try {
    await withLock(`reserve:${date}`, async (tx) => {
      const allTripsBefore = await fetchAllTrips(date, foremanTgId, tx);
      const target = allTripsBefore.find((t) => t.tripSeq === tripSeq);
      if (!target) throw new ReservationConflictError("Такої поїздки в цьому дні немає");
      if (target.status === "ЗАТВЕРДЖЕНО") {
        throw new ReservationConflictError("Затверджену поїздку видалити не можна — спершу поверніть день на редагування");
      }
      if (allTripsBefore.length < 2) {
        throw new ReservationConflictError("Це єдина поїздка дня. Щоб прибрати день цілком, зверніться до адміна");
      }

      const tripsAfter = allTripsBefore.filter((t) => t.tripSeq !== tripSeq);
      await reconcileDayTotals(tx, { date, foremanTgId, allTripsBefore, tripsAfter });

      // Одометр авто звільняємо, лише якщо ним не їхала жодна інша поїздка
      // дня: та сама обережність, що й при зміні авто в межах поїздки.
      if (target.carId && !tripsAfter.some((t) => t.carId === target.carId)) {
        await writeOdometerDay({ date, carId: target.carId, foremanTgId }, tx);
        await tx
          .delete(schema.odometerDays)
          .where(and(eq(schema.odometerDays.date, date), eq(schema.odometerDays.carId, target.carId)));
      }

      // Події цієї поїздки -- усі, а не лише останню: fetchAllTrips бере на
      // tripSeq найсвіжішу, тож лишена стара повернула б поїздку назад.
      const rows = await tx
        .select()
        .from(schema.events)
        .where(and(eq(schema.events.date, date), eq(schema.events.foremanTgId, BigInt(foremanTgId)), eq(schema.events.type, "RTS_SAVE")));
      const doomed = rows.filter((r) => {
        try {
          return (JSON.parse(r.payload ?? "{}").tripSeq ?? 0) === tripSeq;
        } catch {
          return false;
        }
      });
      if (doomed.length) {
        await tx.delete(schema.events).where(inArray(schema.events.eventId, doomed.map((r) => r.eventId)));
      }

      // Слід у журналі: це видалення грошових даних, і за півдня ніхто не
      // згадає, чому в дні стало на поїздку менше.
      await writeEvent(
        {
          eventId: makeEventId("RTSDEL"),
          status: "АКТИВНА",
          date,
          foremanTgId,
          type: "RTS_TRIP_DELETE",
          carId: target.carId ?? "",
          employeeIds: JSON.stringify(target.employeeIds ?? []),
          payload: JSON.stringify({
            tripSeq,
            deletedBy: req.user!.tgId,
            odoStart: target.odoStart,
            odoEnd: target.odoEnd,
            objects: target.objects,
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

  res.json({ ok: true });
});

roadTimesheetRouter.post("/pending/delete", async (req, res) => {
  if (blockNonAdmin(req, res)) return;
  const { date, foremanTgId } = req.body as { date: string; foremanTgId: number };
  if (!date || !foremanTgId) {
    res.status(400).json({ error: "date and foremanTgId are required" });
    return;
  }
  const tgId = BigInt(foremanTgId);

  // ТАБЕЛЬ carries no foreman column, so the day's own events say which
  // objects and people were this foreman's -- without that, deleting by date
  // alone would take another brigade's rows on a shared object.
  const events = await db
    .select()
    .from(schema.events)
    .where(and(eq(schema.events.date, date), eq(schema.events.foremanTgId, tgId)));
  const objectIds = new Set<string>();
  const employeeIds = new Set<string>();
  const carIds = new Set<string>();
  for (const e of events) {
    if (e.carId) carIds.add(e.carId);
    try {
      const payload = JSON.parse(e.payload ?? "{}") as {
        objects?: { objectId?: string; sessions?: { employeeId?: string }[] }[];
        employeeIds?: string[];
      };
      for (const o of payload.objects ?? []) {
        if (o.objectId) objectIds.add(o.objectId);
        for (const s of o.sessions ?? []) if (s.employeeId) employeeIds.add(s.employeeId);
      }
      for (const id of payload.employeeIds ?? []) employeeIds.add(id);
    } catch {
      // a malformed payload must not stop the rest of the day being removed
    }
  }

  // Working data lives in Postgres alone now, so deleting a day is a plain
  // set of DELETEs. It used to have to clear the Google Sheets rows first --
  // otherwise the next sync cycle put the day straight back ~45s later.
  await db.delete(schema.events).where(and(eq(schema.events.date, date), eq(schema.events.foremanTgId, tgId)));
  await db.delete(schema.reports).where(and(eq(schema.reports.date, date), eq(schema.reports.foremanTgId, tgId)));
  await db.delete(schema.allowances).where(and(eq(schema.allowances.date, date), eq(schema.allowances.foremanTgId, tgId)));
  await db.delete(schema.dayStatuses).where(and(eq(schema.dayStatuses.date, date), eq(schema.dayStatuses.foremanTgId, tgId)));
  await db.delete(schema.odometerDays).where(and(eq(schema.odometerDays.date, date), eq(schema.odometerDays.foremanTgId, tgId)));
  if (objectIds.size && employeeIds.size) {
    await db
      .delete(schema.timesheetEntries)
      .where(
        and(
          eq(schema.timesheetEntries.date, date),
          inArray(schema.timesheetEntries.objectId, [...objectIds]),
          inArray(schema.timesheetEntries.employeeId, [...employeeIds]),
        ),
      );
  }

  await sendTelegramMessage(
    foremanTgId,
    `🗑 *Звіт видалено адміністратором*\n📅 Дата: ${date}\n\nЯкщо це помилка — зверніться до адміністратора. День можна внести заново.`,
  ).catch(() => {});

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
