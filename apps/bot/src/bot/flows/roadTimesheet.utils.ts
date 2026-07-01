// src/bot/flows/roadTimesheet.utils.ts
import type TelegramBot from "node-telegram-bot-api";
import { TEXTS } from "../texts.js";
import { getFlowState, setFlowState, todayISO } from "../core/helpers.js";
import { computeWorkMoneyFromRts } from "./roadTimesheet.compute.js";
import { buildRoadDayStats } from "./roadTimesheet.stats.data.js";



import type { PendingInput, OpenSession, ObjectTS, State, DictWork, AggRow, RtsType } from "./roadTimesheet.types.js";

import { fetchCars, fetchEmployees } from "../../google/sheets/index.js";
import { fetchObjects, fetchWorks, fetchUsers, getSettingNumber } from "../../google/sheets/dictionaries.js";

import { appendEvents, fetchEvents } from "../../google/sheets/working.js";
import { makeEventId, nowISO, classifyTripByKm  } from "../../google/sheets/utils.js";

import { loadSheet, getCell, requireHeaders } from "../../google/sheets/core.js";
import { SHEET_NAMES } from "../../google/sheets/names.js";

import {
  cb,
  FLOW,
  DEFAULT_ROAD_ALLOWANCE_BY_CLASS,
} from "./roadTimesheet.cb.js";

// -------------------- Markdown helpers --------------------

export function escMdV2(s: any) {
  return String(s ?? "").replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, "\\$1");
}
export function mdv2(s: any) {
  return escMdV2(s);
}

export function mdEscapeSimple(s: string) {
  return String(s).replace(/_/g, "\\_");
}

// -------------------- Common utils --------------------

export function now() {
  return new Date().toISOString();
}

export function uniq(arr: string[]) {
  return Array.from(new Set(arr));
}

export function fmtNum(n?: number) {
  if (n === undefined || Number.isNaN(n)) return TEXTS.ui.symbols.emptyDash;
  return String(n);
}

export function parseKm(text: string): number | undefined {
  const cleaned = String(text ?? "").trim().replace(",", ".");
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return undefined;
  if (n < 0) return undefined;
  return Math.round(n);
}

export function parseQty(text: string): number | undefined {
  const cleaned = String(text ?? "").trim().replace(",", ".");
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return undefined;
  if (n <= 0) return undefined;
  return Math.round(n * 100) / 100; // 2 знаки
}

export function fileIdFromPhoto(msg: TelegramBot.Message): string | undefined {
  const anyMsg = msg as any;

  const photos = anyMsg?.photo as Array<{ file_id: string }> | undefined;
  if (photos?.length) return photos[photos.length - 1]?.file_id;

  const doc = anyMsg?.document as { file_id?: string; mime_type?: string } | undefined;
  if (doc?.file_id && String(doc.mime_type || "").startsWith("image/")) return doc.file_id;

  return undefined;
}

export function openKey(s: OpenSession) {
  return `${s.employeeId}||${s.workId}||${s.objectId}`;
}

export function findOpen(obj: ObjectTS, employeeId: string, workId: string) {
  return obj.open.find((x) => x.employeeId === employeeId && x.workId === workId && x.objectId === obj.objectId);
}

type BulkQtyItem = NonNullable<State["pendingBulkQty"]>["items"][number];

export function buildBulkQtyItemsFromCurrentWorks(params: {
  st: State;
  oid: string;
  openSessions?: OpenSession[];
  savedItems?: Array<Partial<BulkQtyItem> & { workId?: string }>;
}) {
  const { st, oid, openSessions = [], savedItems = [] } = params;
  const obj = ensureObjectState(st, oid);

  const savedByWorkId = new Map<string, any>();
  for (const it of [
    ...savedItems,
    ...(st.pendingBulkQty?.objectId === oid ? st.pendingBulkQty.items ?? [] : []),
  ] as any[]) {
    const workId = String(it?.workId ?? "").trim();
    if (workId) savedByWorkId.set(workId, it);
  }

  const sessionAgg = new Map<
    string,
    { workId: string; workName: string; unit: string; rate: number; sessionsCount: number; sec: number }
  >();
  const endedAt = st.pendingBulkQty?.objectId === oid ? st.pendingBulkQty.endedAt : now();

  for (const s0 of openSessions) {
    const workId = String(s0.workId ?? "").trim();
    const startedAt = String(s0.startedAt ?? "").trim();
    if (!workId) continue;

    const sMs = Date.parse(startedAt);
    const eMs = Date.parse(endedAt);
    const sec =
      Number.isFinite(sMs) && Number.isFinite(eMs) && eMs >= sMs
        ? Math.floor((eMs - sMs) / 1000)
        : 0;

    const w = obj.works.find((x) => String(x.workId) === workId);
    const cur = sessionAgg.get(workId) ?? {
      workId,
      workName: String(w?.name ?? workId),
      unit: String(w?.unit ?? "од."),
      rate: Number(w?.rate ?? 0),
      sessionsCount: 0,
      sec: 0,
    };
    cur.sessionsCount += 1;
    cur.sec += sec;
    sessionAgg.set(workId, cur);
  }

  const currentWorks = (obj.works ?? [])
    .map((w: any) => ({
      workId: String(w.workId ?? "").trim(),
      workName: String(w.name ?? w.workId ?? "").trim(),
      unit: String(w.unit ?? "од.").trim(),
      rate: Number(w.rate ?? 0),
    }))
    .filter((w) => Boolean(w.workId));

  const baseWorks = currentWorks.length
    ? currentWorks
    : [...sessionAgg.values()].map((w) => ({
        workId: w.workId,
        workName: w.workName,
        unit: w.unit,
        rate: w.rate,
      }));

  return baseWorks.map((w) => {
    const saved: any = savedByWorkId.get(w.workId);
    const agg = sessionAgg.get(w.workId);

    return {
      workId: w.workId,
      workName: w.workName,
      unit: w.unit,
      rate: w.rate,
      sessionsCount: Number(agg?.sessionsCount ?? saved?.sessionsCount ?? 0),
      sec: Number(agg?.sec ?? saved?.sec ?? 0),
      qty: Number(saved?.qty ?? 0),
    };
  });
}


export async function startBulkQtyForObject(params: {
  bot: TelegramBot;
  chatId: number;
  msgId: number;
  date: string;
  foremanTgId: number;

  s: any;
  callbackQueryId?: string;

  st: State;
  oid: string;
  isReturnContext: boolean;
}) {
  const {
    bot,
    chatId,
    msgId,
    date,
    foremanTgId,
    s,
    callbackQueryId,
    st,
    oid,
    isReturnContext,
  } = params;

  const obj = ensureObjectState(st, oid);

  const openSessions = (obj.open ?? []).filter(
    (s0) => String(s0.objectId ?? oid) === String(oid),
  );

  const existingItems = st.pendingBulkQty?.objectId === oid ? st.pendingBulkQty.items : [];
  const items = buildBulkQtyItemsFromCurrentWorks({
    st,
    oid,
    openSessions,
    savedItems: existingItems,
  });

  if (!items.length) {
    if (callbackQueryId) {
      await bot
        .answerCallbackQuery(callbackQueryId, {
          text: "⚠️ Нема робіт для цього обʼєкта. Спочатку додай роботи.",
          show_alert: true,
        })
        .catch(() => {});
    }
    return false;
  }

  const endedAt = now();

  // 1) STOP qty=0
  for (const s0 of openSessions) {
    const employeeId = String(s0.employeeId ?? "").trim();
    const workId = String(s0.workId ?? "").trim();
    const startedAt = String(s0.startedAt ?? "").trim();
    if (!employeeId || !workId || !startedAt) continue;

    const w = obj.works.find((x) => String(x.workId) === workId);
    const workName = String(w?.name ?? workId);
    const unit = String(w?.unit ?? "од.");
    const rate = Number(w?.rate ?? 0);

    await writeEvent({
      bot,
      chatId,
      msgId,
      date,
      foremanTgId,
      carId: st.carId ?? "",
      objectId: oid,
      type: "RTS_OBJ_WORK_STOP",
      employeeIds: [employeeId],
      payload: {
        employeeId,
        workId,
        workName,
        unit,
        rate,
        qty: 0,
        amount: 0,
        startedAt,
        endedAt,
        reason: "BULK_STOP_PENDING_QTY",
      },
    });
  }

  // 2) close open
  const keysToClose = new Set(openSessions.map((x) => openKey(x)));
  obj.open = (obj.open ?? []).filter((x) => !keysToClose.has(openKey(x)));

  const rosterIds = uniq([
    ...(openSessions.map((x) => String(x.employeeId)).filter(Boolean)),
    ...((obj.leftOnObjectIds ?? []).map(String).filter(Boolean)),
  ]);

  st.pendingBulkQty = {
    objectId: oid,
    objectName: objectName(st, oid),
    endedAt,
    employeeIds: rosterIds,
    items,
    backStep: isReturnContext ? "RETURN_PICKUP_DROP" : "AT_OBJECT_MENU",
    afterSaveStep: isReturnContext ? "RETURN_PICKUP_DROP" : "AT_OBJECT_MENU",
  };

  st.qtyUnlocked = true;
  st.arrivedObjectId = oid;
  st.step = "BULK_QTY";

  const root = getFlowState<Record<number, State>>(s, FLOW) ?? {};
  root[foremanTgId] = st;
  setFlowState(s, FLOW, root);

  const scr = buildBulkQtyScreen(st, cb);
  await safeEditMessageText(bot, chatId, msgId, scr.text, {
    parse_mode: "Markdown",
    reply_markup: scr.kb,
  });

  return true;
}

export function ensureObjectState(st: State, objectId: string): ObjectTS {
  st.objects ??= {};
  if (!st.objects[objectId]) {
    st.objects[objectId] = {
      objectId,
      works: [],
      assigned: {},
      open: [],
      phase: "SETUP",
      coefDiscipline: {},
      coefProductivity: {},
      leftOnObjectIds: [],
    };
  }
  return st.objects[objectId];
}

export function objectName(st: State, objectId: string) {
  return st.objectsMeta?.find((o) => o.id === objectId)?.name ?? objectId;
}

export function hasOpenSessionForEmployeeOnObject(obj: any, employeeId: string) {
  const emp = String(employeeId);
  return (obj.open ?? []).some((s: any) => String(s.employeeId) === emp);
}

export function carName(st: State, carId?: string) {
  if (!carId) return TEXTS.ui.symbols.emptyDash;
  return st.carsMeta?.find((c) => c.id === carId)?.name ?? carId;
}

export function empName(st: State, id: string) {
  return st.employees?.find((e) => e.id === id)?.name ?? id;
}

export function joinEmpNames(st: State, ids?: string[]) {
  const list = (ids ?? []).map((id) => empName(st, id)).filter(Boolean);
  return list.length ? list.join(", ") : TEXTS.ui.symbols.emptyDash;
}

// локальна перевірка статусу (щоб не конфліктувати з core/helpers isLocked)
export function isLockedStatus(status?: string) {
  const s = String(status || "").toUpperCase();
  return s === "ЗДАНО" || s === "ЗАТВЕРДЖЕНО";
}

export function roundToQuarterHours(hours: number) {
  if (!Number.isFinite(hours)) return 0;
  // return Math.round(hours * 4) / 4; // 0.25 крок
  return 1;
}

// -------------------- Ensure meta (cars / employees / objects / works) --------------------

export async function ensureEmployees(st: State) {
  if (st.employees?.length) return;
  const emps = await fetchEmployees();
  st.employees = (emps ?? [])
    .slice(0, 80)
    .map((e: any) => ({
      id: String(e.id ?? e.ID ?? e.employeeId ?? e["ID"] ?? "").trim(),
      name: String(e.name ?? e.NAME ?? e["ІМ'Я"] ?? e["ІМ'Я"] ?? "").trim(),
      brigadeId: String(e.brigadeId ?? e.BRIGADE_ID ?? e["БРИГАДА_ID"] ?? "").trim(),
      position: String(e.position ?? e.POSITION ?? e["ПОСАДА"] ?? "").trim(),
      active: e.active,
    }))
    .filter((x: any) => x.id);
}

export async function ensureCarsMeta(st: State) {
  if (st.carsMeta?.length) return;
  const cars = await fetchCars();
  st.carsMeta = (cars ?? [])
    .slice(0, 80)
    .map((c: any) => ({
      id: String(c.id ?? c.ID ?? c.carId ?? c["ID"] ?? "").trim(),
      name: String(c.name ?? c.NAME ?? c.title ?? c["НАЗВА"] ?? c["НАЗВАНИЕ"] ?? "").trim(),
    }))
    .filter((x: any) => x.id);
}

export async function ensureObjectsMeta(st: State) {
  if (st.objectsMeta?.length) return;
  const objs = await fetchObjects();
  st.objectsMeta = (objs ?? [])
    .slice(0, 80)
    .map((o: any) => ({
      id: String(o.id ?? o.ID ?? o.objectId ?? o["ID"] ?? "").trim(),
      name: String(o.name ?? o.NAME ?? o.title ?? o["НАЗВА"] ?? o["НАЗВАНИЕ"] ?? "").trim(),
      address: String(o.address ?? o.ADDRESS ?? o["АДРЕСА"] ?? "").trim(),
      active: o.active,
    }))
    .filter((x: any) => x.id);
}

export function normWorksFull(raw: any[]): DictWork[] {
  return (raw ?? [])
    .map((w: any) => {
      const id = String(w.id ?? w.ID ?? w.workId ?? w["ID"] ?? "").trim();
      const name = String(w.name ?? w.NAME ?? w.title ?? w["НАЗВА"] ?? w["НАЗВАНИЕ"] ?? "").trim();
      const unit = String(w.unit ?? w.UNIT ?? w["ОДИНИЦЯ"] ?? w["ЕДИНИЦА"] ?? "").trim();
      const category = String(
  w.category ??
  w.CATEGORY ??
  w.categoryName ??
  w["КАТЕГОРІЯ"] ??
  ""
).trim();

      const rateRaw =
        w.rate ??
        w.RATE ??
        w.tariff ??
        w.TARIFF ??
        w["СТАВКА"] ??
        w["ТАРИФ"] ??
        w["TARIFF"];

      const rate = Number(String(rateRaw ?? "").replace(",", "."));
      const activeRaw = String(w.active ?? w.ACTIVE ?? w["АКТИВ"] ?? "TRUE").trim().toUpperCase();
      const active = activeRaw === "" || activeRaw === "TRUE" || activeRaw === "1" || activeRaw === "YES";

return {
  id,
  name: name || id,
  category: category || "Без категорії",
  unit: unit || "од.",
  rate: Number.isFinite(rate) ? rate : 0,
  active,
};
    })
    .filter((x) => x.id);
}

export async function ensureWorksMeta(st: State) {
  if (st.worksMeta?.length) return;
  const raw = (await fetchWorks()) as any[];
  st.worksMeta = normWorksFull(raw).filter((w) => w.active);

  // ✅ оновлюємо ставки в уже запланованих роботах
  const dict = st.worksMeta ?? [];
  for (const oid of Object.keys(st.objects ?? {})) {
    const obj = st.objects[oid];
    if (!obj?.works?.length) continue;

    for (const wi of obj.works) {
      const f = dict.find((w) => String(w.id) === String(wi.workId));
      if (!f) continue;

      if ((wi.rate ?? 0) <= 0) wi.rate = f.rate ?? 0;
      if (!wi.name) wi.name = f.name;
      if (!wi.unit) wi.unit = f.unit;
    }
  }
}

// -------------------- Pending input (message listener) --------------------

const pendingInputs = new Map<string, PendingInput>();

export function clearPending(chatId: number, fromId: number, bot?: TelegramBot) {
  const key = `${chatId}:${fromId}`;
  const p = pendingInputs.get(key);
  if (!p) return;
  clearTimeout(p.timer);
  if (bot) bot.removeListener("message", p.listener as any);
  pendingInputs.delete(key);
}

export async function askNextMessage(
  bot: TelegramBot,
  chatId: number,
  fromId: number,
  prompt: string,
  onNext: (msg: TelegramBot.Message) => Promise<void>,
  timeoutMs = 2200 * 60 * 1000,
  accept?: (msg: TelegramBot.Message) => boolean,
) {
  clearPending(chatId, fromId, bot);
  await bot.sendMessage(chatId, prompt);

  const key = `${chatId}:${fromId}`;

  const listener = async (msg: TelegramBot.Message) => {
    try {
      if (msg.chat?.id !== chatId) return;
      if (msg.from?.id !== fromId) return;
      if (typeof msg.text === "string" && msg.text.trim().startsWith("/")) return;

      if (accept && !accept(msg)) return;

      clearPending(chatId, fromId, bot);
      await onNext(msg);
    } catch (e) {
      clearPending(chatId, fromId, bot);
      await bot.sendMessage(chatId, `⚠️ Помилка: ${(e as Error)?.message ?? String(e)}`);
    }
  };

  const timer = setTimeout(() => {
    clearPending(chatId, fromId, bot);
    bot.sendMessage(chatId, TEXTS.ui.errors.timeout);
  }, timeoutMs);

  pendingInputs.set(key, { chatId, fromId, createdAt: Date.now(), timer, listener });
  bot.on("message", listener);
}

// -------------------- Screens / UI builders --------------------

export function fmtHhMm(secAny: any) {
  const sec = Number(secAny ?? 0);
  if (!Number.isFinite(sec) || sec <= 0) return "0г 0хв";
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return `${h}г ${m}хв`;
}

export async function sendLongHtml(
  bot: TelegramBot,
  chatId: number,
  text: string,
  opts?: Omit<TelegramBot.SendMessageOptions, "parse_mode">,
) {
  const MAX = 3800;
  const parts: string[] = [];

  let cur = "";
  for (const line of String(text).split("\n")) {
    if ((cur + "\n" + line).length > MAX) {
      parts.push(cur);
      cur = line;
    } else {
      cur = cur ? (cur + "\n" + line) : line;
    }
  }
  if (cur) parts.push(cur);

  for (let i = 0; i < parts.length; i++) {
    const isLast = i === parts.length - 1;

await bot.sendMessage(chatId, parts[i] ?? "", {
  ...opts,
  parse_mode: (opts as any)?.parse_mode ?? "Markdown",
  reply_markup: isLast ? (opts as any)?.reply_markup : undefined,
} as any);
  }
}

export async function ensureStateReady(st: State) {
  st.date ||= todayISO();
  st.phase ||= "SETUP";
  st.plannedObjectIds ||= [];
  st.objects ||= {};
  st.inCarIds ||= [];
  st.members ||= [];
  st.driveActive = !!st.driveActive;
  st.returnActive = !!st.returnActive;

  await ensureCarsMeta(st);
  await ensureEmployees(st);
  await ensureObjectsMeta(st);
  await ensureWorksMeta(st);
}



export async function sendStartScreen(bot: TelegramBot, chatId: number, st: State) {
  const date = st.date || todayISO();

  const carLine = st.carId
    ? `${TEXTS.roadFlow.labels.carOk} ${carName(st, st.carId)}`
    : TEXTS.roadFlow.labels.carNone;

  const odoStartLine =
    st.odoStartKm !== undefined || st.odoStartPhotoFileId
      ? `${TEXTS.roadFlow.labels.odoStartOk} ${fmtNum(st.odoStartKm)} км ${st.odoStartPhotoFileId ? "📷" : ""}`
      : TEXTS.roadFlow.labels.odoStartNone;

  const odoEndLine =
    st.odoEndKm !== undefined || st.odoEndPhotoFileId
      ? `${TEXTS.roadFlow.labels.odoEndOk} ${fmtNum(st.odoEndKm)} км ${st.odoEndPhotoFileId ? "📷" : ""}`
      : TEXTS.roadFlow.labels.odoEndNone;

  const plannedLine =
    `🏗 Обʼєкти: ${
      st.plannedObjectIds.length
        ? st.plannedObjectIds.map((id) => objectName(st, id)).join(", ")
        : TEXTS.ui.symbols.emptyDash
    }`;

  const inCarLine = `${TEXTS.roadFlow.labels.inCar} ${joinEmpNames(st, st.inCarIds)}`;

  const phaseLine =
    st.phase === "SETUP" ? "⚪ Підготовка"
    : st.phase === "DRIVE_DAY" ? "🟢 Рух"
    : st.phase === "PAUSED_AT_OBJECT" ? "⏸ Зупинка"
    : st.phase === "WORKING_AT_OBJECT" ? "🧱 Роботи на обʼєкті"
    : st.phase === "WAIT_RETURN" ? "🟡 Роботи завершено — повернення"
    : st.phase === "RETURN_DRIVE" ? "🌙 Повернення на базу"
    : "✅ Завершено";

  const rows: TelegramBot.InlineKeyboardButton[][] = [];

  rows.push([{ text: TEXTS.roadFlow.buttons.pickCar, callback_data: cb.PICK_CAR }]);
  rows.push([{ text: TEXTS.roadFlow.buttons.odoStart, callback_data: cb.ODO_START }]);
  rows.push([{ text: "👥 Люди", callback_data: cb.PICK_PEOPLE }]);
  rows.push([{ text: "🏗 Обʼєкти", callback_data: cb.PICK_OBJECTS }]);
  if (st.plannedObjectIds.length) {
    rows.push([{ text: "🧱 План робіт по обʼєктах", callback_data: cb.PLAN_OBJECT_MENU }]);
  }

  rows.push([{ text: TEXTS.common.backToMenu, callback_data: cb.MENU }]);

  await bot.sendMessage(
    chatId,
    `🛣 Робочий день\n\n` +
      `📅 ${date}\n\n` +
      `${phaseLine}\n` +
      `${carLine}\n` +
      `${odoStartLine}\n` +
      `${plannedLine}\n` +
      `${odoEndLine}\n` +
      `${inCarLine}\n\n` +
      `Підготовка: авто → показник спідометра → обʼєкти → план робіт → початок`,
    { reply_markup: { inline_keyboard: rows } }
  );
}

const queues = new Map<string, Promise<void>>();

function getDesc(err: any) {
  return (
    err?.response?.body?.description ??
    err?.body?.description ??  
    err?.description ??
    String(err)
  );
}

function isIgnorable(err: any) {
  const d = String(getDesc(err)).toLowerCase();
  return (
    d.includes("message is not modified") ||
    d.includes("query is too old") ||
    d.includes("message to edit not found") ||
    d.includes("can't be edited") ||
    d.includes("too many requests")
  );
}

async function queue(key: string, fn: () => Promise<void>) {
  const prev = queues.get(key) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(fn).catch(() => {});
  queues.set(key, next);
  next.finally(() => {
    if (queues.get(key) === next) queues.delete(key);
  });
  await next;
}

export async function safeEditMessageText(
  bot: TelegramBot,
  chatId: number,
  messageId: number,
  text: string,
  opts: Omit<TelegramBot.EditMessageTextOptions, "chat_id" | "message_id" | "text"> & {
    reply_markup?: TelegramBot.InlineKeyboardMarkup;
    parse_mode?: TelegramBot.ParseMode;
    disable_web_page_preview?: boolean;
  } = {},
) {
  const key = `${chatId}:${messageId}`;

  await queue(key, async () => {
    try {
      await bot.editMessageText(text, {
        chat_id: chatId,
        message_id: messageId,
        ...opts,
      });
    } catch (e: any) {
      if (!isIgnorable(e)) throw e;
    }
  });
}

export async function safeEditMessageReplyMarkup(
  bot: TelegramBot,
  chatId: number,
  messageId: number,
  reply_markup: TelegramBot.InlineKeyboardMarkup,
) {
  const key = `${chatId}:${messageId}`;

  await queue(key, async () => {
    try {
      await bot.editMessageReplyMarkup(reply_markup, {
        chat_id: chatId,
        message_id: messageId,
      });
    } catch (e: any) {
      if (!isIgnorable(e)) throw e;
    }
  });
}

export async function sendSaveScreen(
  bot: TelegramBot,
  chatId: number,
  foremanTgId: number,
  st: State,
  cb: any,
) {
  const date = st.date;

  await ensureCarsMeta(st);
  await ensureObjectsMeta(st);
  await ensureEmployees(st);

const sinceTs = st.driveStartedAt ?? st.members?.[0]?.joinedAt;

let aggAll = await computeFromRts({
  date,
  foremanTgId,
}).catch(() => []);

let roadAgg = await computeRoadSecondsFromRts({
  date,
  foremanTgId,
}).catch(() => []);

let workMoneyRows = await computeWorkMoneyFromRts({
  date,
  foremanTgId,
  ...(sinceTs ? { sinceTs } : {}),
}).catch(() => []);

if (sinceTs) {
  const sinceMs = Date.parse(String(sinceTs));

  if (Number.isFinite(sinceMs)) {
    aggAll = aggAll.filter((r: any) => {
      const ts = String(r.endedAt ?? r.startedAt ?? r.ts ?? "").trim();
      const ms = Date.parse(ts);
      return Number.isFinite(ms) ? ms >= sinceMs : true;
    });

    roadAgg = roadAgg.filter((r: any) => {
      const ts = String(r.endedAt ?? r.startedAt ?? r.ts ?? "").trim();
      const ms = Date.parse(ts);
      return Number.isFinite(ms) ? ms >= sinceMs : true;
    });
  }
}

  const kmDay = Math.max(
    0,
    Number(st.odoEndKm ?? 0) - Number(st.odoStartKm ?? 0),
  );
  const tripClass = classifyTripByKm(kmDay);

  const workTotalsByObj = new Map<
    string,
    { amount: number; qtyByUnit: Record<string, number> }
  >();

  for (const r of workMoneyRows) {
    const cur = workTotalsByObj.get(r.objectId) ?? {
      amount: 0,
      qtyByUnit: {},
    };
    cur.amount += Number(r.amount ?? 0);
    cur.qtyByUnit[r.unit] = (cur.qtyByUnit[r.unit] ?? 0) + Number(r.qty ?? 0);
    workTotalsByObj.set(r.objectId, cur);
  }

  const workGrandTotal = [...workTotalsByObj.values()].reduce(
    (a, v) => a + Number(v.amount ?? 0),
    0,
  );

  let roadTotalSec = roadAgg.reduce((a, r) => a + Number(r.sec ?? 0), 0);
  const roadSecByEmp = new Map(
    roadAgg.map((r) => [String(r.employeeId), Number(r.sec ?? 0)]),
  );

  const roadObjects = (st.plannedObjectIds ?? []).slice(0, 4);
  const roadObjCount = roadObjects.length || 0;

  const workSecByEmpObj = new Map<string, number>();
  const discByEmpObj = new Map<string, number>();
  const prodByEmpObj = new Map<string, number>();

  for (const r of aggAll) {
    const key = `${r.employeeId}||${r.objectId}`;
    workSecByEmpObj.set(key, (workSecByEmpObj.get(key) ?? 0) + Number(r.sec ?? 0));
    discByEmpObj.set(key, Number(r.disciplineCoef ?? 1.0));
    prodByEmpObj.set(key, Number(r.productivityCoef ?? 1.0));
  }

  const editAddedPeopleIds = ((st as any).editAddedPeopleIds ?? []).map(String);

const editRemovedPeopleIds = new Set(
  ((st as any).editRemovedPeopleIds ?? []).map(String),
);

for (const key of [...workSecByEmpObj.keys()]) {
  const [empId] = key.split("||");

  if (editRemovedPeopleIds.has(String(empId))) {
    workSecByEmpObj.delete(key);
    discByEmpObj.delete(key);
    prodByEmpObj.delete(key);
  }
}

for (const removedEmpId of editRemovedPeopleIds) {
  roadSecByEmp.delete(String(removedEmpId));
}

for (const newEmpId of editAddedPeopleIds) {
  for (const oid of st.plannedObjectIds ?? []) {
    const secs = [...workSecByEmpObj.entries()]
      .filter(([key]) => key.endsWith(`||${oid}`))
      .map(([, sec]) => Number(sec ?? 0))
      .filter((sec) => sec > 0);

    if (!secs.length) continue;

    const avgSec =
      secs.reduce((a, b) => a + b, 0) / secs.length;

    const key = `${newEmpId}||${oid}`;

    workSecByEmpObj.set(key, avgSec);
    discByEmpObj.set(key, 1.0);
    prodByEmpObj.set(key, 1.0);
  }

  const roadSecs = [...roadSecByEmp.values()]
    .map((x) => Number(x ?? 0))
    .filter((x) => x > 0);

  if (roadSecs.length) {
    const avgRoadSec =
      roadSecs.reduce((a, b) => a + b, 0) / roadSecs.length;

    roadSecByEmp.set(newEmpId, avgRoadSec);
  }
}

if ((st as any).editReturned) {
  workMoneyRows = workMoneyRows.filter(
    (r: any) =>
      !editRemovedPeopleIds.has(String(r.employeeId)),
  );

  const rebuiltWorkRows: any[] = [];

  for (const oid of st.plannedObjectIds ?? []) {
    const obj = ensureObjectState(st, oid);

    for (const w of obj.works ?? []) {
      const workId = String(w.workId ?? "");

      const rows = workMoneyRows.filter(
        (r: any) =>
          String(r.objectId) === String(oid) &&
          String(r.workId) === workId,
      );

      if (!rows.length) continue;

      const totalQty = rows.reduce(
        (a: number, r: any) => a + Number(r.qty ?? 0),
        0,
      );

      const totalAmount = rows.reduce(
        (a: number, r: any) => a + Number(r.amount ?? 0),
        0,
      );

      const people = uniq([
        ...rows.map((r: any) => String(r.employeeId)),
        ...editAddedPeopleIds,
      ])
        .filter(Boolean)
        .filter(
          (id) =>
            !editRemovedPeopleIds.has(String(id)),
        );

      if (!people.length) continue;

      const qtyPerPerson = totalQty / people.length;

      const amountPerPerson =
        totalAmount / people.length;

      const sample = rows[0];

      for (const empId of people) {
        rebuiltWorkRows.push({
          ...sample,
          employeeId: empId,
          qty: Math.round(qtyPerPerson * 100) / 100,
          amount:
            Math.round(amountPerPerson * 100) / 100,
          sec: Number(
            workSecByEmpObj.get(
              `${empId}||${oid}`,
            ) ?? sample.sec ?? 0,
          ),
        });
      }
    }
  }

  if (rebuiltWorkRows.length) {
    workMoneyRows = rebuiltWorkRows;
  }
}

roadTotalSec = [...roadSecByEmp.values()].reduce(
  (a, x) => a + Number(x ?? 0),
  0,
);

  const payrollPacks: any[] = [];

  const nameById = new Map(
    (st.employees ?? []).map((e) => [String(e.id), String(e.name)]),
  );

  for (const oid of st.plannedObjectIds ?? []) {
    const rowsMap = new Map<string, any>();

    for (const [k, sec] of workSecByEmpObj.entries()) {
      const [empId, objId] = k.split("||");
      if (!empId || !objId || objId !== oid) continue;

      const objState = ensureObjectState(st, oid);
      const d = Number(
        objState.coefDiscipline?.[empId] ??
          discByEmpObj.get(k) ??
          1.0,
      );
      const p = Number(
        objState.coefProductivity?.[empId] ??
          prodByEmpObj.get(k) ??
          1.0,
      );

      rowsMap.set(empId, {
        employeeId: empId,
        employeeName: nameById.get(String(empId)) ?? empId,
        hours: Number(sec ?? 0) / 3600,
        disciplineCoef: d,
        productivityCoef: p,
        coefTotal: d * p,
        points: 0,
      });
    }

    if (roadObjCount > 0 && roadObjects.includes(oid)) {
      for (const [empId, secRoad] of roadSecByEmp.entries()) {
        const addHours = Number(secRoad ?? 0) / 3600 / roadObjCount;
        const key = `${empId}||${oid}`;
        const objState = ensureObjectState(st, oid);

        const d = Number(
          objState.coefDiscipline?.[empId] ??
            discByEmpObj.get(key) ??
            1.0,
        );
        const p = Number(
          objState.coefProductivity?.[empId] ??
            prodByEmpObj.get(key) ??
            1.0,
        );

        const existing = rowsMap.get(empId);
        if (existing) {
          existing.hours += addHours;
          existing.disciplineCoef = d;
          existing.productivityCoef = p;
          existing.coefTotal = d * p;
        } else {
          rowsMap.set(empId, {
            employeeId: empId,
            employeeName: nameById.get(String(empId)) ?? empId,
            hours: addHours,
            disciplineCoef: d,
            productivityCoef: p,
            coefTotal: d * p,
            points: 0,
          });
        }
      }
    }

    const rows = [...rowsMap.values()]
      .map((r) => {
        const hoursRounded = roundToQuarterHours(Number(r.hours ?? 0));
        const coefTotal =
          Number(r.disciplineCoef ?? 1.0) * Number(r.productivityCoef ?? 1.0);
        const points = Math.round(hoursRounded * coefTotal * 100) / 100;
        return {
          ...r,
          hours: hoursRounded,
          coefTotal,
          points,
        };
      })
      .filter((r) => Number(r.hours ?? 0) > 0);

    payrollPacks.push({
      objectId: oid,
      objectName: objectName(st, oid),
      rows: rows.sort((a, b) =>
        String(a.employeeName).localeCompare(String(b.employeeName)),
      ),
    });
  }

  const riders = uniq([
  ...(st.members ?? []).map((m: any) =>
    String(m.employeeId),
  ),
  ...((st as any).editAddedPeopleIds ?? []).map(
    String,
  ),
  ...(st.inCarIds ?? []).map(String),
])
  .filter(Boolean)
  .filter(
    (id) =>
      !editRemovedPeopleIds.has(String(id)),
  );

  const amount =
    (await getSettingNumber(`ROAD_ALLOWANCE_${tripClass}`)) ??
    (DEFAULT_ROAD_ALLOWANCE_BY_CLASS as any)[tripClass];

  const perPerson = riders.length ? Number(amount ?? 0) / riders.length : 0;

  const workTotalsByObject = (st.plannedObjectIds ?? []).map((oid) => {
    const rows = workMoneyRows.filter((r) => String(r.objectId) === String(oid));
    const total = rows.reduce((a, r) => a + Number(r.amount ?? 0), 0);
    return {
      objectId: oid,
      objectName: objectName(st, oid),
      total,
    };
  });

  const salaryPacks = workTotalsByObject.map((o) => {
    const pack = payrollPacks.find(
      (p: any) => String(p.objectId) === String(o.objectId),
    );
    const rowsSrc = (pack?.rows ?? []) as any[];
    const sumPoints = rowsSrc.reduce(
      (a, r) => a + Number(r.points ?? 0),
      0,
    );

    const rows = rowsSrc.map((r) => {
      const points = Number(r.points ?? 0);
      const pay =
        sumPoints > 0 ? (Number(o.total ?? 0) * points) / sumPoints : 0;

      return {
        employeeId: String(r.employeeId ?? ""),
        employeeName: String(r.employeeName ?? ""),
        hours: Number(r.hours ?? 0),
        points,
        pay: Math.round(pay * 100) / 100,
      };
    });

    return {
      objectId: String(o.objectId),
      objectName: String(o.objectName),
      objectTotal: Math.round(Number(o.total ?? 0) * 100) / 100,
      sumPoints: Math.round(sumPoints * 100) / 100,
      rows: rows.filter((r) => (r.hours ?? 0) > 0 || (r.pay ?? 0) > 0),
    };
  });

const workedEmployeeIdsByObject: Record<string, string[]> = {};

for (const oid of st.plannedObjectIds ?? []) {
workedEmployeeIdsByObject[oid] = uniq(
  workMoneyRows
    .filter(
      (r: any) =>
        String(r.objectId) === String(oid),
    )
    .map((r: any) => String(r.employeeId))
    .filter(Boolean),
);
}

  const totalToPay = Number(workGrandTotal ?? 0) + Number(amount ?? 0);

  const fullPayload = {
    kmDay,
    tripClass,
    amount,
    perPerson,
    carName: carName(st, st.carId),
    objectsCount: (st.plannedObjectIds ?? []).length,
    objectsDetailed: (st.plannedObjectIds ?? []).map((oid) => ({
      objectId: oid,
      objectName: objectName(st, oid),
    })),
    workTotalsByObject,
    payrollPacks,
    salaryPacks,
    roadTotalSec,
    workGrandTotal,
    totalToPay,
    workMoneyRows,
    plannedObjectIds: st.plannedObjectIds ?? [],
    workedEmployeeIdsByObject,
    odoStartKm: st.odoStartKm,
    odoEndKm: st.odoEndKm,
    carId: st.carId,
    roadAgg: roadAgg.map((r) => ({
      employeeId: r.employeeId,
      employeeName: nameById.get(String(r.employeeId)) ?? r.employeeId,
      sec: r.sec,
    })),
    riders: riders.map((id) => ({
      id,
      name: nameById.get(String(id)) ?? id,
    })),
  };

  const previewText = buildRoadAdminTextFromEventPayload(
    {
      date,
      carId: st.carId ?? "",
      payload: JSON.stringify(fullPayload),
    },
    {
      hideMoney: true,
      showActions: false,
      title: "💾 *Перевір перед збереженням*",
    },
  );

  await sendLongHtml(bot, chatId, previewText, {
    disable_web_page_preview: true,
    reply_markup: {
      inline_keyboard: [
        [{ text: TEXTS.ui.buttons.save, callback_data: cb.SAVE }],
        [{ text: TEXTS.common.backToMenu, callback_data: cb.MENU }],
      ],
    } as any,
  });
}




export function buildBulkQtyScreen(st: any, cb: any) {
  const b = st.pendingBulkQty;
  if (!b) {
    return {
      text: "⚠️ Нема екрану обсягів.",
      kb: { inline_keyboard: [[{ text: "⬅️ Назад", callback_data: cb.BULK_QTY_BACK }]] },
    };
  }

  const items = (b.items ?? []).map((x: any) => ({
    workId: String(x.workId ?? "").trim(),
    workName: String(x.workName ?? x.workId ?? "").trim(),
    unit: String(x.unit ?? "од.").trim(),
    rate: Number(x.rate ?? 0),
    qty: Number(x.qty ?? 0),
    sessionsCount: Number(x.sessionsCount ?? 0),
    sec: Number(x.sec ?? 0),
  })).filter((x: any) => x.workId);

  const oid = String(b.objectId ?? "").trim();
  const obj = oid ? ensureObjectState(st, oid) : undefined;
  const currentWorkIds = (obj?.works ?? [])
    .map((w: any) => String(w.workId ?? "").trim())
    .filter(Boolean);
  console.log("[RTS][BULK_QTY_SCREEN]", {
    step: st.step,
    phase: st.phase,
    objectId: oid,
    selectedWorkIds: currentWorkIds,
    plannedWorkIds: currentWorkIds,
    workQtyMapKeys: items.map((it: any) => it.workId),
    sourceEventId: String(b.sourceEventId ?? b.payrollEventId ?? ""),
    afterAdminReturn: Boolean(
      (st as any).editByObject ||
        st.returnAfterPlanWorksStep ||
        String(b.backStep ?? "").startsWith("RETURN_EDIT") ||
        String(b.afterSaveStep ?? "").startsWith("RETURN_EDIT"),
    ),
    worksShown: items.length,
  });

  if (!items.length) {
    return {
      text: "⚠️ Нема робіт для введення обсягів.",
      kb: { inline_keyboard: [[{ text: "⬅️ Назад", callback_data: cb.BULK_QTY_BACK }]] },
    };
  }

  // ✅ активна робота (яку крутимо -10/-1/+1/+10)
  const firstUnfilled = items.find((x: any) => (x.qty ?? 0) <= 0);
  const activeWorkId =
    String(b.activeWorkId ?? "").trim() ||
    String(firstUnfilled?.workId ?? items[0].workId);

  b.activeWorkId = activeWorkId; // збережемо в state

  const active = items.find((x: any) => x.workId === activeWorkId) ?? items[0];

  const lines: string[] = [];
  lines.push(`✍️ *Обсяги робіт (об'єкт: ${mdEscapeSimple(String(b.objectName ?? "—"))})*`);
  lines.push(`Натискай кнопки -100/-10/-1/+1/+10/+100, щоб виставити обсяги робіт`);
  lines.push(`Потім натисни ✅ Зберегти.\n`);

  // ✅ список робіт з позначками заповнено/ні
  lines.push(`*Список робіт:*`);
  for (const it of items) {
    const filled = (it.qty ?? 0) > 0;
    const mark = filled ? "✅" : "▫️";
    const isActive = it.workId === activeWorkId ? " 👉" : "";
    const qtyLine = `Обсяг: *${it.qty}* ${it.unit}`;
    lines.push(`${mark} ${it.workName}${isActive}\n   ${qtyLine}`);
  }

  lines.push(`\n*Активна робота:* ${active.workName}`);
  if ((active.sessionsCount ?? 0) > 0 || (active.sec ?? 0) > 0) {
    lines.push(
      `Робіт: *${active.sessionsCount ?? 0}* | час: *${fmtHhMm((active.sec ?? 0))}*`,
    );
  }

  const kb: any[] = [];

  // ✅ кнопки вибору роботи (по 1 на рядок)
  for (const it of items.slice(0, 30)) {
    const filled = (it.qty ?? 0) > 0;
    const mark = filled ? "✅" : "▫️";
    const isActive = it.workId === activeWorkId ? "👉 " : "";
    kb.push([
      {
        text: `${isActive}${mark} ${it.workName}`.slice(0, 60),
        callback_data: `${cb.BULK_QTY_PICK}${it.workId}`,
      },
    ]);
  }

  // ✅ керування qty для АКТИВНОЇ роботи
kb.push([
  { text: "-100", callback_data: `${cb.BULK_QTY_ADJ}${active.workId}:-100` },
  { text: "-10", callback_data: `${cb.BULK_QTY_ADJ}${active.workId}:-10` },
  { text: "-1", callback_data: `${cb.BULK_QTY_ADJ}${active.workId}:-1` },
]);

kb.push([
  { text: `${active.qty}`, callback_data: "noop" },
]);

kb.push([
  { text: "+1", callback_data: `${cb.BULK_QTY_ADJ}${active.workId}:1` },
  { text: "+10", callback_data: `${cb.BULK_QTY_ADJ}${active.workId}:10` },
  { text: "+100", callback_data: `${cb.BULK_QTY_ADJ}${active.workId}:100` },
]);

  kb.push([{ text: "✅ Зберегти обсяги", callback_data: cb.BULK_QTY_SAVE }]);
  kb.push([{ text: "⬅️ Назад", callback_data: cb.BULK_QTY_BACK }]);

  return {
    text: lines.join("\n"),
    kb: { inline_keyboard: kb },
  };
}

// -------------------- Admin helpers --------------------

export function isAdminUserRole(role: string) {
  const r = String(role ?? "").toUpperCase();
  return r.includes("АДМІН") || r.includes("ADMIN");
}

export async function getAdminTgIds(): Promise<number[]> {
  const users = await fetchUsers();
  return (users ?? [])
    .map((u: any) => ({
      tgId: Number(u.tgId) || 0,
      role: String(u.role ?? ""),
      active: Boolean(u.active),
    }))
    .filter((u: any) => u.active && u.tgId > 0 && isAdminUserRole(u.role))
    .map((u: any) => u.tgId);
}

export async function isBrigadier(employeeId: string): Promise<boolean> {
  const sh = await loadSheet(SHEET_NAMES.employees);
  requireHeaders(sh.map, ["ID", "ПОСАДА", "АКТИВ"], SHEET_NAMES.employees);

  for (const r of sh.data) {
    const id = String(getCell(r, sh.map, "ID") ?? "").trim();
    if (id !== employeeId) continue;

    const activeRaw = String(getCell(r, sh.map, "АКТИВ") ?? "").trim().toUpperCase();
    const isActive = activeRaw === "" || activeRaw === "TRUE" || activeRaw === "1" || activeRaw === "YES";

    const pos = String(getCell(r, sh.map, "ПОСАДА") ?? "").toLowerCase();
    return isActive && pos.includes("бригадир");
  }

  return false;
}

export async function pickBrigadierFromPeople(peopleIds: string[]): Promise<string> {
  for (const id of peopleIds) {
    if (await isBrigadier(id)) return id;
  }
  return "";
}

export async function isSenior(employeeId: string): Promise<boolean> {
  const sh = await loadSheet(SHEET_NAMES.employees);
  requireHeaders(sh.map, ["ID", "ПОСАДА"], SHEET_NAMES.employees);

  for (const r of sh.data) {
    const id = String(getCell(r, sh.map, "ID") ?? "").trim();
    if (id !== employeeId) continue;

    const pos = String(getCell(r, sh.map, "ПОСАДА") ?? "").toLowerCase();
    return pos.includes("старший");
  }

  return false;
}

export function buildRoadAdminTextFromEventPayload(
  ev: any,
  opts?: { hideMoney?: boolean; showActions?: boolean; title?: string },
) {
  const hideMoney = !!opts?.hideMoney;
  const showActions = opts?.showActions !== false; // ✅ default true
  let payload: any = {};
  try {
    payload = ev.payload ? JSON.parse(String(ev.payload)) : {};
  } catch {}

  const esc = (s: any) => String(s ?? "").replace(/([_*`\[])/g, "\\$1");
  const fmt2 = (n: any) => (Number.isFinite(Number(n)) ? Number(n).toFixed(2) : "0.00");
  const uniqStr = (arr: any[]) => [...new Set(arr.map((x) => String(x)).filter(Boolean))];

  const lines: string[] = [];

  lines.push(opts?.title ? String(opts.title) : "🆕 *Робочий день на перевірку*");
  lines.push(`📅 Дата: ${esc(ev.date)}`);
  lines.push("");

const carTitle = String(payload.carName ?? "").trim();
lines.push(`🚗 Авто: ${carTitle ? esc(carTitle) : "—"}`);


  lines.push(`🔢 Показники спідометра: *${esc(payload.odoStartKm)}* → *${esc(payload.odoEndKm)}*`);
  lines.push(`📏 Км: *${esc(payload.kmDay)}*  |  🧩 Клас: *${esc(payload.tripClass)}*`);

  const roadTotalSec = Number(payload.roadTotalSec ?? 0);
  if (Number.isFinite(roadTotalSec) && roadTotalSec > 0) {
    const h = Math.floor(roadTotalSec / 3600);
    const m = Math.floor((roadTotalSec % 3600) / 60);
    lines.push(`⏱ Дорога (час): *${h}г ${m}хв*`);
  }

lines.push("");
if (!hideMoney) {
  lines.push(`🛣 Оплата за дорогу: *${esc(fmt2(payload.amount))}* | на людину: *${esc(fmt2(payload.perPerson))}*`);
  lines.push("");
}

const objectsDetailed = Array.isArray(payload.objectsDetailed) ? payload.objectsDetailed : [];
const objNameById = new Map<string, string>();

for (const o of objectsDetailed) {
  const id = String(o?.objectId ?? "").trim();
  const name = String(o?.objectName ?? "").trim();
  if (id && name) objNameById.set(id, name);
}
const plannedObjectIds = Array.isArray(payload.plannedObjectIds) ? payload.plannedObjectIds : [];

const plannedObjects =
  objectsDetailed.length
    ? objectsDetailed.map((o: any) => String(o.objectName ?? "").trim()).filter(Boolean)
    : [];

lines.push(`🏗 Обʼєкти: ${plannedObjects.length ? esc(plannedObjects.join(", ")) : "—"}`);
  lines.push("");

  

  const workMoneyRows = Array.isArray(payload.workMoneyRows) ? payload.workMoneyRows : [];
  const payrollPacks = Array.isArray(payload.payrollPacks) ? payload.payrollPacks : [];
  const workedEmployeeIdsByObject =
  payload && typeof payload.workedEmployeeIdsByObject === "object" && payload.workedEmployeeIdsByObject
    ? payload.workedEmployeeIdsByObject
    : {};

  // десь після "🏗 Обʼєкти:"
if (!payrollPacks.length) {
  const inCarNames = Array.isArray(payload.inCarNames) ? payload.inCarNames : [];

  const op = Array.isArray(payload.objectPeople) ? payload.objectPeople : [];
  for (const o of op) {
    const title = String(objNameById.get(String(o.objectId)) ?? "");
    const names = Array.isArray(o.employeeNames) ? o.employeeNames : [];
    lines.push(`🏗 ${esc(title || "—")}: ${names.length ? esc(names.join(", ")) : "—"}`);
  }
  lines.push("");
}

  if (workMoneyRows.length) {
    lines.push("🧱 *Роботи:*");

    const byObj = new Map<string, any[]>();
    for (const r of workMoneyRows) {
      const oid = String(r.objectId ?? "");
      if (!byObj.has(oid)) byObj.set(oid, []);
      byObj.get(oid)!.push(r);
    }

    
    const objNameById = new Map<string, string>();
for (const o of objectsDetailed) {
  const id = String(o?.objectId ?? "").trim();
  const name = String(o?.objectName ?? "").trim();
  if (id && name) objNameById.set(id, name);
}

    for (const [oid, rows] of byObj.entries()) {
const objTitle = objNameById.get(oid) || "";
      
if (!hideMoney) {
  const objTotal = rows.reduce((a, x) => a + Number(x.amount ?? 0), 0);
  lines.push(`\n🏗 *${esc(objTitle)}* | Всього по обʼєкту: *${esc(fmt2(objTotal))}*`);
} else {
  lines.push(`\n🏗 *${esc(objTitle || "—")}*`);
}

      const byWork = new Map<string, { workName: string; unit: string; rate: number; qty: number; amount: number; sec: number }>();
      for (const r of rows) {
        const key = String(r.workId ?? r.workName ?? "");
        const cur = byWork.get(key) ?? {
          workName: String(r.workName ?? r.workId ?? key),
          unit: String(r.unit ?? "од."),
          rate: Number(r.rate ?? 0),
          qty: 0,
          amount: 0,
          sec: 0,
        };
        cur.qty += Number(r.qty ?? 0);
        cur.amount += Number(r.amount ?? 0);
        cur.sec += Number(r.sec ?? 0);
        byWork.set(key, cur);
      }

      for (const w of byWork.values()) {
        const sec = w.sec ?? 0;
        const hh = Math.floor(sec / 3600);
        const mm = Math.floor((sec % 3600) / 60);
        const time = sec > 0 ? ` | ⏱ ${hh}г ${mm}хв` : "";

if (hideMoney) {
  lines.push(`• ${esc(w.workName)}: *${esc(fmt2(w.qty))} ${esc(w.unit)}*${time}`);
} else {
  lines.push(
    `• ${esc(w.workName)}: *${esc(fmt2(w.qty))} ${esc(w.unit)}* × ${esc(fmt2(w.rate))} = *${esc(fmt2(w.amount))}*${time}`,
  );
}
      }

const pack = payrollPacks.find((p: any) => String(p.objectId ?? "") === oid);

const workedIds = Array.isArray(workedEmployeeIdsByObject?.[oid])
  ? workedEmployeeIdsByObject[oid].map((x: any) => String(x))
  : [];

const rowsToShow = Array.isArray(pack?.rows)
  ? pack.rows.filter((r: any) =>
      workedIds.includes(String(r.employeeId ?? "")),
    )
  : [];

if (rowsToShow.length) {
  lines.push("👥 Люди (години/коеф/бали):");
  for (const r of rowsToShow) {
    lines.push(
      `• ${esc(r.employeeName)} | напрацьованих годин *${esc(fmt2(r.hours))}* | коефіцієнт *${esc(fmt2(r.disciplineCoef))}×${esc(fmt2(r.productivityCoef))}=${esc(fmt2(r.coefTotal))}* | Бали *${esc(fmt2(r.points))}*`,
    );
  }
}

 

    }

if (!hideMoney) {
  lines.push("");
  lines.push(`💰 *роботи: ${esc(fmt2(payload.workGrandTotal ?? 0))}*`);
}
  } else {
    lines.push("🧱 Роботи: —");
  }

lines.push("");
if (showActions) {
  lines.push("Дії: затвердити або повернути.");
}

  return lines.join("\n");
}

export function buildRoadApprovedShortText(
  ev: any,
  opts?: { title?: string },
) {
  let payload: any = {};
  try {
    payload = ev.payload ? JSON.parse(String(ev.payload)) : {};
  } catch {}

  const esc = (s: any) => String(s ?? "").replace(/([_*`\[])/g, "\\$1");
  const fmt2 = (n: any) =>
    Number.isFinite(Number(n)) ? Number(n).toFixed(2) : "0.00";

  const totalPeople = Array.isArray(payload.riders) ? payload.riders.length : 0;
  const workTotal = Number(payload.workGrandTotal ?? 0);
  const roadTotal = Number(payload.amount ?? 0);
  const roadPerPerson = totalPeople > 0 ? roadTotal / totalPeople : 0;
  const totalToPay = Number(payload.totalToPay ?? (workTotal + roadTotal));
  const carTitle = String(payload.carName ?? "").trim();

  const salaryPacks = Array.isArray(payload.salaryPacks)
    ? payload.salaryPacks
    : [];

  const roleTotals = {
    workers: 0,
    brigadiers: 0,
    seniors: 0,
    company: 0,
  };

  const brigadierIds = new Set(
    [
      ...(Array.isArray(payload.brigadierEmployeeIds)
        ? payload.brigadierEmployeeIds
        : []),
      payload.brigadierEmployeeId,
    ]
      .map((x) => String(x ?? "").trim())
      .filter(Boolean),
  );

  const seniorIds = new Set(
    [
      ...(Array.isArray(payload.seniorEmployeeIds)
        ? payload.seniorEmployeeIds
        : []),
      payload.seniorEmployeeId,
    ]
      .map((x) => String(x ?? "").trim())
      .filter(Boolean),
  );

for (const pack of salaryPacks) {
  const objectTotal = Number(pack.objectTotal ?? 0);
  const rows = Array.isArray(pack.rows) ? pack.rows : [];

  const hasBrigadier = rows.some((r: any) =>
    brigadierIds.has(String(r.employeeId ?? "").trim()),
  );

  const hasSenior = rows.some((r: any) =>
    seniorIds.has(String(r.employeeId ?? "").trim()),
  );

  if (hasBrigadier) {
    roleTotals.workers += objectTotal * 0.7;
    roleTotals.brigadiers += objectTotal * 0.2;

    if (hasSenior) {
      roleTotals.seniors += objectTotal * 0.1;
      roleTotals.company += 0;
    } else {
      roleTotals.company += objectTotal * 0.1;
    }
  } else if (hasSenior) {
    roleTotals.workers += objectTotal * 0.9;
    roleTotals.seniors += objectTotal * 0.1;
    roleTotals.company += 0;
  } else {
    roleTotals.workers += objectTotal * 0.9;
    roleTotals.company += objectTotal * 0.1;
  }
}

roleTotals.workers = Math.round(roleTotals.workers * 100) / 100;
roleTotals.brigadiers = Math.round(roleTotals.brigadiers * 100) / 100;
roleTotals.seniors = Math.round(roleTotals.seniors * 100) / 100;
roleTotals.company = Math.round(roleTotals.company * 100) / 100;

  const roleLines = [
    `👷 Працівники: *${esc(fmt2(roleTotals.workers))}*`,
    roleTotals.brigadiers > 0
      ? `👨‍🔧 Бригадири: *${esc(fmt2(roleTotals.brigadiers))}*`
      : "",
    roleTotals.seniors > 0
      ? `🌿 Старші садівники: *${esc(fmt2(roleTotals.seniors))}*`
      : "",
    `🏢 Фірма: *${esc(fmt2(roleTotals.company))}*`,
  ]
    .filter(Boolean)
    .join("\n");

  return [ 
    opts?.title ? String(opts.title) : "✅ *День затверджено*",
    `📅 Дата: ${esc(ev.date)}`,
    `🚗 Авто: ${carTitle ? esc(carTitle) : "—"}`,
    "",
    `📏 Км за день: *${esc(fmt2(payload.kmDay ?? 0))}*`,
    `👥 Людей: *${esc(totalPeople)}*`,
    "",
    `💼 Роботи: *${esc(fmt2(workTotal))}*`,
    `🛣 Дорога: *${esc(fmt2(roadTotal))}* (${esc(fmt2(roadPerPerson))}/люд)`,
    `💰 *Разом: ${esc(fmt2(totalToPay))}*`,
    "",
    `📊 *Розподіл по роботах:*`,
    roleLines,
  ].join("\n");
}


 
// -------------------- Events compute --------------------

export function csvToIds(csv: string): string[] {
  return String(csv ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

export async function computeFromRts(args: { date: string; foremanTgId: number; objectId?: string }) {
  const { date, foremanTgId, objectId } = args;

  const day = await buildRoadDayStats({ date, foremanTgId });

  const out: AggRow[] = [];

  for (const [employeeId, emp] of Object.entries(day.employees)) {
    for (const [objId, sec] of Object.entries(emp.secByObject)) {
      if (objectId && String(objId) !== String(objectId)) continue;

      out.push({
        objectId: objId,
        employeeId,
        sec: Number(sec ?? 0),
        disciplineCoef: 1,
        productivityCoef: 1,
      });
    }
  }

  out.sort((a, b) => `${a.objectId}:${a.employeeId}`.localeCompare(`${b.objectId}:${b.employeeId}`));
  return out;
}

export type RoadAgg = { employeeId: string; sec: number };

export async function computeRoadSecondsFromRts(args: { date: string; foremanTgId: number }) {
  const { date, foremanTgId } = args;

  const filter: any = {
    date,
    foremanTgId,
    types: [
      "RTS_DRIVE_START",
      "RTS_DRIVE_RESUME",
      "RTS_DRIVE_PAUSE",
      "RTS_DAY_FINISH",
      "RTS_RETURN_START",
      "RTS_RETURN_STOP",
      "RTS_PICK_UP",
      "RTS_DROP_OFF",
    ],
    status: "АКТИВНА",
  };

  const events = (await fetchEvents(filter)) as any[];
  events.sort((a, b) => String(a.ts ?? "").localeCompare(String(b.ts ?? "")));

  const driveSegments: Array<{ start: number; end: number }> = [];
  let driveOn: number | null = null;

  const returnSegments: Array<{ start: number; end: number }> = [];
  let retOn: number | null = null;

  for (const e of events) {
    const t = String(e.type ?? "");
    const ts = Date.parse(String(e.ts ?? ""));
    if (!Number.isFinite(ts)) continue;

    if (t === "RTS_DRIVE_START" || t === "RTS_DRIVE_RESUME") {
      if (driveOn === null) driveOn = ts;
      continue;
    }
    if (t === "RTS_DRIVE_PAUSE" || t === "RTS_DAY_FINISH") {
      if (driveOn !== null && ts >= driveOn) driveSegments.push({ start: driveOn, end: ts });
      driveOn = null;
      continue;
    }

    if (t === "RTS_RETURN_START") {
      if (retOn === null) retOn = ts;
      continue;
    }
    if (t === "RTS_RETURN_STOP") {
      if (retOn !== null && ts >= retOn) returnSegments.push({ start: retOn, end: ts });
      retOn = null;
      continue;
    }
  }

  const nowMs = Date.now();
  if (driveOn !== null) driveSegments.push({ start: driveOn, end: nowMs });
  if (retOn !== null) returnSegments.push({ start: retOn, end: nowMs });

  const segments = [...driveSegments, ...returnSegments];
  if (!segments.length) return [] as RoadAgg[];

  const inCar = new Map<string, number>(); // empId -> startMs
  const intervals: Array<{ empId: string; start: number; end: number }> = [];

  for (const e of events) {
    const t = String(e.type ?? "");
    const ts = Date.parse(String(e.ts ?? ""));
    if (!Number.isFinite(ts)) continue;

    let payload: any = {};
    try {
      payload = e.payload ? JSON.parse(String(e.payload)) : {};
    } catch {}

    const ids = csvToIds(String(e.employeeIds ?? ""));
    const empId = String(payload?.employeeId ?? ids[0] ?? "").trim();
    if (!empId) continue;

    if (t === "RTS_PICK_UP") {
      if (!inCar.has(empId)) inCar.set(empId, ts);
    }

    if (t === "RTS_DROP_OFF") {
      const a = inCar.get(empId);
      if (a !== undefined && ts >= a) intervals.push({ empId, start: a, end: ts });
      inCar.delete(empId);
    }
  }

  for (const [empId, a] of inCar.entries()) {
    if (nowMs >= a) intervals.push({ empId, start: a, end: nowMs });
  }

  const secByEmp = new Map<string, number>();

  const add = (empId: string, sec: number) => {
    secByEmp.set(empId, (secByEmp.get(empId) ?? 0) + sec);
  };

  const intersectSec = (a1: number, a2: number, b1: number, b2: number) => {
    const s = Math.max(a1, b1);
    const e = Math.min(a2, b2);
    return e > s ? Math.floor((e - s) / 1000) : 0;
  };

  for (const it of intervals) {
    for (const seg of segments) {
      add(it.empId, intersectSec(it.start, it.end, seg.start, seg.end));
    }
  }

  return [...secByEmp.entries()]
    .filter(([, sec]) => sec > 0)
    .map(([employeeId, sec]) => ({ employeeId, sec }))
    .sort((a, b) => a.employeeId.localeCompare(b.employeeId));
}

export async function fetchEventsSafe(date: string, foremanTgId: number) {
  try {
    return await (fetchEvents as any)({ date, foremanTgId });
  } catch {
    return await (fetchEvents as any)(date, foremanTgId);
  }
}


export async function findCarBusyByAnotherForeman(params: {
  date: string;
  carId: string;
  selfForemanTgId: number;
}) {
  const [evs, users] = await Promise.all([
    fetchEvents({
      date: params.date,
      foremanTgId: "" as any,
    }).catch(() => []),
    fetchUsers().catch(() => []),
  ]);

  const userNameByTgId = new Map(
    (users ?? []).map((u: any) => [
      Number(u.tgId ?? 0),
      String(
        u.fullName ||
        u.name ||
        u.firstName ||
        u.username ||
        `Бригадир ${u.tgId}`
      ),
    ]),
  );

  const rows = (evs ?? [])
    .filter((e: any) => String(e.carId ?? "") === String(params.carId))
    .filter(
      (e: any) =>
        Number(e.foremanTgId ?? 0) > 0 &&
        Number(e.foremanTgId ?? 0) !== Number(params.selfForemanTgId),
    )
    .sort((a: any, b: any) =>
      String(b.updatedAt ?? b.ts ?? "").localeCompare(
        String(a.updatedAt ?? a.ts ?? ""),
      ),
    );

  const latest = rows[0];
  if (!latest) return null;

  const latestType = String(latest.type ?? "");

  const FREE_TYPES = new Set([
    "RTS_RETURN_STOP",
    "RTS_ODO_END",
    "RTS_ODO_END_PHOTO",
    "ROAD_END",
    "RTS_SAVE",
  ]);

  if (FREE_TYPES.has(latestType)) {
    return null;
  }

  return {
    foremanTgId: Number(latest.foremanTgId ?? 0),
    foremanName:
      userNameByTgId.get(Number(latest.foremanTgId ?? 0)) ||
      `Бригадир ${latest.foremanTgId}`,
  };
}
export function buildBusyCarsMap(params: {
  evs: any[];
  users: any[];
  selfForemanTgId: number;
}) {
  const userNameByTgId = new Map(
    (params.users ?? []).map((u: any) => [
      Number(u.tgId ?? 0),
      String(
        u.fullName ||
        u.name ||
        u.firstName ||
        u.username ||
        `Бригадир ${u.tgId}`
      ),
    ]),
  );

  const grouped = new Map<string, any[]>();

  for (const e of params.evs ?? []) {
    const carId = String(e.carId ?? "").trim();
    if (!carId) continue;

    if (!grouped.has(carId)) grouped.set(carId, []);
    grouped.get(carId)!.push(e);
  }

  const FREE_TYPES = new Set([
    "RTS_RETURN_STOP",
    "RTS_ODO_END",
    "RTS_ODO_END_PHOTO",
    "ROAD_END",
    "RTS_SAVE",
  ]);

  const busyByCarId = new Map<
    string,
    { foremanTgId: number; foremanName: string }
  >();

  for (const [carId, events] of grouped.entries()) {
    const rows = (events ?? [])
      .filter(
        (e: any) =>
          Number(e.foremanTgId ?? 0) > 0 &&
          Number(e.foremanTgId ?? 0) !== Number(params.selfForemanTgId),
      )
      .sort((a: any, b: any) =>
        String(b.updatedAt ?? b.ts ?? "").localeCompare(
          String(a.updatedAt ?? a.ts ?? ""),
        ),
      );

    const latest = rows[0];
    if (!latest) continue;

    const latestType = String(latest.type ?? "");
    if (FREE_TYPES.has(latestType)) continue;

    const foremanTgId = Number(latest.foremanTgId ?? 0);

    busyByCarId.set(carId, {
      foremanTgId,
      foremanName:
        userNameByTgId.get(foremanTgId) || `Бригадир ${foremanTgId}`,
    });
  }

  return busyByCarId;
}

export function buildBusyEmployeesMap(params: {
  evs: any[];
  users: any[];
  selfForemanTgId: number;
}) {
  const userNameByTgId = new Map(
    (params.users ?? []).map((u: any) => [
      Number(u.tgId ?? 0),
      String(
        u.fullName ||
        u.name ||
        u.firstName ||
        u.username ||
        `Бригадир ${u.tgId}`
      ),
    ]),
  );

  const grouped = new Map<string, any[]>();

  for (const e of params.evs ?? []) {
    const employeeIds = String(e.employeeIds ?? "")
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);

    for (const employeeId of employeeIds) {
      if (!grouped.has(employeeId)) grouped.set(employeeId, []);
      grouped.get(employeeId)!.push(e);
    }
  }

  const FREE_TYPES = new Set([
    "RTS_DROP_OFF",
    "ROAD_END",
    "RTS_SAVE",
  ]);

  const busyByEmployeeId = new Map<
    string,
    { foremanTgId: number; foremanName: string }
  >();

  for (const [employeeId, events] of grouped.entries()) {
    const rows = (events ?? [])
      .filter(
        (e: any) =>
          Number(e.foremanTgId ?? 0) > 0 &&
          Number(e.foremanTgId ?? 0) !== Number(params.selfForemanTgId),
      )
      .sort((a: any, b: any) =>
        String(b.updatedAt ?? b.ts ?? "").localeCompare(
          String(a.updatedAt ?? a.ts ?? ""),
        ),
      );

    const latest = rows[0];
    if (!latest) continue;

    const latestType = String(latest.type ?? "");
    if (FREE_TYPES.has(latestType)) continue;

    const foremanTgId = Number(latest.foremanTgId ?? 0);

    busyByEmployeeId.set(employeeId, {
      foremanTgId,
      foremanName:
        userNameByTgId.get(foremanTgId) || `Бригадир ${foremanTgId}`,
    });
  }

  return busyByEmployeeId;
}

export async function findEmployeeBusyByAnotherForeman(params: {
  date: string;
  employeeId: string;
  selfForemanTgId: number;
}) {
  const [evs, users] = await Promise.all([
    fetchEvents({
      date: params.date,
      foremanTgId: "" as any,
    }).catch(() => []),
    fetchUsers().catch(() => []),
  ]);

  const busyByEmployeeId = buildBusyEmployeesMap({
    evs,
    users,
    selfForemanTgId: params.selfForemanTgId,
  });

  return busyByEmployeeId.get(String(params.employeeId)) ?? null;
}

export function parsePayload(x: any) {
  try {
    if (!x) return {};
    if (typeof x === "object") return x;
    return JSON.parse(String(x));
  } catch {
    return {};
  }
}

// -------------------- Events writer (RTS_*) --------------------

export async function writeEvent(args: {
  bot: TelegramBot;
  chatId: number;
  msgId: number;
  date: string;
  foremanTgId: number;
  objectId?: string;
  carId?: string;
  type: RtsType;
  employeeIds?: string[];
  payload?: any;
  // optional lock checker (in flow ти вже маєш getDayStatusRow)
  isLocked?: (status?: string) => boolean;
  getDayStatusRow?: (date: string, objectId: string, foremanTgId: number) => Promise<{ status?: string } | null>;
}) {
  if (args.objectId && args.getDayStatusRow && args.isLocked) {
    const ds = await args.getDayStatusRow(args.date, args.objectId, args.foremanTgId);
    if (args.isLocked(ds?.status)) {
      await args.bot.sendMessage(args.chatId, `🔒 День уже ${ds?.status}. Редагування недоступне.`);
      return null;
    }
  }

  const evId = makeEventId("RTS");
  const t = nowISO();

  await appendEvents([
    {
      eventId: evId,
      status: "АКТИВНА",
      ts: t,
      date: args.date,
      foremanTgId: args.foremanTgId,
      type: args.type,
      objectId: args.objectId ?? "",
      carId: args.carId ?? "",
      employeeIds: (args.employeeIds ?? []).join(","),
      payload: args.payload ? JSON.stringify(args.payload) : "",
      chatId: args.chatId,
      msgId: args.msgId,
      refEventId: "",
      updatedAt: t,
    } as any,
  ]);

  return evId;
}
