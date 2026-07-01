import { Router } from "express";
import { db, schema } from "@landscape/core";
import { eq } from "drizzle-orm";

export const dictionariesRouter = Router();

dictionariesRouter.get("/employees", async (_req, res) => {
  const rows = await db.select().from(schema.employees).where(eq(schema.employees.active, true));
  res.json(rows);
});

dictionariesRouter.get("/objects", async (_req, res) => {
  const rows = await db.select().from(schema.objects).where(eq(schema.objects.active, true));
  res.json(rows);
});

dictionariesRouter.get("/works", async (_req, res) => {
  const rows = await db.select().from(schema.works).where(eq(schema.works.active, true));
  res.json(rows);
});

dictionariesRouter.get("/cars", async (_req, res) => {
  const rows = await db.select().from(schema.cars).where(eq(schema.cars.active, true));
  res.json(rows);
});

dictionariesRouter.get("/materials", async (_req, res) => {
  const rows = await db.select().from(schema.materials).where(eq(schema.materials.active, true));
  res.json(rows);
});

dictionariesRouter.get("/tools", async (_req, res) => {
  const rows = await db.select().from(schema.tools).where(eq(schema.tools.active, true));
  res.json(rows);
});

dictionariesRouter.get("/logistics", async (_req, res) => {
  const rows = await db.select().from(schema.logisticDirections).where(eq(schema.logisticDirections.active, true));
  res.json(
    rows.map((r) => ({
      id: r.id,
      name: r.name,
      tariff: r.tariff,
      discountsByQty: r.discountsByQty ? JSON.parse(r.discountsByQty) : {},
    })),
  );
});
