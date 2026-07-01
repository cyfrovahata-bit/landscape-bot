import { Router } from "express";
import { db, schema, writeEvent, makeEventId } from "@landscape/core";
import { and, eq } from "drizzle-orm";

export const logisticsRouter = Router();

type LogisticsItemInput = {
  logisticId: string;
  logisticName: string;
  tariff: number;
  qty: number;
  employeeIds: string[];
};

/** POST /api/logistics — mirrors logistics.flow.ts's final save step. */
logisticsRouter.post("/", async (req, res) => {
  const { date, items } = req.body as { date: string; items: LogisticsItemInput[] };
  if (!date || !Array.isArray(items) || !items.length) {
    res.status(400).json({ error: "date and at least one item are required" });
    return;
  }

  const employeeIds = [...new Set(items.flatMap((it) => it.employeeIds))];

  const totalsByEmployee: Record<string, number> = {};
  for (const it of items) {
    const total = Math.max(0, (Number(it.tariff) || 0) * (Number(it.qty) || 0));
    const per = it.employeeIds.length ? total / it.employeeIds.length : 0;
    for (const empId of it.employeeIds) {
      totalsByEmployee[empId] = (totalsByEmployee[empId] || 0) + per;
    }
  }

  const eventId = makeEventId("LG");
  await writeEvent({
    eventId,
    status: "АКТИВНА",
    date,
    foremanTgId: req.user!.tgId,
    type: "ЛОГІСТИКА",
    employeeIds: JSON.stringify(employeeIds),
    payload: JSON.stringify({ schemaVersion: 3, items, totalsByEmployee }),
  });

  res.json({ eventId, totalsByEmployee });
});

/** GET /api/logistics/today?date=YYYY-MM-DD — for review before/after saving. */
logisticsRouter.get("/today", async (req, res) => {
  const date = String(req.query.date || "");
  if (!date) {
    res.status(400).json({ error: "date query param is required" });
    return;
  }

  const rows = await db
    .select()
    .from(schema.events)
    .where(and(eq(schema.events.date, date), eq(schema.events.type, "ЛОГІСТИКА"), eq(schema.events.foremanTgId, BigInt(req.user!.tgId))));

  res.json(
    rows.map((r) => ({
      eventId: r.eventId,
      status: r.status,
      payload: r.payload ? JSON.parse(r.payload) : null,
    })),
  );
});
