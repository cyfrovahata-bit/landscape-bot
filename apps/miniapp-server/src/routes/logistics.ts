import { Router } from "express";
import { db, schema, writeEvent, makeEventId } from "@landscape/core";
import { and, eq, inArray } from "drizzle-orm";

export const logisticsRouter = Router();

type LogisticsItemInput = {
  logisticId: string;
  qty: number;
  employeeIds: string[];
};

/**
 * POST /api/logistics — mirrors logistics.flow.ts's final save step.
 * Tariff/discount/name are looked up server-side from the ЛОГІСТИКА
 * dictionary (not trusted from the client) — same as the bot does.
 */
logisticsRouter.post("/", async (req, res) => {
  const { date, items } = req.body as { date: string; items: LogisticsItemInput[] };
  if (!date || !Array.isArray(items) || !items.length) {
    res.status(400).json({ error: "date and at least one item are required" });
    return;
  }

  const directions = await db
    .select()
    .from(schema.logisticDirections)
    .where(inArray(schema.logisticDirections.id, items.map((it) => it.logisticId)));
  const byId = new Map(directions.map((d) => [d.id, d]));

  const missing = items.map((it) => it.logisticId).filter((id) => !byId.has(id));
  if (missing.length) {
    res.status(400).json({ error: `Unknown logisticId(s): ${missing.join(", ")}` });
    return;
  }

  const employeeIds = [...new Set(items.flatMap((it) => it.employeeIds))];

  const totalsByEmployee: Record<string, number> = {};
  const resolvedItems = items.map((it) => {
    const dir = byId.get(it.logisticId)!;

    const qty = Number(it.qty) || 0;
    const discounts = dir.discountsByQty ? (JSON.parse(dir.discountsByQty) as Record<string, number>) : {};
    const discount = discounts[String(qty)] ?? 0;
    const total = Math.max(0, dir.tariff * qty - discount);
    const per = it.employeeIds.length ? total / it.employeeIds.length : 0;
    for (const empId of it.employeeIds) {
      totalsByEmployee[empId] = (totalsByEmployee[empId] || 0) + per;
    }

    return { logisticId: it.logisticId, logisticName: dir.name, tariff: dir.tariff, qty, employeeIds: it.employeeIds, total };
  });

  const eventId = makeEventId("LG");
  await writeEvent({
    eventId,
    status: "АКТИВНА",
    date,
    foremanTgId: req.user!.tgId,
    type: "ЛОГІСТИКА",
    employeeIds: JSON.stringify(employeeIds),
    payload: JSON.stringify({ schemaVersion: 3, items: resolvedItems, totalsByEmployee }),
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
