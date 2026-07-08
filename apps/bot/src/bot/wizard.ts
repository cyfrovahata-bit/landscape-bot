import TelegramBot from "node-telegram-bot-api";
import { sendAppWelcome } from "./ui.js";
import { TEXTS } from "./texts.js";
import { config } from "../config.js";
import { hydrateAuth } from "./core/auth.js";
import { fetchUsers, fetchAllUserRows, addUserToSheet, updateUserRow } from "../google/sheets/dictionaries.js";

import { CB } from "./core/cb.js";
import { ensureSession } from "./core/session.js";
import type { FlowModule } from "./core/flowTypes.js";
import { makeMenuMap, getModuleByFlow, routeByPrefix } from "./core/flowRegistry.js";

// flows
import { LogisticsFlow } from "./flows/logistics.flow.js";
//import { RoadFlow } from "./flows/road.flow.js";
//import { StubFlow } from "./flows/stub.flow.js";
//import { DayStatusFlow } from "./flows/dayStatus.flow.js";
//import { CloseDayFlow } from "./flows/closeDay.flow.js";
//import { PeopleTimesheetFlow } from "./flows/peopleTimesheet.flow.js";
//import { AddWorkFlow } from "./flows/addWork.flow.js";
import { MaterialsFlow } from "./flows/materials.flow.js";
import { ToolsFlow } from "./flows/tools.flow.js";
import { RoadTimesheetFlow } from "./flows/roadTimesheet.flow.js";
import { FLOW, PREFIX } from "../bot/flows/roadTimesheet.cb.js";
import { STATS_CB, openRoadStatsMenu } from "../bot/flows/roadTimesheet.stats.js";
import { getFlowState, setFlowState, todayISO } from "../bot/core/helpers.js";




/**
 * Register modules
 */
const FLOW_MODULES: FlowModule[] = [
  LogisticsFlow,
  MaterialsFlow,
  ToolsFlow,
  RoadTimesheetFlow,



];

const MENU_TEXT_TO_FLOW = makeMenuMap(FLOW_MODULES);

async function openMenu(bot: TelegramBot, chatId: number) {
  const s = ensureSession(chatId);
  s.mode = "MENU";
  delete s.flow;
  s.updatedAt = Date.now();
  await sendAppWelcome(bot, chatId);
}



async function notifyAdmins(bot: TelegramBot, user: TelegramBot.User) {
  const users = await fetchUsers();

  console.log("USERS:", users); // 👈 ДЕБАГ

  const admins = users.filter((u: any) => {
    const role = String(u.role ?? u["РОЛЬ"] ?? "").trim().toUpperCase();
    const active = String(u.active ?? u["АКТИВ"] ?? "").trim().toUpperCase();

    return (
      Number(u.tgId ?? u.TG_ID) > 0 &&
      (active === "ТАК" || active === "TRUE" || active === "1") &&
      (
        role === "АДМІНІСТРАТОР" ||
        role === "АДМІН" ||
        role === "ADMIN"
      )
    );
  });

  console.log("ADMINS FOUND:", admins); // 👈 ДЕБАГ

  const text =
    `🆕 Нова заявка\n\n` +
    `👤 ${user.first_name ?? ""} ${user.last_name ?? ""}\n` +
    `📛 @${user.username ?? "—"}\n` +
    `🆔 ${user.id}`;

for (const admin of admins) {
  const adminTgId = Number((admin as any).tgId ?? (admin as any).TG_ID);

  await bot.sendMessage(adminTgId, text, {
    reply_markup: {
      inline_keyboard: [
        [
          { text: "✅ Адмін", callback_data: `reg:admin:${user.id}` },
          { text: "👷 Бригадир", callback_data: `reg:foreman:${user.id}` },
        ],
        [
          { text: "❌ Відхилити", callback_data: `reg:reject:${user.id}` },
        ],
      ],
    },
  });
}
}

/**
 * Public API
 */
export async function onStart(bot: TelegramBot, msg: TelegramBot.Message) {
  const chatId = msg.chat.id;
  const user = msg.from;
  if (!user) return;

  const s = ensureSession(chatId);
  s.mode = "MENU";
  delete s.flow;
  s.updatedAt = Date.now();

  // fetchAllUserRows, not fetchUsers -- a pending applicant has АКТИВ="Ні"
  // and fetchUsers() filters those out entirely, so `me` would never be
  // found and every repeat /start tap while waiting re-added a duplicate
  // row and re-notified the admins from scratch.
  const users = await fetchAllUserRows();

  const me = users.find((u: any) => Number(u.tgId) === Number(user.id));

  // ✅ 1. Якщо вже є і активний — працює як зараз
  if (me) {
    const active = String(me.active ?? "").trim().toUpperCase();

    if (active === "ТАК" || active === "TRUE" || active === "1") {
      console.log("[BOT][START] keep existing session state", {
        chatId,
        tgId: user.id,
        hasFlows: Boolean((s as any).flows && Object.keys((s as any).flows).length),
      });
      await sendAppWelcome(bot, chatId);
      return;
    }

    // ⏳ Є але не активний
    await bot.sendMessage(
      chatId,
      "⏳ Ваша заявка вже подана. Очікуйте підтвердження адміністратора."
    );
    return;
  }

  // ❗️ 2. Новий користувач → додаємо в таблицю
await addUserToSheet([
  user.id,
  user.username ?? "",
  `${user.first_name ?? ""} ${user.last_name ?? ""}`.trim(),
  "Очікує",
  "Ні",
  "Заявка на доступ",
]);

  // 📩 3. Пишемо адміну
  await notifyAdmins(bot, user);

  await bot.sendMessage(
    chatId,
    "✅ Заявку на доступ відправлено адміністратору.\nОчікуйте підтвердження."
  );
}

async function updateUser(tgId: number, role: string, active: string) {
  // fetchAllUserRows, not fetchUsers -- the applicant being approved/
  // rejected here has АКТИВ="Ні" by definition (that's the whole point of
  // "pending"), and fetchUsers() filters out every inactive row. Using it
  // here meant this row could never be found at all: findIndex always
  // returned -1, no matter how correctly everything else was set up.
  const users = await fetchAllUserRows();

  const matches = users
    .map((u: any, index: number) => ({ u, index }))
    .filter(({ u }) => Number(u.tgId) === Number(tgId));
  // Throwing here (instead of silently returning) matters: this used to just
  // no-op if the applicant's row couldn't be found, which looked exactly
  // like "admin taps the button and nothing happens" -- no error, no
  // confirmation, the message just never changed.
  if (!matches.length) throw new Error(`Користувача з TG_ID=${tgId} не знайдено в КОРИСТУВАЧІ`);

  // Duplicate rows for the same tgId can exist (e.g. leftover from repeat
  // /start taps while pending, before onStart's own duplicate check was
  // fixed). The Sheets -> Postgres sync dedupes by tgId keeping whichever
  // row comes LAST in the sheet -- so updating only the first match would
  // leave a stale "Очікує/Ні" duplicate below it silently overriding this
  // approval once synced. Update every matching row so they all agree.
  for (const { u, index } of matches) {
    const old = u as any;
    const rowNumber = index + 2;
    await updateUserRow(rowNumber, [
      old.tgId,
      old.username ?? "",
      old.pib ?? old.name ?? "",
      role,
      active,
      role === "Відхилено" ? "Відхилено адміністратором" : "Підтверджено адміністратором",
    ]);
  }

  await triggerMiniAppSync();
}

// The Mini App reads users from Postgres, which only mirrors this Sheets
// update on the next scheduled sync (up to SYNC_INTERVAL_MS later) -- so
// without this, a freshly-approved brigadier hits "Access denied" in the
// Mini App for up to that whole interval. Best-effort: if the mini-app
// service is unreachable or PUBLIC_APP_URL isn't set, the scheduled sync
// still catches it eventually, so a failure here is never fatal.
async function triggerMiniAppSync() {
  if (!config.miniAppUrl) return;
  try {
    const res = await fetch(`${config.miniAppUrl}/internal/sync-now`, {
      method: "POST",
      headers: { "x-bot-token": config.botToken },
    });
    if (!res.ok) console.warn(`[BOT][SYNC_NOW] failed status=${res.status}`);
  } catch (e: any) {
    console.warn(`[BOT][SYNC_NOW] error: ${e?.message ?? String(e)}`);
  }
}

export async function handleCallback(bot: TelegramBot, q: TelegramBot.CallbackQuery) {


const chatId = q.message?.chat.id;
  if (!chatId) return;

  const actorTgId = q.from.id;

  try {
    await hydrateAuth(bot, chatId, actorTgId);
  } catch (e: any) {
    // hydrateAuth already messaged the user for these two expected cases --
    // anything else (e.g. a Google Sheets API hiccup) must NOT be swallowed
    // here, or the admin's tap on a registration button just silently does
    // nothing: no error, no confirmation, the callback query never even gets
    // answered. Rethrowing lets the outer handler (index.ts) show a proper
    // error/quota message and clear the button's loading state.
    if (e?.message === "ACCESS_DENIED" || e?.message === "BAD_ROLE") return;
    throw e;
  }

  const data = q.data || "";
  if (data.startsWith("reg:")) {
  return handleRegisterCallback(bot, q, data);
}

  bot.answerCallbackQuery(q.id).catch(() => {});

  const s = ensureSession(chatId);
  s.updatedAt = Date.now();

  // глобальні колбеки
  if (data === CB.START_MENU || data === CB.MENU) {
    return openMenu(bot, chatId);
  }

// ✅ NEW: глобальний перехід у флоу
if (data.startsWith(CB.OPEN_FLOW)) {
  const flow = data.slice(CB.OPEN_FLOW.length); // напр. "ROAD" або "ADD_WORK"

  const mod = getModuleByFlow(FLOW_MODULES, flow as any);
  if (!mod) return openMenu(bot, chatId);

  s.mode = "FLOW";
  s.flow = mod.flow;
  return mod.start(bot, chatId, s);
}
  
  // знайти модуль по префіксу
  const mod = routeByPrefix(FLOW_MODULES, data);
  if (mod) {
    const handled = await mod.onCallback(bot, q, s, data);
    if (handled) return;
  }
}

export async function handleMessage(bot: TelegramBot, msg: TelegramBot.Message) {
  const chatId = msg.chat.id;
  const actorTgId = msg.from?.id;
  if (!actorTgId) return;

  try {
    await hydrateAuth(bot, chatId, actorTgId);
  } catch {
    return;
  }

  const text = (msg.text || "").trim();
  const s = ensureSession(chatId);
  s.updatedAt = Date.now();

  if (!text) return;

  if (text.toLowerCase() === "меню") {
    await openMenu(bot, chatId);
    return;
  }

  // ✅ 1) STATS (один блок, без дубля)
  if (text === TEXTS.buttons.stats) {
    const foremanTgId = msg.from?.id ?? 0;

    // state RoadTimesheet — можна тримати тут, але НЕ перемикаємо s.flow
    let st = getFlowState<any>(s, FLOW);
    if (!st) {
      st = {
        step: "START",
        date: todayISO(),
        phase: "SETUP",
        plannedObjectIds: [],
        objects: {},
        inCarIds: [],
        members: [],
        driveActive: false,
        returnActive: false,
      };
      setFlowState(s, FLOW, st); 
    }

    await openRoadStatsMenu({
      bot,
      chatId,
      s,
      st,
      prefix: PREFIX,
      foremanTgId,
    });

    setFlowState(s, FLOW, st);
    return;
  }

  // ✅ 2) Глобальний перехід у flow з ReplyKeyboard
  const globalFlow = MENU_TEXT_TO_FLOW[text];
  if (globalFlow) {
    const mod = getModuleByFlow(FLOW_MODULES, globalFlow);
    if (!mod) {
      await openMenu(bot, chatId);
      return;
    }

    s.mode = "FLOW";
    s.flow = mod.flow;
    await mod.start(bot, chatId, s);
    return;
  }

  // ✅ 3) Якщо ми в MENU — запускаємо по тексту (можна навіть прибрати, бо глобFlow уже покриває)
  if (s.mode === "MENU") {
    return;
  }

  // ✅ 4) Якщо активний flow — дай йому шанс з'їсти текст
  if (s.flow) {
    const mod = getModuleByFlow(FLOW_MODULES, s.flow);
    if (mod?.onMessage) {
      const handled = await mod.onMessage(bot, msg, s);
      if (handled) return;
    }
  }
}
async function handleRegisterCallback(
  bot: TelegramBot,
  q: TelegramBot.CallbackQuery,
  data: string
) {
  const chatId = q.message?.chat.id;
  if (!chatId) return;

  const [, action, tgIdRaw] = data.split(":");
  const tgId = Number(tgIdRaw);

  try {
    if (action === "admin") {
      await updateUser(tgId, "Адміністратор", "Так");
    }

    if (action === "foreman") {
      await updateUser(tgId, "Бригадир", "Так");
    }

    if (action === "reject") {
      await updateUser(tgId, "Відхилено", "Ні");
    }

    await bot.answerCallbackQuery(q.id, { text: "✅ Оброблено" }).catch(() => {});
    await bot.editMessageText("✅ Оброблено", {
      chat_id: chatId,
      message_id: q.message?.message_id,
    });
  } catch (e: any) {
    // Never fail silently here -- a tap that visibly does nothing (no error,
    // no confirmation) is worse than an explicit failure the admin can act on
    // (retry, or check the КОРИСТУВАЧІ sheet for what went wrong).
    const reason = e?.message ?? String(e);
    await bot.answerCallbackQuery(q.id, { text: "❌ Помилка обробки", show_alert: true }).catch(() => {});
    await bot.sendMessage(chatId, `⚠️ Не вдалось обробити заявку (TG_ID=${tgId}).\nПричина: ${reason}`.slice(0, 3500)).catch(() => {});
  }
}
