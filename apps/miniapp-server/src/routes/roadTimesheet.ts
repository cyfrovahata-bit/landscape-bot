import { Router } from "express";
import {
  db,
  schema,
  writeEvent,
  writeOdometerDay,
  writeReports,
  writeTimesheetRows,
  writeDayStatus,
  makeEventId,
} from "@landscape/core";
import { and, eq } from "drizzle-orm";

export const roadTimesheetRouter = Router();

type WorkInput = { workId: string; workName: string; volume?: string | number };
type HoursInput = { employeeId: string; employeeName: string; hours: number };
type ObjectInput = { objectId: string; works: WorkInput[]; hours: HoursInput[] };

/**
 * POST /api/road-timesheet — final save for the day.
 *
 * This is a deliberately scoped-down version of the bot's road timesheet
 * flow (apps/bot/src/bot/flows/roadTimesheet.flow.ts): the bot walks the
 * foreman through picking works first, then filling in a volume for each
 * one (RTS_PLAN_WORKS -> QTY_MENU), with a live drive/pause/object state
 * machine in between. Here the mini-app collects the same end data (car,
 * odometer, people, objects with works+volumes, hours per person) in one
 * screen and submits it as a single request; the live drive-state tracking
 * (RTS_DRIVE_START/PAUSE, pick-up/drop-off events) is not reproduced yet.
 */
roadTimesheetRouter.post("/", async (req, res) => {
  const { date, carId, odoStart, odoEnd, employeeIds, objects } = req.body as {
    date: string;
    carId: string;
    odoStart: number;
    odoEnd: number;
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
    endValue: odoEnd,
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

    if (obj.hours?.length) {
      await writeTimesheetRows(
        obj.hours.map((h) => ({
          date,
          objectId: obj.objectId,
          employeeId: h.employeeId,
          employeeName: h.employeeName,
          hours: h.hours,
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
      hasTimesheet: (obj.hours ?? []).length > 0,
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
