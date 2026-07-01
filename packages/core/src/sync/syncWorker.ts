import { schema } from "../db.js";
import { upsertBatch } from "./upsert.js";
import * as sheets from "./mappers.js";

/**
 * One full sync cycle: Sheets -> DB. Google Sheets is always the source
 * of truth; this only mirrors it into Postgres for fast reads from the
 * mini-app. Never writes back to Sheets from here.
 */
export async function runSyncCycle() {
  const startedAt = Date.now();

  await upsertBatch(schema.users, await sheets.readUsers(), schema.users.tgId, [
    "username",
    "pib",
    "role",
    "active",
    "comment",
  ]);

  await upsertBatch(schema.employees, await sheets.readEmployees(), schema.employees.id, [
    "name",
    "brigadeId",
    "position",
    "active",
  ]);

  await upsertBatch(schema.objects, await sheets.readObjects(), schema.objects.id, [
    "name",
    "address",
    "active",
  ]);

  await upsertBatch(schema.works, await sheets.readWorks(), schema.works.id, [
    "name",
    "category",
    "unit",
    "tariff",
    "active",
  ]);

  await upsertBatch(schema.cars, await sheets.readCars(), schema.cars.id, ["name", "plate", "active"]);

  await upsertBatch(schema.materials, await sheets.readMaterials(), schema.materials.id, [
    "name",
    "unit",
    "active",
    "category",
    "comment",
  ]);

  await upsertBatch(schema.tools, await sheets.readTools(), schema.tools.id, [
    "name",
    "active",
    "category",
    "comment",
  ]);

  await upsertBatch(schema.settings, await sheets.readSettings(), schema.settings.key, ["value", "comment"]);

  await upsertBatch(schema.events, await sheets.readEvents(), schema.events.eventId, [
    "status",
    "refEventId",
    "chatId",
    "ts",
    "date",
    "foremanTgId",
    "type",
    "objectId",
    "carId",
    "employeeIds",
    "payload",
    "msgId",
  ]);

  await upsertBatch(
    schema.odometerDays,
    await sheets.readOdometerDays(),
    [schema.odometerDays.date, schema.odometerDays.carId],
    ["foremanTgId", "startValue", "startPhoto", "endValue", "endPhoto", "kmDay", "tripClass"],
  );

  await upsertBatch(
    schema.allowances,
    await sheets.readAllowances(),
    [schema.allowances.date, schema.allowances.employeeId, schema.allowances.type],
    ["objectId", "foremanTgId", "employeeName", "amount", "meta", "dayStatus"],
  );

  await upsertBatch(
    schema.dayStatuses,
    await sheets.readDayStatuses(),
    [schema.dayStatuses.date, schema.dayStatuses.objectId, schema.dayStatuses.foremanTgId],
    [
      "status",
      "hasTimesheet",
      "hasReports",
      "hasReportsVolumeOk",
      "hasRoad",
      "hasOdoStart",
      "hasOdoEnd",
      "hasOdoStartPhoto",
      "hasOdoEndPhoto",
      "hasLogistics",
      "hasMaterials",
      "returnReason",
      "approvedBy",
      "approvedAt",
    ],
  );

  await upsertBatch(schema.materialMoves, await sheets.readMaterialMoves(), schema.materialMoves.moveId, [
    "time",
    "date",
    "objectId",
    "foremanTgId",
    "materialId",
    "materialName",
    "qty",
    "unit",
    "moveType",
    "purpose",
    "photos",
    "payload",
    "dayStatus",
  ]);

  await upsertBatch(schema.toolMoves, await sheets.readToolMoves(), schema.toolMoves.moveId, [
    "time",
    "date",
    "foremanTgId",
    "toolId",
    "toolName",
    "qty",
    "moveType",
    "purpose",
    "photos",
    "payload",
  ]);

  const ms = Date.now() - startedAt;
  console.log(`[SYNC] cycle complete in ${ms}ms`);
}

let running = false;

export function startSyncLoop(intervalMs: number) {
  const tick = async () => {
    if (running) return; // skip overlapping runs if a cycle is slow
    running = true;
    try {
      await runSyncCycle();
    } catch (err) {
      console.error("[SYNC] cycle failed", err);
    } finally {
      running = false;
    }
  };

  tick(); // run once immediately on startup
  return setInterval(tick, intervalMs);
}
