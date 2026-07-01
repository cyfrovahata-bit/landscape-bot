// scripts/sheets.smoke_test.v2.ts
import { config } from "../src/config.js";

import {
  SHEET_NAMES,
  fetchUsers,
  fetchEmployees,
  fetchObjects,
  fetchWorks,
  fetchCars,
  upsertDayStatus,
  upsertOdometerDay,
  appendEvents,
  upsertEvent,
  appendReports,
  upsertTimesheetRow,
  upsertAllowanceRow,
  upsertClosure,
  makeEventId,
  refreshDayChecklist,
} from "../src/google/sheets.js";

import { getSheetsClient } from "../src/google/client.js";
import { getDayStatusRow } from "../src/google/sheets/checklist.js";

function parseEmployeeIds(v?: string): string[] {
  const s = String(v ?? "").trim();
  if (!s) return [];
  if (s.startsWith("[")) {
    try {
      const arr = JSON.parse(s);
      if (Array.isArray(arr)) return arr.map((x) => String(x).trim()).filter(Boolean);
    } catch {}
  }
  return s.split(",").map((x) => x.trim()).filter(Boolean);
}

function roundQuarter(h: number) {
  return Math.round(h * 4) / 4; // nearest 0.25
}

function addMinutes(iso: string, mins: number) {
  return new Date(new Date(iso).getTime() + mins * 60_000).toISOString();
}


function todayUA(): string {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function isoNow() {
  return new Date().toISOString();
}

function sheetRef(sheetName: string) {
  const safe = sheetName.replace(/'/g, "''");
  return `'${safe}'`;
}

async function readHeaders(sheetName: string): Promise<string[]> {
  const sheets = getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: config.sheetId,
    range: `${sheetRef(sheetName)}!1:1`,
  });
  return (res.data.values?.[0] || []).map((x) => String(x ?? "").trim());
}

async function safeStep<T>(title: string, fn: () => Promise<T>) {
  try {
    const data = await fn();
    console.log(`✅ ${title}`);
    return { ok: true as const, data };
  } catch (e: any) {
    console.log(`❌ ${title}`);
    console.log(e?.message || e);
    return { ok: false as const, error: e };
  }
}

function assertOk<T>(
  r: { ok: true; data: T } | { ok: false; error: any },
  msg: string
): asserts r is { ok: true; data: T } {
  if (!r.ok) throw new Error(msg);
}

function pickFirst<T>(arr: readonly T[], msg: string): T {
  if (arr.length === 0) throw new Error(msg);
  return arr[0]!;
}

function pickSecondOrFirst<T>(arr: readonly T[], msg: string): T {
  if (arr.length === 0) throw new Error(msg);
  return (arr[1] ?? arr[0])!;
}

function assertAction(res: any, expected: Array<"appended" | "updated" | "created">, title: string) {
  const action = String(res?.action ?? "");
  if (!expected.includes(action as any)) {
    throw new Error(`${title}: expected action ${expected.join(" | ")}, got "${action}"`);
  }
}

function normalizeUserRole(v: any): "ADMIN" | "BRIGADIER" | null {
  const raw = String(v ?? "").trim().toUpperCase();

  if (
    raw === "ADMIN" ||
    raw === "АДМІН" ||
    raw === "АДМИН" ||
    raw === "АДМІНІСТРАТОР" ||
    raw === "АДМИНИСТРАТОР"
  ) {
    return "ADMIN";
  }

  if (raw === "BRIGADIER" || raw === "БРИГАДИР") {
    return "BRIGADIER";
  }

  return null;
}

async function main() {
  console.log("=== SHEETS SMOKE TEST v2 (extended) ===");
  console.log("sheetId:", config.sheetId);

  // 0) HEADERS sanity
  console.log("\n--- HEADERS (row 1) ---");
  for (const [k, name] of Object.entries(SHEET_NAMES)) {
    const r = await safeStep(`HEADERS: ${k} (${name})`, async () => readHeaders(name));
    if (r.ok) {
      const headers = r.data;
      console.log("   ", headers.join(" | "));
      if (headers.length === 0 || headers.every((h) => !h)) {
        throw new Error(`HEADERS empty for ${k} (${name}). Перевір назву листа/права/порожній рядок 1.`);
      }
    }
  }

  // 1) READ dictionaries
  console.log("\n--- READ DICTIONARIES ---");
  const usersR = await safeStep(`READ: users (${SHEET_NAMES.users})`, fetchUsers);
  const empsR = await safeStep(`READ: employees (${SHEET_NAMES.employees})`, fetchEmployees);
  const objsR = await safeStep(`READ: objects (${SHEET_NAMES.objects})`, fetchObjects);
  const worksR = await safeStep(`READ: works (${SHEET_NAMES.works})`, fetchWorks);
  const carsR = await safeStep(`READ: cars (${SHEET_NAMES.cars})`, fetchCars);

  assertOk(usersR, `Не можу прочитати ${SHEET_NAMES.users}`);
  assertOk(objsR, `Не можу прочитати ${SHEET_NAMES.objects}`);
  assertOk(empsR, `Не можу прочитати ${SHEET_NAMES.employees}`);
  assertOk(worksR, `Не можу прочитати ${SHEET_NAMES.works}`);
  assertOk(carsR, `Не можу прочитати ${SHEET_NAMES.cars}`);

  const user1 = pickFirst(usersR.data, `КОРИСТУВАЧІ: додай 1 активного (АКТИВ=так)`);
  const obj1 = pickFirst(objsR.data, `ОБЄКТИ: додай 1 активний (АКТИВ=так)`);
  const emp1 = pickFirst(empsR.data, `ПРАЦІВНИКИ: додай 1 активного (АКТИВ=так)`);
  const emp2 = pickSecondOrFirst(empsR.data, `ПРАЦІВНИКИ: додай 1 активного (АКТИВ=так)`);
  const work1 = pickFirst(worksR.data, `РОБОТИ: додай 1 активну роботу (АКТИВ=так)`);
  const car1 = pickFirst(carsR.data, `АВТО: додай 1 активне авто (АКТИВ=так)`);

  const date = todayUA();
  const foremanTgId = user1.tgId;
  const objectId = obj1.id;
  const carId = car1.id;

  console.log("\n--- UPSERT базові ---");

  await safeStep(`UPSERT: СТАТУС_ДНЯ (${SHEET_NAMES.dayStatus})`, async () => {
    const res = await upsertDayStatus({
      date,
      objectId,
      foremanTgId,
      status: "ЧЕРНЕТКА",
      hasTimesheet: false,
      hasReports: false,
      hasRoad: false,
      hasOdoStart: false,
      hasOdoEnd: false,
      hasLogistics: false,
      hasMaterials: false,
      returnReason: "",
      approvedBy: "",
      approvedAt: "",
    });
    // залежить від твоєї реалізації: може бути created/updated
    assertAction(res, ["created", "updated"], "upsertDayStatus");
    return res;
  });

  await safeStep(`UPSERT: ОДОМЕТР_ДЕНЬ (${SHEET_NAMES.odometerDay})`, async () => {
    const res = await upsertOdometerDay({
      date,
      carId,
      foremanTgId,
      startValue: 1000,
      startPhoto: "",
      endValue: 1010,
      endPhoto: "",
    });
    assertAction(res, ["created", "updated"], "upsertOdometerDay");
    return res;
  });

  console.log("\n--- EVENTS: append + upsert(update) ---");

  // sanity: makeEventId uniqueness
  await safeStep("makeEventId: uniqueness quick check", async () => {
    const a = makeEventId("SMOKE");
    const b = makeEventId("SMOKE");
    if (a === b) throw new Error(`makeEventId produced same id twice: ${a}`);
    return { a, b };
  });

  const eventId = makeEventId("SMOKE");
  const eventPayload1 = JSON.stringify({ kind: "SMOKE_EVENT", step: 1, at: isoNow() });
  const eventPayload2 = JSON.stringify({ kind: "SMOKE_EVENT", step: 2, at: isoNow() });

  await safeStep(`APPEND: ЖУРНАЛ_ПОДІЙ (${SHEET_NAMES.events})`, async () => {
    await appendEvents([
      {
        eventId,
        status: "АКТИВНА",
        ts: isoNow(),
        date,
        foremanTgId,
        type: "SMOKE_TEST",
        objectId,
        carId,
        employeeIds: JSON.stringify([emp1.id, emp2.id]),
        payload: eventPayload1,
        chatId: 0,
        msgId: 0,
      },
    ]);
    return { eventId };
  });

  await safeStep(`UPSERT(update): ЖУРНАЛ_ПОДІЙ (${SHEET_NAMES.events})`, async () => {
    const res = await upsertEvent({
      eventId,
      status: "ЗАТВЕРДЖЕНО",
      ts: isoNow(),
      date,
      foremanTgId,
      type: "SMOKE_TEST",
      objectId,
      carId,
      employeeIds: JSON.stringify([emp1.id]),
      payload: eventPayload2,
      chatId: 0,
      msgId: 0,
    });
    // тут ти очікуєш updated — ок
    assertAction(res, ["updated"], "upsertEvent(update)");
    return res;
  });

  console.log("\n--- REPORTS: append ---");

  await safeStep(`APPEND: ЗВІТИ (${SHEET_NAMES.reports})`, async () => {
    await appendReports([
      {
        date,
        objectId,
        foremanTgId,
        workId: work1.id,
        workName: work1.name,
        volume: 5,
        volumeStatus: "ЗАПОВНЕНО",
        photos: JSON.stringify([]),
        dayStatus: "ЧЕРНЕТКА",
      },
    ]);
    return { ok: true };
  });

  console.log("\n--- TIMESHEET: upsert (create + update) ---");

  await safeStep(`UPSERT(create/update): ТАБЕЛЬ emp1 (${SHEET_NAMES.timesheet})`, async () => {
    const res = await upsertTimesheetRow({
      date,
      objectId,
      employeeId: emp1.id,
      employeeName: emp1.name,
      hours: 8,
      source: "SMOKE",
      disciplineCoef: 1.0,
      productivityCoef: 1.0,
    });
    assertAction(res, ["created", "updated", "appended"], "upsertTimesheetRow(emp1)");
    return res;
  });

  await safeStep(`UPSERT(update): ТАБЕЛЬ emp1 (${SHEET_NAMES.timesheet})`, async () => {
    const res = await upsertTimesheetRow({
      date,
      objectId,
      employeeId: emp1.id,
      employeeName: emp1.name,
      hours: 7,
      source: "SMOKE",
      disciplineCoef: 1.0,
      productivityCoef: 1.2,
    });
    assertAction(res, ["updated"], "upsertTimesheetRow(emp1 update)");
    return res;
  });

  // другий рядок табеля (щоб ключі на employeeId працювали)
  await safeStep(`UPSERT(create/update): ТАБЕЛЬ emp2 (${SHEET_NAMES.timesheet})`, async () => {
    const res = await upsertTimesheetRow({
      date,
      objectId,
      employeeId: emp2.id,
      employeeName: emp2.name,
      hours: 4,
      source: "SMOKE",
      disciplineCoef: 1.0,
      productivityCoef: 1.0,
    });
    assertAction(res, ["created", "updated", "appended"], "upsertTimesheetRow(emp2)");
    return res;
  });

  console.log("\n--- ALLOWANCES: upsert (create + update) ---");

  await safeStep(`UPSERT(create/update): ДОПЛАТИ (${SHEET_NAMES.allowances})`, async () => {
    const res = await upsertAllowanceRow({
      date,
      objectId,
      foremanTgId,
      type: "ЛОГІСТИКА",
      employeeId: emp1.id,
      employeeName: emp1.name,
      amount: 100,
      meta: JSON.stringify({ note: "smoke 1" }),
      dayStatus: "ЧЕРНЕТКА",
    });
    assertAction(res, ["created", "updated"], "upsertAllowanceRow(create)");
    return res;
  });

  await safeStep(`UPSERT(update): ДОПЛАТИ (${SHEET_NAMES.allowances})`, async () => {
    const res = await upsertAllowanceRow({
      date,
      objectId,
      foremanTgId,
      type: "ЛОГІСТИКА",
      employeeId: emp1.id,
      employeeName: emp1.name,
      amount: 150,
      meta: JSON.stringify({ note: "smoke 2" }),
      dayStatus: "ЧЕРНЕТКА",
    });
    assertAction(res, ["updated"], "upsertAllowanceRow(update)");
    return res;
  });

  console.log("\n--- CLOSURES: upsert (create + update) ---");

  await safeStep(`UPSERT(create/update): ЗАКРИТТЯ (${SHEET_NAMES.closures})`, async () => {
    const res = await upsertClosure({
      date,
      objectId,
      foremanTgId,
      submittedAt: isoNow(),
      submittedBy: String(foremanTgId),
      comment: "SMOKE closure 1",
    });
    assertAction(res, ["created", "updated"], "upsertClosure(create)");
    return res;
  });

  await safeStep(`UPSERT(update): ЗАКРИТТЯ (${SHEET_NAMES.closures})`, async () => {
    const res = await upsertClosure({
      date,
      objectId,
      foremanTgId,
      submittedAt: isoNow(),
      submittedBy: String(foremanTgId),
      comment: "SMOKE closure 2 (updated)",
    });
    assertAction(res, ["updated"], "upsertClosure(update)");
    return res;
  });

  console.log("\n--- AUTH: role normalization (local test) ---");

  const roleCases: Array<[any, "ADMIN" | "BRIGADIER" | null]> = [
    ["Адмін", "ADMIN"],
    ["АДМІНІСТРАТОР", "ADMIN"],
    ["admin", "ADMIN"],
    ["Бригадир", "BRIGADIER"],
    ["brigadier", "BRIGADIER"],
    ["", null],
  ];

  for (const [input, expected] of roleCases) {
    const got = normalizeUserRole(input);
    if (got !== expected) {
      throw new Error(`normalizeUserRole("${input}") -> ${got}, expected ${expected}`);
    }
  }
  console.log("✅ role normalization: OK");

  console.log("\n✅ Smoke test v2 finished.");

  console.log("\n--- STAGE 4: TIMESHEET FROM EVENTS (TS_*) ---");

  function roundQuarter(h: number) {
    return Math.round(h * 4) / 4;
  }
  function addMinutes(iso: string, mins: number) {
    return new Date(new Date(iso).getTime() + mins * 60_000).toISOString();
  }

  // щоб не було проблем зі скоупом між safeStep'ами — тримаємо значення тут
  let tsStart = "";
  let tsEnd = "";
  let hours = 0;

  await safeStep(`APPEND: TS_START/TS_END events (${SHEET_NAMES.events})`, async () => {
    tsStart = isoNow();
    tsEnd = addMinutes(tsStart, 70); // 70 хв => 1.25 год після округлення

    hours = roundQuarter(70 / 60); // 1.25

    const tsStartEventId = makeEventId("TS");
    const tsEndEventId = makeEventId("TS");

    await appendEvents([
      {
        eventId: tsStartEventId,
        status: "АКТИВНА",
        ts: tsStart,
        date,
        foremanTgId,
        type: "TS_START",
        objectId,
        employeeIds: JSON.stringify([emp1.id, emp2.id]),
        payload: JSON.stringify({ kind: "SMOKE_TS", step: "START" }),
        chatId: 0,
        msgId: 0,
      },
      {
        eventId: tsEndEventId,
        status: "АКТИВНА",
        ts: tsEnd,
        date,
        foremanTgId,
        type: "TS_END",
        objectId,
        employeeIds: JSON.stringify([emp1.id, emp2.id]),
        payload: JSON.stringify({ kind: "SMOKE_TS", step: "END" }),
        chatId: 0,
        msgId: 0,
      },
    ]);

    return { tsStartEventId, tsEndEventId, tsStart, tsEnd, hours };
  });

  await safeStep(`UPSERT: TIMESHEET computed from TS_* (ТАБЕЛЬ)`, async () => {
    // 1) апсертаємо табель (як preview-генерація з подій)
    const r1 = await upsertTimesheetRow({
      date,
      objectId,
      employeeId: emp1.id,
      employeeName: emp1.name,
      hours,
      source: "EVENTS_TS",
      disciplineCoef: 1.0,
      productivityCoef: 1.0,
    });

    const r2 = await upsertTimesheetRow({
      date,
      objectId,
      employeeId: emp2.id,
      employeeName: emp2.name,
      hours,
      source: "EVENTS_TS",
      disciplineCoef: 1.0,
      productivityCoef: 1.0,
    });

    assertAction(r1, ["created", "updated", "appended"], "upsertTimesheetRow(from TS emp1)");
    assertAction(r2, ["created", "updated", "appended"], "upsertTimesheetRow(from TS emp2)");

    // 2) оновлюємо checklist і перевіряємо, що hasTimesheet стало true
    await refreshDayChecklist(date, objectId, foremanTgId);

    const ds = await getDayStatusRow(date, objectId, foremanTgId);
    if (!ds?.hasTimesheet) {
      throw new Error("dayStatus.hasTimesheet still false after refreshDayChecklist (stage4)");
    }

    // 3) перевірка округлення
    if (hours !== 1.25) {
      throw new Error(`rounding failed: expected 1.25, got ${hours}`);
    }

    return { tsStart, tsEnd, hours, hasTimesheet: ds.hasTimesheet };
  });


}

main().catch((err) => {
  console.error("\n❌ Smoke test v2 FAILED (unexpected)");
  console.error(err?.stack || err);
  process.exit(1);
});


