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
  makeEventId,
  uploadPhotoFromBuffer,
} from "@landscape/core";
import { and, eq } from "drizzle-orm";

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
type WorkInput = { workId: string; workName: string; volume?: string | number };
type ObjectInput = { objectId: string; objectName: string; works: WorkInput[]; sessions: WorkSession[] };

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

  const { km, tripClass } = await writeOdometerDay({
    date,
    carId,
    foremanTgId,
    startValue: odoStart,
    startPhoto: odoStartPhoto,
    endValue: odoEnd,
    endPhoto: odoEndPhoto,
  });

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
    payload: JSON.stringify({ odoStart, odoEnd, km, tripClass, objects }),
  });

  res.json({ eventId, km, tripClass });
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
