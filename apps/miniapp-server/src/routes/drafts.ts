import { asyncRouter } from "../asyncRouter.js";
import { db, schema } from "@landscape/core";
import { desc, eq } from "drizzle-orm";

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

const trim = (v: unknown, max: number) => String(v ?? "").slice(0, max);

/**
 * PUT /api/drafts — знімок чернетки. Викликається фоном, після кожної зміни.
 *
 * Останній запис виграє, і це навмисно: конфлікту тут бути не може, бо в
 * одного бригадира один конструктор. Чия версія свіжіша — та й правильна.
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
  };
  if (body.payload === undefined) {
    res.status(400).json({ error: "payload is required" });
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
    payload: JSON.stringify(body.payload).slice(0, 400_000),
    updatedAt: new Date(),
  };

  await db
    .insert(schema.dayDrafts)
    .values(row)
    .onConflictDoUpdate({ target: schema.dayDrafts.foremanTgId, set: row });

  res.json({ ok: true });
});

/**
 * GET /api/drafts/mine — чернетка цього бригадира, якщо сервер її має.
 *
 * Потрібна рівно в одному випадку: на телефоні порожньо, а день був. Новий
 * телефон, почищений кеш, перевстановлений Telegram.
 */
draftsRouter.get("/mine", async (req, res) => {
  const [row] = await db
    .select()
    .from(schema.dayDrafts)
    .where(eq(schema.dayDrafts.foremanTgId, BigInt(req.user!.tgId)))
    .limit(1);
  if (!row) {
    res.json({ found: false });
    return;
  }
  let payload: unknown = null;
  try {
    payload = JSON.parse(row.payload);
  } catch {
    payload = null;
  }
  res.json({ found: !!payload, date: row.date, updatedAt: row.updatedAt, payload });
});

/** DELETE /api/drafts — день скинули або здали, дзеркалу тут більше нічого робити. */
draftsRouter.delete("/", async (req, res) => {
  await db.delete(schema.dayDrafts).where(eq(schema.dayDrafts.foremanTgId, BigInt(req.user!.tgId)));
  res.json({ ok: true });
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
  await db.delete(schema.dayDrafts).where(eq(schema.dayDrafts.foremanTgId, tgId));
  res.json({ ok: true });
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
  const [rows, users, cars, employees] = await Promise.all([
    db.select().from(schema.dayDrafts).orderBy(desc(schema.dayDrafts.updatedAt)),
    db.select().from(schema.users),
    db.select().from(schema.cars),
    db.select().from(schema.employees),
  ]);
  const nameByTgId = new Map(users.map((u) => [String(u.tgId), u.pib]));
  const carById = new Map(cars.map((c) => [c.id, c.name]));
  const employeeById = new Map(employees.map((e) => [e.id, e.name]));

  res.json({
    ok: true,
    drafts: rows.map((r) => {
      let ids: string[] = [];
      try {
        ids = JSON.parse(r.employeeIds);
      } catch {
        ids = [];
      }
      return {
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
