import type TelegramBot from "node-telegram-bot-api";

import { onStart, handleMessage, handleCallback } from "../src/bot/wizard.js";
import { TEXTS } from "../src/bot/texts.js";
import { cb, FLOW } from "../src/bot/flows/roadTimesheet.cb.js";
import { CB } from "../src/bot/core/cb.js";
import { ensureSession } from "../src/bot/core/session.js";
import { getFlowState } from "../src/bot/core/helpers.js";
import {
  fetchCars,
  fetchEmployees,
  fetchObjects,
  fetchUsers,
  fetchWorks,
} from "../src/google/sheets/dictionaries.js";
import { loadSheet, getCell } from "../src/google/sheets/core.js";
import { SHEET_NAMES } from "../src/google/sheets/names.js";
import {
  ALLOWANCES_HEADERS,
  EVENTS_HEADERS,
  ODOMETER_HEADERS,
  TIMESHEET_HEADERS,
} from "../src/google/sheets/headers.js";
import { fetchEvents } from "../src/google/sheets/working.js";

type FakeMessage = TelegramBot.Message & {
  reply_markup?: TelegramBot.SendMessageOptions["reply_markup"];
};

type SentMessage = {
  chatId: number;
  messageId: number;
  text: string;
  options?: any;
  kind: "message" | "photo";
};

type StepLabel =
  | "START"
  | "PICK_CAR"
  | "ODO_START"
  | "PICK_PEOPLE"
  | "PICK_OBJECTS"
  | "ADD_WORK"
  | "START_DRIVE"
  | "START_WORK"
  | "STOP_WORK"
  | "RETURN"
  | "ODO_END"
  | "SAVE"
  | "ADMIN_APPROVE"
  | "SHEETS_EVENTS"
  | "SHEETS_TIMESHEET"
  | "SHEETS_ODOMETER"
  | "SHEETS_ALLOWANCES";

class FakeTelegramBot {
  private nextMessageId = 1000;
  private listeners = new Map<string, Set<(msg: TelegramBot.Message) => unknown>>();

  public sent: SentMessage[] = [];
  public answers: any[] = [];

  async sendMessage(chatId: number, text: string, options?: TelegramBot.SendMessageOptions) {
    const msg = this.record(chatId, text, options, "message");
    return msg as TelegramBot.Message;
  }

  async editMessageText(text: string, options?: TelegramBot.EditMessageTextOptions) {
    const chatId = Number(options?.chat_id ?? 0);
    const messageId = Number(options?.message_id ?? 0);
    const found = this.sent.find((m) => m.chatId === chatId && m.messageId === messageId);
    if (found) {
      found.text = text;
      found.options = { ...(found.options ?? {}), ...(options ?? {}) };
    } else if (chatId > 0) {
      this.sent.push({ chatId, messageId, text, options, kind: "message" });
    }
    return true;
  }

  async editMessageReplyMarkup(replyMarkup: TelegramBot.InlineKeyboardMarkup, options?: TelegramBot.EditMessageReplyMarkupOptions) {
    const chatId = Number(options?.chat_id ?? 0);
    const messageId = Number(options?.message_id ?? 0);
    const found = this.sent.find((m) => m.chatId === chatId && m.messageId === messageId);
    if (found) {
      found.options = { ...(found.options ?? {}), reply_markup: replyMarkup };
    }
    return true;
  }

  async answerCallbackQuery(id: string, options?: TelegramBot.AnswerCallbackQueryOptions) {
    this.answers.push({ id, options });
    return true;
  }

  async sendPhoto(chatId: number, photo: string, options?: TelegramBot.SendPhotoOptions) {
    const text = String(options?.caption ?? `[photo:${photo}]`);
    const msg = this.record(chatId, text, options, "photo");
    return msg as TelegramBot.Message;
  }

  async getFileLink(fileId: string) {
    return `https://fake.telegram.local/${encodeURIComponent(fileId)}`;
  }

  async deleteMessage() {
    return true;
  }

  on(event: "message", listener: (msg: TelegramBot.Message) => unknown) {
    const set = this.listeners.get(event) ?? new Set();
    set.add(listener);
    this.listeners.set(event, set);
    return this as any;
  }

  removeListener(event: "message", listener: (msg: TelegramBot.Message) => unknown) {
    this.listeners.get(event)?.delete(listener);
    return this as any;
  }

  async emitMessage(msg: TelegramBot.Message) {
    const list = Array.from(this.listeners.get("message") ?? []);
    for (const listener of list) {
      await listener(msg);
    }
  }

  lastMessage(chatId: number) {
    const messages = this.sent.filter((m) => m.chatId === chatId);
    return messages[messages.length - 1];
  }

  findCallback(chatId: number, prefix: string) {
    for (const msg of [...this.sent].reverse()) {
      if (msg.chatId !== chatId) continue;
      const rows = (msg.options?.reply_markup as TelegramBot.InlineKeyboardMarkup | undefined)?.inline_keyboard ?? [];
      for (const row of rows) {
        for (const button of row) {
          const data = "callback_data" in button ? button.callback_data : undefined;
          if (data?.startsWith(prefix)) {
            return { data, messageId: msg.messageId };
          }
        }
      }
    }
    return null;
  }

  private record(chatId: number, text: string, options: any, kind: "message" | "photo") {
    const messageId = this.nextMessageId++;
    this.sent.push({ chatId, messageId, text, options, kind });
    return {
      message_id: messageId,
      date: Math.floor(Date.now() / 1000),
      chat: { id: chatId, type: "private" },
      text,
      reply_markup: options?.reply_markup,
    } as FakeMessage;
  }
}

const marks: StepLabel[] = [];

function pass(label: StepLabel) {
  marks.push(label);
  console.log(`✅ ${label}`);
}

function fail(message: string): never {
  console.error(`FAIL: ${message}`);
  throw new Error(message);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function hasTestMark(row: Record<string, unknown>) {
  return Object.values(row).some((v) => String(v ?? "").toUpperCase().includes("TEST"));
}

function isAdminRole(role: unknown) {
  const s = String(role ?? "").trim().toUpperCase();
  return s.includes("ADMIN") || s.includes("АДМІН");
}

function isForemanRole(role: unknown) {
  const s = String(role ?? "").trim().toUpperCase();
  return s.includes("BRIGADIER") || s.includes("БРИГАДИР");
}

function findTest<T extends Record<string, unknown>>(rows: T[]) {
  return rows.find((row) => hasTestMark(row));
}

function makeUserMessage(chatId: number, fromId: number, text: string): TelegramBot.Message {
  return {
    message_id: Date.now() % 100000,
    date: Math.floor(Date.now() / 1000),
    chat: { id: chatId, type: "private" },
    from: { id: fromId, is_bot: false, first_name: "TEST", username: "TEST_E2E" },
    text,
  } as TelegramBot.Message;
}

function makePhotoMessage(chatId: number, fromId: number, fileId: string): TelegramBot.Message {
  return {
    message_id: Date.now() % 100000,
    date: Math.floor(Date.now() / 1000),
    chat: { id: chatId, type: "private" },
    from: { id: fromId, is_bot: false, first_name: "TEST", username: "TEST_E2E" },
    photo: [{ file_id: fileId, file_unique_id: `${fileId}_U`, width: 1, height: 1 }],
  } as TelegramBot.Message;
}

function makeCallback(args: {
  chatId: number;
  fromId: number;
  messageId: number;
  data: string;
}): TelegramBot.CallbackQuery {
  return {
    id: `test-cb-${Date.now()}-${Math.random()}`,
    from: { id: args.fromId, is_bot: false, first_name: "TEST", username: "TEST_E2E" },
    message: {
      message_id: args.messageId,
      date: Math.floor(Date.now() / 1000),
      chat: { id: args.chatId, type: "private" },
    } as TelegramBot.Message,
    data: args.data,
  } as TelegramBot.CallbackQuery;
}

function stateOf(foremanTgId: number) {
  const session = ensureSession(foremanTgId);
  const root = getFlowState<Record<number, any>>(session, FLOW) ?? {};
  return root[foremanTgId];
}

async function readEventStatusUncached(eventId: string) {
  const sh = await loadSheet(SHEET_NAMES.events);
  const row = sh.data.find((r) => getCell(r, sh.map, EVENTS_HEADERS.eventId) === eventId);
  return row ? getCell(row, sh.map, EVENTS_HEADERS.status) : "";
}

async function verifyStep(foremanTgId: number, label: StepLabel, predicate: (st: any) => boolean, hint: string) {
  const st = stateOf(foremanTgId);
  if (!predicate(st)) {
    fail(`${label}: ${hint}. Поточний state: ${JSON.stringify({
      step: st?.step,
      phase: st?.phase,
      carId: st?.carId,
      inCarIds: st?.inCarIds,
      plannedObjectIds: st?.plannedObjectIds,
      arrivedObjectId: st?.arrivedObjectId,
    })}`);
  }
  pass(label);
}

async function main() {
  const users = await fetchUsers();
  const cars = await fetchCars();
  const employees = await fetchEmployees();
  const objects = await fetchObjects();
  const works = await fetchWorks();

  const envForemanId = Number(process.env.SMOKE_FOREMAN_TG_ID || process.env.E2E_FOREMAN_TG_ID || 0);
  const envAdminId = Number(process.env.E2E_ADMIN_TG_ID || 0);

  const foreman =
    users.find((u) => Number(u.tgId) === envForemanId && isForemanRole(u.role) && hasTestMark(u as any)) ??
    users.find((u) => isForemanRole(u.role) && hasTestMark(u as any));

  const admin =
    users.find((u) => Number(u.tgId) === envAdminId && isAdminRole(u.role) && hasTestMark(u as any)) ??
    users.find((u) => isAdminRole(u.role) && hasTestMark(u as any));

  const car = findTest(cars as any[]) as any;
  const employee = findTest(employees as any[]) as any;
  const object = findTest(objects as any[]) as any;
  const work = findTest(works.filter((w) => Number((w as any).tariff ?? 0) > 0) as any[]) as any;

  const missing: string[] = [];
  if (!foreman) missing.push("КОРИСТУВАЧІ: активний TEST_* BRIGADIER з роллю Бригадир/BRIGADIER");
  if (!admin) missing.push("КОРИСТУВАЧІ: активний TEST_* ADMIN з роллю Адміністратор/ADMIN");
  if (!car) missing.push("АВТО: активне TEST_* авто");
  if (!employee) missing.push("ПРАЦІВНИКИ: активний TEST_* працівник");
  if (!object) missing.push("ОБЄКТИ: активний TEST_* об'єкт");
  if (!work) missing.push("РОБОТИ: активна TEST_* робота зі ставкою > 0");

  if (missing.length) {
    fail(
      "Нема потрібних TEST_* записів у довідниках. Додай:\n" +
        missing.map((x) => `- ${x}`).join("\n") +
        "\nМаркер TEST має бути в ID/назві/ПІБ/USERNAME/коментарі відповідного рядка.",
    );
  }

  const foremanTgId = Number(foreman.tgId);
  const adminTgId = Number(admin.tgId);
  const bot = new FakeTelegramBot();

  const click = async (data: string, actorId = foremanTgId, chatId = foremanTgId, messageId?: number) => {
    const last = bot.lastMessage(chatId);
    await handleCallback(
      bot as any,
      makeCallback({
        chatId,
        fromId: actorId,
        messageId: messageId ?? last?.messageId ?? 1,
        data,
      }),
    );
  };

  const pendingText = async (text: string) => {
    await bot.emitMessage(makeUserMessage(foremanTgId, foremanTgId, text));
  };

  const pendingPhoto = async (fileId: string) => {
    await bot.emitMessage(makePhotoMessage(foremanTgId, foremanTgId, fileId));
  };

  await onStart(bot as any, makeUserMessage(foremanTgId, foremanTgId, "/start"));
  await click(CB.START_MENU);
  await handleMessage(bot as any, makeUserMessage(foremanTgId, foremanTgId, TEXTS.buttons.roadTimesheet));
  await verifyStep(foremanTgId, "START", (st) => st?.step === "START" && st?.phase === "SETUP", "не відкрився RoadTimesheetFlow");

  await click(cb.PICK_CAR);
  await click(`${cb.CAR}${car.id}`);
  await verifyStep(foremanTgId, "PICK_CAR", (st) => String(st?.carId) === String(car.id), "авто не вибрано");

  await click(cb.ASK_ODO_START_KM);
  await pendingText("1000");
  await click(cb.ASK_ODO_START_PHOTO);
  await pendingPhoto("TEST_ODO_START_PHOTO");
  await verifyStep(foremanTgId, "ODO_START", (st) => st?.odoStartKm === 1000 && String(st?.odoStartPhotoFileId).includes("TEST"), "ODO start або фото не прийняті");

  await click(cb.PICK_PEOPLE);
  await click(`${cb.EMP_TOGGLE}${employee.id}`);
  await click(cb.PEOPLE_DONE);
  await verifyStep(foremanTgId, "PICK_PEOPLE", (st) => st?.inCarIds?.includes(String(employee.id)), "працівника не додано в машину");

  await click(cb.PICK_OBJECTS);
  await click(`${cb.OBJ_TOGGLE}${object.id}`);
  await click(cb.OBJECTS_DONE);
  await verifyStep(foremanTgId, "PICK_OBJECTS", (st) => st?.plannedObjectIds?.includes(String(object.id)), "об'єкт не додано в план");

  await click(cb.PLAN_OBJECT_MENU);
  await click(`${cb.PLAN_OBJ}${object.id}`);
  await click(cb.PLAN_WORKS);
  const workCategory = bot.findCallback(foremanTgId, cb.PLAN_WORK_CAT);
  if (!workCategory) fail("ADD_WORK: не знайдено callback категорії робіт.");
  await click(workCategory.data, foremanTgId, foremanTgId, workCategory.messageId);
  await click(`${cb.PLAN_WORK}${work.id}`);
  await click(cb.PLAN_WORKS_DONE);
  await verifyStep(foremanTgId, "ADD_WORK", (st) => st?.objects?.[String(object.id)]?.works?.some((w: any) => String(w.workId) === String(work.id)), "роботу не додано до об'єкта");

  await click(cb.START_DAY);
  await verifyStep(foremanTgId, "START_DRIVE", (st) => st?.phase === "DRIVE_DAY" && st?.driveActive === true, "дорога не стартувала");

  await click(cb.PAUSE);
  await click(`${cb.ARRIVE_OBJ}${object.id}`);
  await click(cb.AT_OBJ_DROP_PICK);
  await click(cb.DROP_ALL);
  await click(cb.ARRIVE_CONFIRM);
  await click(cb.START_WORK_ON_OBJ);
  await verifyStep(foremanTgId, "START_WORK", (st) => st?.phase === "WORKING_AT_OBJECT" && st?.objects?.[String(object.id)]?.open?.length > 0, "роботу на об'єкті не стартовано");

  await sleep(1200);
  await click(`${cb.STOP_OBJ_WORK}${object.id}`);
  await click(`${cb.BULK_QTY_ADJ}${work.id}:1`);
  await click(cb.BULK_QTY_SAVE);
  await click(cb.BULK_COEF_DISC_SAVE);
  await click(cb.BULK_COEF_PROD_SAVE);
  await verifyStep(
    foremanTgId,
    "STOP_WORK",
    (st) =>
      st?.phase === "PAUSED_AT_OBJECT" &&
      st?.step === "AT_OBJECT_MENU" &&
      (st?.objects?.[String(object.id)]?.open ?? []).length === 0 &&
      !st?.pendingBulkQty,
    "роботи об'єкта не завершено через bulk stop",
  );

  await click(cb.FINISH_DAY);
  await click(cb.RETURN_PICK_OBJECT);
  await click(`${cb.RETURN_OBJ}${object.id}`);
  await click(cb.RETURN_DROP_ALL);
  await click(cb.START_RETURN);
  await click(cb.STOP_RETURN);
  await verifyStep(foremanTgId, "RETURN", (st) => st?.phase === "FINISHED" && st?.step === "ODO_END", "повернення не завершено");

  await click(cb.ASK_ODO_END_KM);
  await pendingText("1010");
  await click(cb.ASK_ODO_END_PHOTO);
  await pendingPhoto("TEST_ODO_END_PHOTO");
  await verifyStep(foremanTgId, "ODO_END", (st) => st?.odoEndKm === 1010 && st?.step === "SAVE", "ODO end або фото не прийняті");

  await click(cb.SAVE);
  const savedState = stateOf(foremanTgId);
  const eventId = String(savedState?.adminReviewEventId ?? "");
  if (!eventId) fail("SAVE: не створено adminReviewEventId.");
  pass("SAVE");

  const adminButton = bot.findCallback(adminTgId, cb.ADM_APPROVE);
  if (!adminButton) fail("ADMIN_APPROVE: адміну не надіслано кнопку approve.");
  await click(adminButton.data, adminTgId, adminTgId, adminButton.messageId);

  const approvedStatus = await readEventStatusUncached(eventId);
  if (approvedStatus !== "ЗАТВЕРДЖЕНО") {
    fail(`ADMIN_APPROVE: подія ${eventId} не затверджена, status=${approvedStatus || "null"}`);
  }
  pass("ADMIN_APPROVE");

  const eventRows = await fetchEvents({ date: savedState.date, foremanTgId });
  const hasRoadEnd = eventRows.some((e) => String(e.eventId) === eventId && e.type === "ROAD_END");
  const hasRtsSave = eventRows.some((e) => e.type === "RTS_SAVE" && String(e.carId) === String(car.id));
  if (!hasRoadEnd || !hasRtsSave) {
    fail("SHEETS_EVENTS: не знайдено ROAD_END/RTS_SAVE для TEST сценарію.");
  }
  pass("SHEETS_EVENTS");

  const timesheetSheet = await loadSheet(SHEET_NAMES.timesheet);
  const timesheetRow = timesheetSheet.data.find((row) =>
    getCell(row, timesheetSheet.map, TIMESHEET_HEADERS.date) === savedState.date &&
    getCell(row, timesheetSheet.map, TIMESHEET_HEADERS.objectId) === String(object.id) &&
    getCell(row, timesheetSheet.map, TIMESHEET_HEADERS.employeeId) === String(employee.id)
  );
  if (!timesheetRow) fail("SHEETS_TIMESHEET: не знайдено рядок табеля для TEST працівника/об'єкта.");
  pass("SHEETS_TIMESHEET");

  const odometerSheet = await loadSheet(SHEET_NAMES.odometerDay);
  const odometerRow = odometerSheet.data.find((row) =>
    getCell(row, odometerSheet.map, ODOMETER_HEADERS.date) === savedState.date &&
    getCell(row, odometerSheet.map, ODOMETER_HEADERS.carId) === String(car.id) &&
    Number(getCell(row, odometerSheet.map, ODOMETER_HEADERS.foremanTgId)) === foremanTgId
  );
  if (!odometerRow) fail("SHEETS_ODOMETER: не знайдено рядок одометра для TEST авто.");
  pass("SHEETS_ODOMETER");

  const allowancesSheet = await loadSheet(SHEET_NAMES.allowances);
  const allowanceRow = allowancesSheet.data.find((row) =>
    getCell(row, allowancesSheet.map, ALLOWANCES_HEADERS.date) === savedState.date &&
    getCell(row, allowancesSheet.map, ALLOWANCES_HEADERS.type) === "ROAD_TRIP" &&
    getCell(row, allowancesSheet.map, ALLOWANCES_HEADERS.employeeId) === String(employee.id) &&
    Number(getCell(row, allowancesSheet.map, ALLOWANCES_HEADERS.foremanTgId)) === foremanTgId
  );
  if (!allowanceRow) fail("SHEETS_ALLOWANCES: не знайдено ROAD_TRIP доплату для TEST працівника.");
  pass("SHEETS_ALLOWANCES");

  console.log(`PASS: RoadTimesheet hybrid E2E completed. eventId=${eventId}`);
}

main().catch((err) => {
  const done = new Set(marks);
  const all: StepLabel[] = [
    "START",
    "PICK_CAR",
    "ODO_START",
    "PICK_PEOPLE",
    "PICK_OBJECTS",
    "ADD_WORK",
    "START_DRIVE",
    "START_WORK",
    "STOP_WORK",
    "RETURN",
    "ODO_END",
    "SAVE",
    "ADMIN_APPROVE",
    "SHEETS_EVENTS",
    "SHEETS_TIMESHEET",
    "SHEETS_ODOMETER",
    "SHEETS_ALLOWANCES",
  ];

  for (const label of all) {
    if (!done.has(label)) console.error(`❌ ${label}`);
  }

  console.error(`FAIL DETAIL: ${err?.message ?? String(err)}`);
  process.exitCode = 1;
});
