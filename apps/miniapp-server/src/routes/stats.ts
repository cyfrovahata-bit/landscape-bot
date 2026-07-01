import { Router } from "express";
import { db, schema } from "@landscape/core";
import { and, eq, sql } from "drizzle-orm";

export const statsRouter = Router();

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
