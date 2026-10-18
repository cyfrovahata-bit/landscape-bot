import {
  pgTable,
  text,
  boolean,
  real,
  bigint,
  timestamp,
  integer,
  serial,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";

// Mirrors the Google Sheets structure used by the existing Telegram bot
// (see apps/bot/src/google/sheets/types.ts) so the sync worker can map
// 1:1 between sheet rows and DB rows.

// ---------- Dictionaries (full upsert on each sync cycle) ----------

export const users = pgTable("users", {
  tgId: bigint("tg_id", { mode: "bigint" }).primaryKey(),
  username: text("username"),
  pib: text("pib").notNull(),
  role: text("role").notNull(), // "БРИГАДИР" | "СТАРШИЙ" | "АДМІН"
  active: boolean("active").notNull().default(true),
  comment: text("comment"),
});

export const employees = pgTable("employees", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  brigadeId: text("brigade_id"),
  position: text("position"),
  active: boolean("active").notNull().default(true),
});

export const objects = pgTable("objects", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  address: text("address"),
  active: boolean("active").notNull().default(true),
});

export const works = pgTable("works", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  category: text("category"),
  // Optional second level under category -- null/empty means the work sits
  // directly in its category (see groupWorks on the client).
  subcategory: text("subcategory"),
  unit: text("unit"),
  tariff: real("tariff").notNull().default(0),
  active: boolean("active").notNull().default(true),
});

export const cars = pgTable("cars", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  plate: text("plate"),
  active: boolean("active").notNull().default(true),
});

export const logisticDirections = pgTable("logistic_directions", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  tariff: real("tariff").notNull().default(0),
  discountsByQty: text("discounts_by_qty"), // JSON: { "2": 50, "3": 100 }
  active: boolean("active").notNull().default(true),
});

export const materials = pgTable("materials", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  unit: text("unit").notNull(),
  active: boolean("active").notNull().default(true),
  category: text("category"),
  comment: text("comment"),
});

export const tools = pgTable("tools", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  active: boolean("active").notNull().default(true),
  category: text("category"),
  comment: text("comment"),
});

export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  comment: text("comment"),
});

// ---------- Working data (mirrors event/log sheets) ----------

export const events = pgTable(
  "events",
  {
    eventId: text("event_id").primaryKey(),
    status: text("status").notNull(), // АКТИВНА | ЗАТВЕРДЖЕНО | ПОВЕРНУТО | СКАСОВАНО
    refEventId: text("ref_event_id"),
    chatId: bigint("chat_id", { mode: "bigint" }),
    ts: timestamp("ts", { mode: "date" }).notNull(),
    date: text("date").notNull(), // YYYY-MM-DD
    foremanTgId: bigint("foreman_tg_id", { mode: "bigint" }).notNull(),
    type: text("type").notNull(),
    objectId: text("object_id"),
    carId: text("car_id"),
    employeeIds: text("employee_ids"), // JSON array
    payload: text("payload"), // JSON
    msgId: integer("msg_id"),
    updatedAt: timestamp("updated_at", { mode: "date" }).notNull().defaultNow(),
  },
  (t) => [index("events_date_type_idx").on(t.date, t.type), index("events_object_idx").on(t.objectId)],
);

export const reports = pgTable(
  "reports",
  {
    id: serial("id").primaryKey(),
    date: text("date").notNull(),
    objectId: text("object_id").notNull(),
    foremanTgId: bigint("foreman_tg_id", { mode: "bigint" }).notNull(),
    workId: text("work_id").notNull(),
    workName: text("work_name").notNull(),
    volume: text("volume"), // "", "?", or a number as string
    volumeStatus: text("volume_status").notNull(), // НЕ_ЗАПОВНЕНО | ЗАПОВНЕНО
    photos: text("photos"),
    dayStatus: text("day_status").notNull(),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date" }).notNull().defaultNow(),
  },
  (t) => [
    index("reports_date_object_idx").on(t.date, t.objectId),
    // Includes foremanTgId: two different brigades can legitimately both
    // report volumes for the same work on the same object on the same day,
    // and must not silently overwrite each other's numbers (see writers.ts).
    uniqueIndex("reports_date_object_work_foreman_uq").on(t.date, t.objectId, t.workId, t.foremanTgId),
  ],
);

export const timesheetEntries = pgTable(
  "timesheet_entries",
  {
    id: serial("id").primaryKey(),
    date: text("date").notNull(),
    objectId: text("object_id").notNull(),
    employeeId: text("employee_id").notNull(),
    employeeName: text("employee_name").notNull(),
    hours: real("hours").notNull(),
    source: text("source").notNull(),
    disciplineCoef: real("discipline_coef"),
    productivityCoef: real("productivity_coef"),
    updatedAt: timestamp("updated_at", { mode: "date" }).notNull().defaultNow(),
  },
  (t) => [
    index("timesheet_date_object_idx").on(t.date, t.objectId),
    uniqueIndex("timesheet_date_object_employee_uq").on(t.date, t.objectId, t.employeeId),
  ],
);

export const odometerDays = pgTable(
  "odometer_days",
  {
    id: serial("id").primaryKey(),
    date: text("date").notNull(),
    carId: text("car_id").notNull(),
    foremanTgId: bigint("foreman_tg_id", { mode: "bigint" }).notNull(),
    startValue: real("start_value"),
    startPhoto: text("start_photo"),
    endValue: real("end_value"),
    endPhoto: text("end_photo"),
    kmDay: real("km_day"),
    tripClass: text("trip_class"), // S | M | L | XL
    updatedAt: timestamp("updated_at", { mode: "date" }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("odometer_date_car_uq").on(t.date, t.carId)],
);

export const allowances = pgTable(
  "allowances",
  {
    id: serial("id").primaryKey(),
    date: text("date").notNull(),
    objectId: text("object_id").notNull().default(""),
    foremanTgId: bigint("foreman_tg_id", { mode: "bigint" }).notNull(),
    type: text("type").notNull(),
    employeeId: text("employee_id").notNull(),
    employeeName: text("employee_name").notNull(),
    amount: real("amount").notNull(),
    meta: text("meta"),
    dayStatus: text("day_status").notNull(),
    updatedAt: timestamp("updated_at", { mode: "date" }).notNull().defaultNow(),
  },
  (t) => [
    index("allowances_date_idx").on(t.date),
    // Mirrors the bot's upsert key exactly (apps/bot/.../working.ts upsertAllowanceRow):
    // date + foremanTgId + type + employeeId + objectId. objectId is "" (not null) for
    // trip-level allowances like ROAD_TRIP, so it's safe to include in a unique index.
    uniqueIndex("allowances_date_foreman_type_employee_object_uq").on(
      t.date,
      t.foremanTgId,
      t.type,
      t.employeeId,
      t.objectId,
    ),
  ],
);

export const dayStatuses = pgTable(
  "day_statuses",
  {
    id: serial("id").primaryKey(),
    date: text("date").notNull(),
    objectId: text("object_id").notNull(),
    foremanTgId: bigint("foreman_tg_id", { mode: "bigint" }).notNull(),
    status: text("status").notNull(),
    hasTimesheet: boolean("has_timesheet").notNull().default(false),
    hasReports: boolean("has_reports").notNull().default(false),
    hasReportsVolumeOk: boolean("has_reports_volume_ok").notNull().default(false),
    hasRoad: boolean("has_road").notNull().default(false),
    hasOdoStart: boolean("has_odo_start").notNull().default(false),
    hasOdoEnd: boolean("has_odo_end").notNull().default(false),
    hasOdoStartPhoto: boolean("has_odo_start_photo").notNull().default(false),
    hasOdoEndPhoto: boolean("has_odo_end_photo").notNull().default(false),
    hasLogistics: boolean("has_logistics").notNull().default(false),
    hasMaterials: boolean("has_materials").notNull().default(false),
    returnReason: text("return_reason"),
    approvedBy: text("approved_by"),
    approvedAt: timestamp("approved_at", { mode: "date" }),
    updatedAt: timestamp("updated_at", { mode: "date" }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("day_status_uq").on(t.date, t.objectId, t.foremanTgId)],
);

export const closures = pgTable(
  "closures",
  {
    id: serial("id").primaryKey(),
    date: text("date").notNull(),
    objectId: text("object_id").notNull(),
    foremanTgId: bigint("foreman_tg_id", { mode: "bigint" }).notNull(),
    submittedAt: timestamp("submitted_at", { mode: "date" }).notNull(),
    submittedBy: text("submitted_by").notNull(),
    comment: text("comment"),
  },
  (t) => [
    index("closures_date_object_idx").on(t.date, t.objectId),
    uniqueIndex("closures_date_object_uq").on(t.date, t.objectId),
  ],
);

export const materialMoves = pgTable(
  "material_moves",
  {
    moveId: text("move_id").primaryKey(),
    time: text("time").notNull(),
    date: text("date").notNull(),
    objectId: text("object_id").notNull(),
    foremanTgId: bigint("foreman_tg_id", { mode: "bigint" }).notNull(),
    materialId: text("material_id").notNull(),
    materialName: text("material_name").notNull(),
    qty: real("qty"),
    unit: text("unit").notNull(),
    moveType: text("move_type").notNull(), // ISSUE | RETURN | WRITEOFF | ADJUST
    purpose: text("purpose"),
    photos: text("photos"),
    payload: text("payload"),
    dayStatus: text("day_status"),
    updatedAt: timestamp("updated_at", { mode: "date" }).notNull().defaultNow(),
  },
  (t) => [index("material_moves_date_object_idx").on(t.date, t.objectId)],
);

export const toolMoves = pgTable(
  "tool_moves",
  {
    moveId: text("move_id").primaryKey(),
    time: text("time").notNull(),
    date: text("date").notNull(),
    foremanTgId: bigint("foreman_tg_id", { mode: "bigint" }).notNull(),
    toolId: text("tool_id").notNull(),
    toolName: text("tool_name").notNull(),
    qty: real("qty").notNull(),
    moveType: text("move_type").notNull(), // ISSUE | RETURN | BROKEN | LOST | FOUND | ADJUST
    purpose: text("purpose"),
    photos: text("photos"),
    payload: text("payload"),
    updatedAt: timestamp("updated_at", { mode: "date" }).notNull().defaultNow(),
  },
  (t) => [index("tool_moves_date_idx").on(t.date)],
);

// Tracks how far the Sheets -> DB sync worker has read each append-only
// sheet (e.g. the event journal), so it only fetches new rows each cycle.
export const syncCursors = pgTable("sync_cursors", {
  sheetName: text("sheet_name").primaryKey(),
  lastRow: integer("last_row").notNull().default(0),
  updatedAt: timestamp("updated_at", { mode: "date" }).notNull().defaultNow(),
});

/**
 * A trip set up in advance and parked for later.
 *
 * Lives ONLY here, not in Sheets: a plan is an intention the crew acts on
 * tomorrow morning, never something the accountant reads, and a sheet would
 * mean two-way sync for data with a lifetime of one night. (It is therefore
 * cleared by /internal/reset-working-data, which is fine -- a wiped plan costs
 * five minutes of re-picking, not money.)
 *
 * It moved off the phone's localStorage because a plan has to be visible to
 * OTHER brigadiers: the whole point of the badge in the car and people pickers
 * is that somebody else already spoke for that bus.
 *
 * Deliberately has no date. The owner's call: plans are for "the next trip",
 * not for a calendar day, so they simply sit until used or removed.
 */
export const tripPlans = pgTable(
  "trip_plans",
  {
    id: text("id").primaryKey(),
    // Whose plan it is -- the brigadier who will drive it, which is not
    // necessarily whoever typed it in (an admin can plan for someone).
    foremanTgId: bigint("foreman_tg_id", { mode: "bigint" }).notNull(),
    createdByTgId: bigint("created_by_tg_id", { mode: "bigint" }).notNull(),
    createdByName: text("created_by_name").notNull().default(""),
    // True when an admin planned this FOR the foreman: the plan then carries a
    // visible "запланував адміністратор" mark instead of passing as their own.
    assignedByAdmin: boolean("assigned_by_admin").notNull().default(false),
    carId: text("car_id").notNull().default(""),
    employeeIds: text("employee_ids").notNull().default("[]"), // JSON array
    objects: text("objects").notNull().default("[]"), // JSON: [{objectId, objectName, works: [...]}]
    note: text("note").notNull().default(""),
    status: text("status").notNull().default("АКТИВНИЙ"), // АКТИВНИЙ | ВИКОРИСТАНИЙ
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date" }).notNull().defaultNow(),
  },
  (t) => [index("trip_plans_foreman_idx").on(t.foremanTgId), index("trip_plans_status_idx").on(t.status)],
);

/**
 * The checkpoints of a brigade's day, as reported by the foreman's phone.
 *
 * The server learns nothing about a day until it is SUBMITTED -- the driving
 * timer, the object they are standing at and the running work sessions all
 * live in the phone's draft. So an admin watching the day could see that a car
 * had been taken and nothing more.
 *
 * APPEND-ONLY: one row per transition, so the admin reads a timeline (left at
 * 07:38, reached the object at 08:10, started work at 08:15) rather than a
 * single "where are they now" that says nothing about how the day went. The
 * writer skips a repeat of the last state, or simply reopening the app would
 * stamp a duplicate point.
 *
 * It is a REPORT, not a source of truth: nothing is computed from it and
 * payroll never reads it, so a phone out of signal leaves the admin's timeline
 * short, never the day wrong.
 */
export const tripProgress = pgTable("trip_progress", {
  id: text("id").primaryKey(),
  date: text("date").notNull(),
  foremanTgId: bigint("foreman_tg_id", { mode: "bigint" }).notNull(),
  // DRIVING | AT_OBJECT | WORKING | RETURNING | AT_BASE
  state: text("state").notNull(),
  objectName: text("object_name").notNull().default(""),
  peopleCount: integer("people_count").notNull().default(0),
  updatedAt: timestamp("updated_at", { mode: "date" }).notNull().defaultNow(),
});

/**
 * One row per day exported to БУХЗВІТ -- the idempotency keys that used to
 * live in the БУХЗВІТ_META sheet.
 *
 * The key identifies THIS state of a day's submission (date + foreman + the
 * trips' own eventIds), not just date+foreman: a day can be approved,
 * returned, resubmitted and approved again, and the corrected numbers must
 * reach the accountant instead of being skipped as "already done".
 *
 * This is the only thing standing between the accountant and a double-paid
 * day, so it must never be casually cleared -- see the note on reset-all.
 * The date/foreman columns are not used for matching; they are here so a
 * human (or a future "revoke approval") can find a day's export without
 * parsing the key.
 */
export const accountingExports = pgTable("accounting_exports", {
  key: text("key").primaryKey(),
  date: text("date").notNull().default(""),
  foremanTgId: bigint("foreman_tg_id", { mode: "bigint" }),
  rowsCount: integer("rows_count").notNull().default(0),
  createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
});

/**
 * Журнал дій у застосунку: хто, коли, на якому екрані і що натиснув.
 *
 * ТИМЧАСОВЕ, на час обкатки. Поставлено рівно тому, що кожне розслідування
 * впиралося в одне й те саме питання — «а що людина насправді натиснула?» — і
 * відповіді не було ніде: незданий день живе тільки в телефоні, а сервер бачив
 * лише підсумок. Тут видно послідовність, а не наслідок.
 *
 * APPEND-ONLY і суто діагностичне: нічого з нього не рахується, жоден екран
 * бригадира на нього не дивиться. Втрачений запис — це прогалина в розслідуванні,
 * ніколи не помилка в дні. Тому клієнт шле пачками і мовчки ковтає помилки:
 * телеметрія не має права зламати роботу.
 *
 * Чистити разом з рештою робочих даних (WORKING_DATA_TABLES), а перед
 * продакшном — прибрати цілком.
 */
export const uiActions = pgTable(
  "ui_actions",
  {
    id: text("id").primaryKey(),
    ts: timestamp("ts", { mode: "date" }).notNull(),
    tgId: bigint("tg_id", { mode: "bigint" }).notNull(),
    pib: text("pib").notNull().default(""),
    role: text("role").notNull().default(""),
    // Екран застосунку: menu / roadTimesheet / approval / ...
    screen: text("screen").notNull().default(""),
    // Крок усередині екрана, якщо він є: INDEX / HUB / AT_OBJECT / ...
    step: text("step").notNull().default(""),
    // click | screen | step | error
    kind: text("kind").notNull().default(""),
    // Видимий підпис кнопки або назва події -- саме те, що людина бачила
    label: text("label").notNull().default(""),
    detail: text("detail"),
    receivedAt: timestamp("received_at", { mode: "date" }).notNull().defaultNow(),
  },
  (t) => [index("ui_actions_ts_idx").on(t.ts), index("ui_actions_tg_idx").on(t.tgId)],
);

/**
 * Дзеркало незданого дня: те, що прямо зараз лежить у чернетці на телефоні.
 *
 * До цього сервер не знав про день НІЧОГО, доки той не був відправлений —
 * таймери, обʼєкти й години жили тільки в localStorage. Один день на цьому й
 * поламався: чернетка тримала вчорашню дату, на екрані адміна бригада то
 * зʼявлялась, то зникала, а перевірити було нічим — даних просто не існувало
 * поза телефоном.
 *
 * Телефон лишається робочою копією: він працює без звʼязку, і саме він
 * вирішує, що правда. Сюди він шле знімок після кожної зміни, з відставанням
 * у кілька секунд. Тобто це ДЗЕРКАЛО, а не джерело: сервер з нього нічого не
 * рахує, зарплату як і раніше визначає RTS_SAVE.
 *
 * Один рядок на бригадира: конструктор у застосунку один, тож і незавершений
 * день у людини рівно один.
 */
export const dayDrafts = pgTable("day_drafts", {
  foremanTgId: bigint("foreman_tg_id", { mode: "bigint" }).primaryKey(),
  // Дата, яку тримає сама чернетка. Може НЕ збігатися з сьогоднішньою — саме
  // так і виглядав той зламаний день, тож її видно окремою колонкою.
  date: text("date").notNull().default(""),
  step: text("step").notNull().default(""),
  carId: text("car_id").notNull().default(""),
  employeeIds: text("employee_ids").notNull().default("[]"),
  objectNames: text("object_names").notNull().default(""),
  tripStartedAt: timestamp("trip_started_at", { mode: "date" }),
  // Уся чернетка як є. Потрібна, щоб відновити день на новому телефоні, а не
  // лише подивитись на нього.
  payload: text("payload").notNull(),
  updatedAt: timestamp("updated_at", { mode: "date" }).notNull().defaultNow(),
});

// Revision survives deletion: an old tab cannot recreate a cleared version.
export const draftHeads = pgTable("draft_heads", {
  managed: boolean("managed").notNull().default(false),
  foremanTgId: bigint("foreman_tg_id", { mode: "bigint" }).primaryKey(),
  revision: integer("revision").notNull().default(0),
});
// Append-only recovery history, including rejected snapshots and pre-delete copies.
export const draftHistory = pgTable("draft_history", {
  id: serial("id").primaryKey(),
  foremanTgId: bigint("foreman_tg_id", { mode: "bigint" }).notNull(),
  revision: integer("revision").notNull(),
  action: text("action").notNull(),
  snapshot: text("snapshot").notNull(),
  createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
}, t => [index("draft_history_foreman_created_idx").on(t.foremanTgId, t.createdAt)]);

// Independent working copies. Legacy day_drafts/history remain for rollback.
export const tripDrafts = pgTable("trip_drafts", {
  id: text("id").primaryKey(),
  foremanTgId: bigint("foreman_tg_id", { mode: "bigint" }).notNull(),
  revision: integer("revision").notNull().default(0),
  state: text("state").notNull().default("open"),
  payload: text("payload").notNull(),
  updatedAt: timestamp("updated_at", { mode: "date" }).notNull().defaultNow(),
}, t => [index("trip_drafts_owner_idx").on(t.foremanTgId, t.updatedAt)]);
export const tripDraftHistory = pgTable("trip_draft_history", {
  id: serial("id").primaryKey(),
  tripId: text("trip_id").notNull(),
  foremanTgId: bigint("foreman_tg_id", { mode: "bigint" }).notNull(),
  revision: integer("revision").notNull(),
  action: text("action").notNull(),
  payload: text("payload").notNull(),
  createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
}, t => [index("trip_draft_history_trip_idx").on(t.tripId, t.id)]);

export const tripDraftOwners = pgTable("trip_draft_owners", {
  foremanTgId: bigint("foreman_tg_id", { mode: "bigint" }).primaryKey(),
  activeTripId: text("active_trip_id"),
  adoptedAt: timestamp("adopted_at", { mode: "date" }).notNull().defaultNow(),
});
