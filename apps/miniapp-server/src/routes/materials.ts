import { Router } from "express";
import { db, schema, writeMaterialMoves } from "@landscape/core";
import { and, eq } from "drizzle-orm";

export const materialsRouter = Router();

type MaterialItemInput = { materialId: string; materialName: string; unit: string; qty: number };

/** POST /api/materials — mirrors materials.flow.ts's final save step. */
materialsRouter.post("/", async (req, res) => {
  const { date, objectId, moveType, items, purpose } = req.body as {
    date: string;
    objectId: string;
    moveType: "ISSUE" | "RETURN" | "WRITEOFF" | "ADJUST";
    items: MaterialItemInput[];
    purpose?: string;
  };

  if (!date || !objectId || !moveType || !Array.isArray(items) || !items.length) {
    res.status(400).json({ error: "date, objectId, moveType and at least one item are required" });
    return;
  }

  const saved = await writeMaterialMoves(
    items.map((it) => ({
      date,
      objectId,
      foremanTgId: req.user!.tgId,
      materialId: it.materialId,
      materialName: it.materialName,
      qty: it.qty,
      unit: it.unit,
      moveType,
      purpose,
    })),
  );

  res.json({ moves: saved });
});

/** GET /api/materials/today?date=YYYY-MM-DD */
materialsRouter.get("/today", async (req, res) => {
  const date = String(req.query.date || "");
  if (!date) {
    res.status(400).json({ error: "date query param is required" });
    return;
  }

  const rows = await db
    .select()
    .from(schema.materialMoves)
    .where(and(eq(schema.materialMoves.date, date), eq(schema.materialMoves.foremanTgId, BigInt(req.user!.tgId))));

  res.json(rows);
});
