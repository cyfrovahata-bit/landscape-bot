import TelegramBot from "node-telegram-bot-api";
import { sendWelcome, showMainMenu } from "./ui.js";
import { TEXTS } from "./texts.js";
import { hydrateAuth } from "./core/auth.js";
import { fetchUsers, addUserToSheet, updateUserRow } from "../google/sheets/dictionaries.js";

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
  await showMainMenu(bot, chatId);
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

  const users = await fetchUsers();

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
      await showMainMenu(bot, chatId);
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
  const users = await fetchUsers();

  const index = users.findIndex((u: any) => Number(u.tgId) === Number(tgId));
  if (index === -1) return;

  const old = users[index] as any;
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

export async function handleCallback(bot: TelegramBot, q: TelegramBot.CallbackQuery) {


const chatId = q.message?.chat.id;
  if (!chatId) return;

  const actorTgId = q.from.id;

  try {
    await hydrateAuth(bot, chatId, actorTgId);
  } catch {
    return;
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

  if (action === "admin") {
    await updateUser(tgId, "Адміністратор", "Так");
  }

  if (action === "foreman") {
    await updateUser(tgId, "Бригадир", "Так");
  }

  if (action === "reject") {
    await updateUser(tgId, "Відхилено", "Ні");
  }

  await bot.editMessageText("✅ Оброблено", {
    chat_id: chatId,
    message_id: q.message?.message_id,
  });
}
