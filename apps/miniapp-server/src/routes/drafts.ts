import { asyncRouter } from "../asyncRouter.js";
import { db, schema, withLock } from "@landscape/core";
import { desc, eq } from "drizzle-orm";
import { draftWriteConflict, draftClearConflict, parkedDraft } from "../lib/draftProtection.js";

/**
 * Дзеркало незданого дня.
 *
 * Телефон лишається робочою копією — він працює без звʼязку і вирішує, що
 * правда. Сюди він шле знімок чернетки після кожної зміни. Сервер її НЕ
 * рахує: зарплату як і раніше визначає RTS_SAVE. Дзеркало потрібне для двох
 * речей — щоб адмін бачив живий день, і щоб день можна було підняти на
 * іншому телефоні, якщо цей загубився.
 */
export const draftsRouter = asyncRouter();

const snapshotJson = (value: unknown) => JSON.stringify(value, (_key, v) => typeof v === "bigint" ? String(v) : v);

const trim = (v: unknown, max: number) => String(v ?? "").slice(0, max);

/**
 * PUT /api/drafts — знімок чернетки. Викликається фоном, після кожної зміни.
 *
 * Version-aware writers compare the revision under a per-foreman lock.
 * Previous and rejected snapshots remain in append-only recovery history.
 */
draftsRouter.put("/", async (req, res) => {
  const body = (req.body ?? {}) as {
    date?: string;
    step?: string;
    carId?: string;
    employeeIds?: string[];
    objectNames?: string[];
    tripStartedAt?: string | null;
    payload?: unknown;
    baseRevision?: number;
  };
  if (body.payload === undefined) {
    res.status(400).json({ error: "payload is required" });
    return;
  }
  if (!body.payload || typeof body.payload !== "object" || Array.isArray(body.payload)
      || JSON.stringify(body.payload).length > 400_000) {
    res.status(400).json({ error: "Некоректна або завелика чернетка. Дані не змінено." });
    return;
  }
  const foremanTgId = BigInt(req.user!.tgId);
  const started = body.tripStartedAt ? new Date(body.tripStartedAt) : null;

  const row = {
    foremanTgId,
    date: trim(body.date, 10),
    step: trim(body.step, 30),
    carId: trim(body.carId, 40),
    employeeIds: JSON.stringify(Array.isArray(body.employeeIds) ? body.employeeIds.slice(0, 60).map(String) : []),
    objectNames: (Array.isArray(body.objectNames) ? body.objectNames.map(String) : []).join(", ").slice(0, 500),
    tripStartedAt: started && !Number.isNaN(started.getTime()) ? started : null,
    // Обрізаємо з великим запасом: чернетка дня — це кілька кілобайт, а все
    // помітно більше означає, що щось пішло не так, і краще не класти це в базу.
    payload: JSON.stringify(body.payload),
    updatedAt: new Date(),
  };

  const result = await withLock(`draft:${foremanTgId}`, async tx => {
    const [head] = await tx.select().from(schema.draftHeads).where(eq(schema.draftHeads.foremanTgId, foremanTgId));
    const revision = head?.revision ?? 0;
    const [current] = await tx.select().from(schema.dayDrafts).where(eq(schema.dayDrafts.foremanTgId, foremanTgId));
    // A retry after a lost response is safe and doesn't create a second version.
    if (current?.payload === row.payload) return { ok: true, revision };
    const [adopted] = await tx.select().from(schema.tripDraftOwners).where(eq(schema.tripDraftOwners.foremanTgId,foremanTgId));
    const conflict = adopted ? 'upgrade_required' : draftWriteConflict(current ? JSON.parse(current.payload) : null,
      body.payload as Record<string, unknown>, revision, body.baseRevision, !!head?.managed);
    await tx.insert(schema.draftHistory).values({ foremanTgId, revision,
      action: conflict ? `rejected:${conflict}` : "before_write", snapshot: snapshotJson(current ?? null) });
    await tx.insert(schema.draftHistory).values({ foremanTgId, revision: conflict ? revision : revision + 1,
      action: conflict ? "rejected_incoming" : "write", snapshot: snapshotJson(row) });
    if (conflict) return { ok: false, revision };
    await tx.insert(schema.dayDrafts).values(row).onConflictDoUpdate({ target: schema.dayDrafts.foremanTgId, set: row });
    await tx.insert(schema.draftHeads).values({ foremanTgId, revision: revision + 1, managed: body.baseRevision !== undefined })
      .onConflictDoUpdate({ target: schema.draftHeads.foremanTgId, set: { revision: revision + 1, managed: head?.managed || body.baseRevision !== undefined } });
    return { ok: true, revision: revision + 1 };
  });
  res.status(result.ok ? 200 : 409).json(result.ok ? result : { ...result,
    error: "Захист чернетки: сервер зберіг іншу версію. Ваші зміни залишилися на телефоні та в історії. Не скидайте поїздку; повідомте адміністратора." });
});

/**
 * GET /api/drafts/mine — чернетка цього бригадира, якщо сервер її має.
 *
 * Потрібна рівно в одному випадку: на телефоні порожньо, а день був. Новий
 * телефон, почищений кеш, перевстановлений Telegram.
 */
draftsRouter.get("/mine", async (req, res) => {
  const { row, revision } = await withLock(`draft:${req.user!.tgId}`, async tx => {
    const id = BigInt(req.user!.tgId);
    const [row] = await tx.select().from(schema.dayDrafts).where(eq(schema.dayDrafts.foremanTgId, id)).limit(1);
    const [head] = await tx.select().from(schema.draftHeads).where(eq(schema.draftHeads.foremanTgId, id));
    return { row, revision: head?.revision ?? 0 };
  });
  res.set("Cache-Control", "no-store");
  if (!row) {
    res.json({ found: false, revision });
    return;
  }
  let payload: unknown = null;
  try {
    payload = JSON.parse(row.payload);
  } catch {
    payload = null;
  }
  res.json({ found: !!payload, date: row.date, updatedAt: row.updatedAt, payload, revision });
});

// Keep a copy and revision even after clearing: late writes must not resurrect it.
async function clearStoredDraft(id: bigint, base: unknown, admin = false) {
  return withLock(`draft:${id}`, async tx => {
    const [current] = await tx.select().from(schema.dayDrafts).where(eq(schema.dayDrafts.foremanTgId, id));
    const [head] = await tx.select().from(schema.draftHeads).where(eq(schema.draftHeads.foremanTgId, id));
    const revision = head?.revision ?? 0;
    if (draftClearConflict(revision, base, !!head?.managed, admin)) {
      await tx.insert(schema.draftHistory).values({ foremanTgId: id, revision,
        action: "rejected_clear", snapshot: snapshotJson(current ?? null) });
      return { ok: false, revision };
    }
    await tx.insert(schema.draftHistory).values({ foremanTgId: id, revision,
      action: admin ? "admin_before_clear" : "before_clear", snapshot: snapshotJson(current ?? null) });
    const stash = !admin && current ? parkedDraft(JSON.parse(current.payload)) : null;
    if (stash) {
      const restored = { date: String(stash.date ?? current!.date), step: String(stash.step ?? "INDEX"),
        carId: String(stash.carId ?? ""), employeeIds: JSON.stringify(stash.employeeIds ?? []),
        objectNames: (stash.plans ?? []).map((p: { objectName: string }) => p.objectName).join(", "),
        tripStartedAt: stash.tripStartedAt ? new Date(stash.tripStartedAt) : null,
        payload: JSON.stringify(stash), updatedAt: new Date() };
      await tx.update(schema.dayDrafts).set(restored).where(eq(schema.dayDrafts.foremanTgId, id));
    } else await tx.delete(schema.dayDrafts).where(eq(schema.dayDrafts.foremanTgId, id));
    await tx.insert(schema.draftHeads).values({ foremanTgId: id, revision: revision + 1 })
      .onConflictDoUpdate({ target: schema.draftHeads.foremanTgId, set: { revision: revision + 1 } });
    return { ok: true, revision: revision + 1 };
  });
}
draftsRouter.delete("/", async (req, res) => {
  const base = req.query.baseRevision === undefined ? undefined : Number(req.query.baseRevision);
  const result = await clearStoredDraft(BigInt(req.user!.tgId), base);
  res.status(result.ok ? 200 : 409).json(result.ok ? result : { ...result,
    error: "Захист чернетки: новішу серверну версію не очищено." });
});

/**
 * DELETE /api/drafts/:foremanTgId — прибрати чужий незавершений день. Адмін.
 *
 * Розділ «Почали, але не здали» показує все, що висить, і не має власного
 * терміну придатності: тестові прогони, кинуті чернетки, день, який бригадир
 * почав і забув. Вони лишаються там назавжди, і чим їх більше, тим менше
 * видно ті, що справді потребують уваги.
 *
 * Чіпає ТІЛЬКИ дзеркало (`day_drafts`). Зданий день живе в подіях і сюди не
 * входить: прибрати незавершений день неможливо переплутати зі знесенням
 * робочого — того, що не здано, у звітності немає взагалі.
 */
draftsRouter.delete("/:foremanTgId", async (req, res) => {
  if (req.user!.role !== "ADMIN") {
    res.status(403).json({ error: "Тільки для адміністратора" });
    return;
  }
  let tgId: bigint;
  try {
    tgId = BigInt(req.params.foremanTgId);
  } catch {
    res.status(400).json({ error: "foremanTgId має бути числом" });
    return;
  }
  const result = await clearStoredDraft(tgId, undefined, true);
  res.json(result);
});

/**
 * GET /api/drafts/all — усі незавершені дні, тільки адмін.
 *
 * Це те, чого бракувало: бригада, яка працює, але ще не здала день, більше не
 * невидима. Разом з датою чернетки — саме розбіжність між нею й сьогоднішньою
 * і була причиною того, що день поїхав учорашнім числом.
 */
draftsRouter.get("/all", async (req, res) => {
  if (req.user!.role !== "ADMIN") {
    res.status(403).json({ error: "Тільки для адміністратора" });
    return;
  }
  const [rows, users, cars, employees, independent, adopted] = await Promise.all([
    db.select().from(schema.dayDrafts).orderBy(desc(schema.dayDrafts.updatedAt)),
    db.select().from(schema.users),
    db.select().from(schema.cars),
    db.select().from(schema.employees),
    db.select().from(schema.tripDrafts).where(eq(schema.tripDrafts.state,"open")).orderBy(desc(schema.tripDrafts.updatedAt)),
    db.select().from(schema.tripDraftOwners),
  ]);
  const nameByTgId = new Map(users.map((u) => [String(u.tgId), u.pib]));
  const carById = new Map(cars.map((c) => [c.id, c.name]));
  const employeeById = new Map(employees.map((e) => [e.id, e.name]));

  res.json({
    ok: true,
    drafts: [...rows.filter(r=>!adopted.some(a=>a.foremanTgId===r.foremanTgId)),...independent.map(r=>{
      const p=JSON.parse(r.payload);
      return {...r,date:p.date,step:p.step,carId:p.carId??"",employeeIds:JSON.stringify(p.employeeIds??[]),
        objectNames:(p.plans??[]).map((x:any)=>x.objectName).join(", "),tripStartedAt:p.tripStartedAt?new Date(p.tripStartedAt):null};
    })].map((r) => {
      let ids: string[] = [];
      try {
        ids = JSON.parse(r.employeeIds);
      } catch {
        ids = [];
      }
      return {
        id: "id" in r ? r.id : undefined,
        revision: "revision" in r ? r.revision : undefined,
        foremanTgId: String(r.foremanTgId),
        foremanName: nameByTgId.get(String(r.foremanTgId)) ?? String(r.foremanTgId),
        date: r.date,
        step: r.step,
        carName: r.carId ? (carById.get(r.carId) ?? r.carId) : "",
        people: ids.map((id) => employeeById.get(id) ?? id),
        objectNames: r.objectNames,
        tripStartedAt: r.tripStartedAt?.toISOString() ?? null,
        updatedAt: r.updatedAt.toISOString(),
      };
    }),
  });
});
