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
    uniqueIndex("reports_date_object_work_uq").on(t.date, t.objectId, t.workId),
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
    objectId: text("object_id"),
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
    uniqueIndex("allowances_date_employee_type_uq").on(t.date, t.employeeId, t.type),
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
