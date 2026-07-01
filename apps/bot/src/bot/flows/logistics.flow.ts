import type TelegramBot from "node-telegram-bot-api";
import { TEXTS } from "../texts.js";

import type { FlowModule, FlowBaseState } from "../core/flowTypes.js";
import { CB } from "../core/cb.js";
import { clearFlowState, getFlowState, setFlowState, todayISO, upsertInline } from "../core/helpers.js";

import { fetchEmployees, upsertEvent, makeEventId } from "../../google/sheets.js";

import { getEventById, updateEventById } from "../../google/sheets/working.js";
import { fetchLogistics, fetchUsers } from "../../google/sheets/dictionaries.js";

type LogisticsStep =
  | "PICK_DEST"      // вибір напрямку з довідника ЛОГІСТИКА
  | "ENTER_QTY"      // вибір/ввід к-сті об'єктів
  | "EMP_PICK"       // вибір людей
  | "REVIEW"
//  | "MAT_PICK" 
  | "EDIT_PICK_ITEM" 
  | "EDIT_ACTION";

type LogisticsItem = {
  logisticId: string;      // ID з листа ЛОГІСТИКА (L_001...)
  logisticName: string;    // НАЗВА
  tariff: number;          // СТАВКА
  qty: number;             // к-сть об'єктів
  employeeIds: string[];   // люди
  materialIds: string[];
};

type LogisticsState = FlowBaseState & {
  step: LogisticsStep;

  logistics: { id: string; name: string; tariff: number; discountsByQty: Record<number, number> }[];
  employees: { id: string; name: string }[];
//  materials: { id: string; name: string; unit?: string }[];

  // ✅ береться з листа "КОРИСТУВАЧІ" (TG_ID, РОЛЬ, АКТИВ, ...)
  users: { tgId: number; role: string; active: boolean }[];

current?: {
  logisticId?: string;
  qty?: number;
  employeeIds: string[];
  materialIds: string[];
  awaitingQtyText?: boolean;
};

    adminReturn?: {
    awaitingReason?: boolean;
    eventId?: string;
    adminMsgChatId?: number;
    adminMsgId?: number;
    foremanChatId?: number;
  };


  items: LogisticsItem[];

  editing?: { itemIndex?: number };

  lock?: { locked: boolean; objectId?: string; status?: string };
};

function escMdV2(s: any) {
  return String(s ?? "").replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, "\\$1");
}

function mdv2(s: any) {
  return escMdV2(s);
}

function buildLogisticsMoneyTextFromEventPayload(ev: any) {
  const payload = JSON.parse(ev.payload || "{}");
  const items = payload.items ?? [];
  const employeesDict = payload.employees ?? [];
  const logisticsDict = payload.logistics ?? [];
//  const materialsDict = payload.materials ?? []; 

  const lines: string[] = [];
  lines.push("🆕 *Логістика на перевірку*");
  lines.push(`📅 Дата: ${ev.date}`);
  lines.push("");

  let grandTotal = 0;

  for (const it of items) {
    const names = (it.employeeIds ?? [])
      .map((id: string) => employeesDict.find((e: any) => e.id === id)?.name)
      .filter(Boolean)
      .join(", ");

//    const mats = (it.materialIds ?? [])
//      .map((id: string) => materialsDict.find((m: any) => m.id === id)?.name)
//      .filter(Boolean)
//      .join(", ");

    const total = calcItemTotal(it, { logistics: logisticsDict } as any);
    grandTotal += total;

    const perPerson =
      it.employeeIds?.length ? Math.round((total / it.employeeIds.length) * 100) / 100 : 0;

    lines.push(
      `*${it.logisticName}*\n` +
        `🏗 К-сть обʼєктів: ${it.qty}\n` +
        `👥 ${names || "—"}\n` +
//        `🧱 Матеріали: ${mats || "—"}\n` +          // ✅ додали
        `💰 Сума: ${total}\n` +
        `➗ На людину: ${perPerson}`
    );
    lines.push("");
  }

  lines.push(`💰 *Всього:* ${grandTotal}`);
  return lines.join("\n");
}


function isBrigadier(s: any) {
  const raw =
    s?.role ??
    s?.user?.role ??
    s?.profile?.role ??
    s?.profile?.position ??
    s?.userRole ??
    "";

  const role = String(raw).toUpperCase().trim();

  // ловимо варіанти типу "👷 БРИГАДИР", "БРИГАДИР (...)"
  // isBrigadier()
if (role.includes("БРИГ")) return true;
if (role.includes("FOREMAN")) return true;

  // якщо у тебе десь є явний прапорець
  if (s?.isBrigadier === true || s?.isForeman === true) return true;

  return false;
}

// ✅ правильне визначення бригадира через лист "КОРИСТУВАЧІ"
function isBrigadierByTgId(lg: LogisticsState, tgId?: number) {
  if (!tgId) return false;

  const u = lg.users?.find((x) => Number(x.tgId) === Number(tgId));
  if (!u || !u.active) return false;

  const role = String(u.role ?? "").toUpperCase().trim();
  // isBrigadierByTgId()
return role.includes("БРИГ") || role.includes("BRIG") || role.includes("FOREMAN");
}

function isAdminByTgId(lg: LogisticsState, tgId?: number) {
  if (!tgId) return false;

  const u = lg.users?.find((x) => Number(x.tgId) === Number(tgId));
  if (!u || !u.active) return false;

  const role = String(u.role ?? "").toUpperCase().trim();
  return role.includes("АДМІН") || role.includes("ADMIN");
}

function getAdminTgIds(lg: LogisticsState) {
  return (lg.users ?? [])
    .filter((u) => u.active && (String(u.role ?? "").toUpperCase().includes("АДМІН") || String(u.role ?? "").toUpperCase().includes("ADMIN")))
    .map((u) => Number(u.tgId))
    .filter((id) => Number.isFinite(id) && id > 0);
}


function normalizeStatus(raw?: string) {
  return String(raw ?? "")
    .toUpperCase()
    .replace(/[✅🟡🔴🟢⚪️]/g, "")   // прибираємо емодзі-мітки
    .replace(/\s+/g, " ")
    .trim();
}

function canSeeMoneyForBrigadier(dayStatus?: string) {
  const st = normalizeStatus(dayStatus);
  // бригадир бачить гроші ТІЛЬКИ після "ЗАТВЕРДЖЕНО"
  return st === "ЗАТВЕРДЖЕНО";
}

function isLocked(status?: string) {
  const st = normalizeStatus(status);
  return st === "ЗДАНО" || st === "ЗАТВЕРДЖЕНО";
}

async function ensureNotLockedForLogisticsSave(args: {
  bot: TelegramBot;
  chatId: number;
  date: string;
  foremanTgId: number;
  actionLabel: string;
}) {
  // Логістика в тебе не прив’язана до objectId конкретного об’єкта.
  // Але ти просив блокування після ЗДАНО/ЗАТВЕРДЖЕНО.
  // Якщо хочеш — можна перевіряти “по всіх об’єктах дня”, але тут нема objectId.
  // Тому я залишив guard лише на SAVE як "якщо десь вже ЗДАНО — блокуємо" НЕ МОЖУ зробити без objectId.
  // Зараз: guard тільки формально “ок”.
  return { ok: true as const };
}

function calcItemTotal(it: LogisticsItem, lg: LogisticsState) {
  const tariff = Number(it.tariff) || 0;
  const qty = Number(it.qty) || 0;

  const dest = lg.logistics.find((x) => x.id === it.logisticId);
  const disc = dest?.discountsByQty?.[qty] ?? 0;
  const hintDiscount = disc > 0 ? `\n🏷 Знижка за ${qty}: -${disc}` : "";

  return Math.max(0, tariff * qty - (Number(disc) || 0));
}

function uniq<T>(arr: T[]) {
  return Array.from(new Set(arr));
}

// ✅ додали userTgId щоб визначати роль через q.from.id / msg.from.id
async function render(bot: TelegramBot, chatId: number, s: any, userTgId?: number) {
  const lg0 = getFlowState<LogisticsState>(s, "LOGISTICS");
  if (!lg0) return;

  // ✅ backward compatible: якщо старий стейт без users
  const lg: LogisticsState = {
    ...lg0,
    users: Array.isArray((lg0 as any).users) ? (lg0 as any).users : [],
  };

  // якщо доповнили users — збережемо назад (щоб далі не губилось)
  if ((lg0 as any).users !== lg.users) setFlowState(s, "LOGISTICS", lg);

  const dayStatus =
    lg.lock?.status ??
    s?.dayStatus?.status ??
    s?.dayStatus ??
    s?.lock?.status;

  // ✅ головне правило:
  // - бригадира визначаємо через users + tgId
  // - якщо users порожній або tgId не передали, fallback на isBrigadier(s)
  const isBrigFromUsers = isBrigadierByTgId(lg, userTgId);
  const isBrigFallback = isBrigadier(s);
  const isBrig = isBrigFromUsers || (lg.users.length === 0 ? isBrigFallback : false);

  const showMoney = isBrig ? canSeeMoneyForBrigadier(dayStatus) : true;

  // 1) ВИБІР НАПРЯМКУ (без повторів)
  if (lg.step === "PICK_DEST") {
    const picked = new Set(lg.items.map((it) => it.logisticId));

    // не показуємо вже додані напрямки
    const options = lg.logistics.filter((x) => !picked.has(x.id));

    const rows: TelegramBot.InlineKeyboardButton[][] = [];

    if (!options.length) {
      rows.push([{ text: "✅ Перевірити", callback_data: "lg:review" }]);
    } else {
      for (const o of options) {
        rows.push([{
          text: showMoney ? `${o.name} (${o.tariff})` : `${o.name}`,
          callback_data: `lg:dest:${o.id}`
        }]);
      }
      if (lg.items.length) rows.push([{ text: "✅ Перевірити", callback_data: "lg:review" }]);
    }

    rows.push([{ text: TEXTS.common.backToMenu, callback_data: CB.MENU }]);

    return upsertInline(bot, chatId, s, "LOGISTICS", "🚚 Обери напрямок (без повторів):", {
      inline_keyboard: rows,
    });
  }

  // 2) КІЛЬКІСТЬ ОБ'ЄКТІВ
  if (lg.step === "ENTER_QTY") {
const cur = lg.current ?? { employeeIds: [], materialIds: [], qty: 1 };
    const dest = lg.logistics.find((x) => x.id === cur.logisticId);

    const title = dest
      ? `📍 ${dest.name}` + (showMoney ? `\n💰 Ставка: ${dest.tariff}` : "")
      : "📍 Обрано напрямок";

    const qty = cur.qty ?? 1;

    const kb: TelegramBot.InlineKeyboardMarkup = {
      inline_keyboard: [
        [
          { text: "➖", callback_data: "lg:qty:-" },
          { text: `К-сть: ${qty}`, callback_data: "lg:noop" },
          { text: "➕", callback_data: "lg:qty:+" },
        ],
        [
          { text: "1", callback_data: "lg:qty:set:1" },
          { text: "2", callback_data: "lg:qty:set:2" },
          { text: "3", callback_data: "lg:qty:set:3" },
          { text: "5", callback_data: "lg:qty:set:5" },
          { text: "10", callback_data: "lg:qty:set:10" },
        ],
        [{ text: "✍️ Ввести число", callback_data: "lg:qty:ask" }],
        [{ text: "Далі ➡️ Люди", callback_data: "lg:qty:done" }],
        [{ text: "⬅️ Назад", callback_data: "lg:back:dest" }],
        [{ text: TEXTS.common.backToMenu, callback_data: CB.MENU }],
      ],
    };

    const hint = cur.awaitingQtyText
      ? "\n\n✍️ Надішли число повідомленням (наприклад: 4)."
      : "";

    return upsertInline(bot, chatId, s, "LOGISTICS", `${title}\n\n🏗 Введи кількість обʼєктів.${hint}`, kb);
  }

  // 3) ВИБІР ЛЮДЕЙ
  // 3) ВИБІР ЛЮДЕЙ
  if (lg.step === "EMP_PICK") {
    const current = lg.current ?? { employeeIds: [] };
    const selected = new Set(current.employeeIds);

    // ✅ індекс редагованого item (якщо редагуємо людей)
    const editingIdx = lg.editing?.itemIndex;

    // ✅ люди, які зайняті в інших items (крім того, який зараз редагуємо)
    const usedByOther = new Set<string>();
    for (let i = 0; i < lg.items.length; i++) {
      if (editingIdx !== undefined && i === editingIdx) continue;
for (const empId of (lg.items[i]?.employeeIds ?? [])) usedByOther.add(empId);
    }

    const rows: TelegramBot.InlineKeyboardButton[][] = lg.employees.map((e) => {
      const isLocked = usedByOther.has(e.id) && !selected.has(e.id);

      // ✅ якщо людина вже зайнята в іншому записі — показуємо як заблоковану
      if (isLocked) {
        return [
          {
            text: `⛔️ ${e.name}`,
            callback_data: `lg:emp_locked:${e.id}`,
          },
        ];
      }

      // ✅ звичайний toggle
      return [
        {
          text: `${selected.has(e.id) ? "✅ " : ""}${e.name}`,
          callback_data: `lg:emp:${e.id}`,
        },
      ];
    });

//    rows.push([{ text: "Далі ➡️ Матеріали", callback_data: "lg:emp:next_materials" }]);
    rows.push([{ text: "Готово ✅", callback_data: "lg:emp:done" }]);
    rows.push([{ text: "⬅️ Назад", callback_data: "lg:back:qty" }]);
    rows.push([{ text: TEXTS.common.backToMenu, callback_data: CB.MENU }]);

    return upsertInline(bot, chatId, s, "LOGISTICS", "👥 Обери працівників (без повторів між обʼєктами):", {
      inline_keyboard: rows,
    });
  }



  // 4) REVIEW
  if (lg.step === "REVIEW") {
    if (!lg.items.length) {
      lg.step = "PICK_DEST";
      return render(bot, chatId, s, userTgId);
    }

    const lines: string[] = [];
    let grandTotal = 0;

    for (const it of lg.items) {
//const mats = (it.materialIds ?? [])
//  .map((id) => lg.materials.find((m) => m.id === id)?.name)
//  .filter(Boolean)
//  .join(", ");

      const names = it.employeeIds
        .map((id) => lg.employees.find((e) => e.id === id)?.name)
        .filter(Boolean)
        .join(", ");

      const total = calcItemTotal(it, lg);
      grandTotal += total;

      const perPerson = it.employeeIds.length ? Math.round((total / it.employeeIds.length) * 100) / 100 : 0;

      lines.push(
        `*${it.logisticName}*\n` +
        `🏗 К-сть обʼєктів: ${it.qty}\n` +
        `👥 ${names || "—"}\n` +
//        `🧱 Матеріали: ${mats || "—"}\n` +
        (showMoney ? `💰 Сума: ${total}\n➗ На людину: ${perPerson}` : `➗ Розподіл порівну`)
      );
    }

    const allPeople = uniq(lg.items.flatMap((x) => x.employeeIds));
    const globalPerPerson = allPeople.length ? Math.round((grandTotal / allPeople.length) * 100) / 100 : 0;

    const summaryBase =
      `\n\n📌 Підсумок:\n` +
      `• Записів: ${lg.items.length}\n` +
      `• Всього людей (унікально): ${allPeople.length}`;

    const summaryMoney =
      `\n` +
      `• Всього сума: ${grandTotal}\n` +
      `• Якщо ділити все на всіх: ${globalPerPerson} / людина`;

    const summary = showMoney
      ? (
        `\n\n📌 Підсумок:\n` +
        `• Записів: ${lg.items.length}\n` +
        `• Всього людей (унікально): ${allPeople.length}\n` +
        `• Всього сума: ${grandTotal}\n` +
        `• Якщо ділити все на всіх: ${globalPerPerson} / людина`
      )
      : (
        `\n\n📌 Підсумок:\n` +
        `• Записів: ${lg.items.length}\n` +
        `• ➗ Розподіл порівну`
      );

    const kb: TelegramBot.InlineKeyboardMarkup = {
      inline_keyboard: [
        [{ text: "➕ Додати ще", callback_data: "lg:add_more" }],
        [{ text: "✏️ Редагувати", callback_data: "lg:edit" }],
        [{ text: "💾 Відправити", callback_data: "lg:save" }],
        [{ text: TEXTS.common.backToMenu, callback_data: CB.MENU }],
      ],
    };

    
    return upsertInline(
      bot,
      chatId,
      s,
      "LOGISTICS",
      `Перевір ✅\n\n${lines.join("\n\n")}${summary}`,
      kb
    );
  }
/** 
    // 3.5) ВИБІР МАТЕРІАЛІВ
  if (lg.step === "MAT_PICK") {
    const current = lg.current ?? { employeeIds: [], materialIds: [], qty: 1 };
    const selected = new Set(current.materialIds ?? []);

    const rows = lg.materials.map((m) => [
      {
        text: `${selected.has(m.id) ? "✅ " : ""}${m.name}`,
        callback_data: `lg:mat:${m.id}`,
      },
    ]);

    rows.push([{ text: "Готово ✅", callback_data: "lg:mat:done" }]);
    rows.push([{ text: "⬅️ Назад", callback_data: "lg:back:emp" }]);
    rows.push([{ text: TEXTS.common.backToMenu, callback_data: CB.MENU }]);

    return upsertInline(bot, chatId, s, "LOGISTICS", "🧱 Обери матеріали (можна кілька):", {
      inline_keyboard: rows,
    });
  }
*/
  // EDIT PICK ITEM
  if (lg.step === "EDIT_PICK_ITEM") {
    const rows = lg.items.map((it, idx) => [{ text: `🚚 ${it.logisticName}`, callback_data: `lg:edit:item:${idx}` }]);
    rows.push([{ text: "⬅️ Назад", callback_data: "lg:review" }]);
    rows.push([{ text: TEXTS.common.backToMenu, callback_data: CB.MENU }]);

    return upsertInline(bot, chatId, s, "LOGISTICS", "✏️ Обери запис який редагуємо:", { inline_keyboard: rows });
  }

  // EDIT ACTION
  if (lg.step === "EDIT_ACTION") {
    const idx = lg.editing?.itemIndex;
    if (idx === undefined) {
      lg.step = "EDIT_PICK_ITEM";
      return render(bot, chatId, s, userTgId);
    }

    const it = lg.items[idx];
    if (!it) {
      await bot.sendMessage(chatId, "❌ Цей запис не знайдено. Повертаю до перегляду.");
      lg.step = "REVIEW";
      return render(bot, chatId, s, userTgId);
    }

    return upsertInline(
      bot,
      chatId,
      s,
      "LOGISTICS",
      `✏️ Редагування: *${it.logisticName}*\n\nЩо міняємо?`,
      {
        inline_keyboard: [
          [{ text: "🚚 Змінити напрямок", callback_data: "lg:edit:dest" }],
          [{ text: "🏗 Змінити к-сть", callback_data: "lg:edit:qty" }],
          [{ text: "👥 Змінити людей", callback_data: "lg:edit:employees" }],
          [{ text: "🗑 Видалити", callback_data: "lg:edit:delete" }],
          [{ text: "⬅️ Назад", callback_data: "lg:edit" }],
          [{ text: TEXTS.common.backToMenu, callback_data: CB.MENU }],
        ],
      }
    );
  }
}

export const LogisticsFlow: FlowModule = {
  flow: "LOGISTICS",
  menuText: TEXTS.buttons.logistics,
  cbPrefix: "lg:",

  start: async (bot, chatId, s) => {
    const existing = getFlowState<LogisticsState>(s, "LOGISTICS");
    if (existing) {
      s.mode = "FLOW";
      s.flow = "LOGISTICS";
      return render(bot, chatId, s, undefined);
    }

    

const [logistics, employees, users] = await Promise.all([
  fetchLogistics(),
  fetchEmployees(),
  fetchUsers(),
//  fetchMaterials(),
]);

    const st: LogisticsState = {
      step: "PICK_DEST",
      logistics: logistics.map((x: any) => ({
        id: x.id,
        name: x.name,
        tariff: Number(x.tariff) || 0,
        discountsByQty: x.discountsByQty ?? {},
      })),
      employees: employees.map((e: any) => ({ id: e.id, name: e.name })),
//      materials: (materials ?? []).map((m: any) => ({
//  id: m.id,
//  name: m.name,
//  unit: m.unit,
//})),

users: (users ?? [])
  .map((u: any) => ({
    tgId: Number(u.tgId) || 0,
    role: String(u.role ?? ""),
    active: Boolean(u.active), // ✅ active вже boolean
  }))
  .filter((u: any) => u.tgId > 0 && u.active),



      current: { employeeIds: [], materialIds: [], qty: 1 },
      items: [],
    };

    setFlowState(s, "LOGISTICS", st);
    s.mode = "FLOW";
    s.flow = "LOGISTICS";

    return render(bot, chatId, s, undefined);
  },

  render: async (bot, chatId, s) => render(bot, chatId, s, undefined),

  // ✅ додали onMessage для вводу qty текстом
  onMessage: async (bot, msg, s) => {
    const chatId = msg.chat.id;
    const lg = getFlowState<LogisticsState>(s, "LOGISTICS");
    if (!lg) return false;

    if (lg.step !== "ENTER_QTY") return false;
    if (!lg.current?.awaitingQtyText) return false;

    const raw = String(msg.text || "").trim();
    const n = Number(raw);

    if (!Number.isFinite(n) || n <= 0 || n > 999) {
      await bot.sendMessage(chatId, "❌ Введи число від 1 до 999");
      return true;
    }

    lg.current.qty = Math.floor(n);
    lg.current.awaitingQtyText = false;

    await render(bot, chatId, s, msg.from?.id);
    return true;
  },

  onCallback: async (bot, q, s, data) => {
    const chatId = q.message?.chat?.id;
    if (typeof chatId !== "number") return false;

// ✅ ADMIN callbacks must work even if LOGISTICS state is missing (admin chat)
// ✅ ADMIN callbacks must work even if LOGISTICS state is missing (admin chat)
if (
  data.startsWith("lg:adm:approve:") ||
  data.startsWith("lg:adm:return:") ||
  data.startsWith("lg:adm:return_reason:") ||
  data.startsWith("lg:adm:return_cancel:")
) {
  const nowIso = new Date().toISOString();

  // ---------- admin check (без state) ----------
  const users = await fetchUsers();
  const usersNorm = (users ?? [])
    .map((u: any) => ({
      tgId: Number(u.tgId) || 0,
      role: String(u.role ?? ""),
      active: Boolean(u.active),
    }))
    .filter((u: any) => u.tgId > 0 && u.active);

  const role = String(usersNorm.find((u: any) => u.tgId === Number(q.from.id))?.role ?? "")
    .toUpperCase()
    .trim();

  const isAdmin = role.includes("АДМІН") || role.includes("ADMIN");
  if (!isAdmin) {
    await bot.answerCallbackQuery(q.id, { text: "⛔️ Тільки адміністратор", show_alert: true });
    return true;
  }

  // ---------- helpers ----------
  const adminChatId = q.message?.chat?.id;
  const adminMsgId = q.message?.message_id;

  async function safeEditAdmin(text: string) {
    if (typeof adminChatId !== "number" || typeof adminMsgId !== "number") return;
    try {
      // прибираємо кнопки
      await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: adminChatId, message_id: adminMsgId });
    } catch {}
    try {
      await bot.editMessageText(text, { chat_id: adminChatId, message_id: adminMsgId, parse_mode: "Markdown" });
    } catch {}
  }


  
  // ---------- RETURN CANCEL ----------
  if (data.startsWith("lg:adm:return_cancel:")) {
    const eventId = data.split(":").slice(3).join(":");
    await bot.answerCallbackQuery(q.id, { text: "✅ Скасовано" });

    // адміну: підтвердження + забрати клавіатуру (щоб не натискали далі)
    await safeEditAdmin(`❎ *Повернення скасовано*\n🆔 Подія: *Логістика*`);
    return true;
  }

  // ---------- RETURN REASON ----------
  if (data.startsWith("lg:adm:return_reason:")) {
    // формат: lg:adm:return_reason:<eventId>:<reasonCode>
    const parts = data.split(":");
    const reasonCode = parts.pop() || "OTHER";
    const eventId = parts.slice(3).join(":");

    const ev = await getEventById(eventId);
    if (!ev) {
      await bot.answerCallbackQuery(q.id, { text: "❌ Подію не знайдено", show_alert: true });
      return true;
    }

    const targetChatId = Number(ev.chatId) > 0 ? Number(ev.chatId) : Number(ev.foremanTgId);
    if (!Number.isFinite(targetChatId) || targetChatId <= 0) {
      await bot.answerCallbackQuery(q.id, { text: "⚠️ Нема куди відправити бригадиру", show_alert: true });
      return true;
    }

    const reasonMap: Record<string, string> = {
      WRONG_PEOPLE: "Не ті люди",
      WRONG_QTY: "Невірна кількість",
      WRONG_DEST: "Невірний напрямок",
      NO_COMMENT: "Без коментаря",
      OTHER: "Інше",
    };
    const reasonText = reasonMap[reasonCode] ?? reasonMap.OTHER;

    await updateEventById(eventId, {
      status: "ПОВЕРНУТО",
      updatedAt: nowIso,
      // якщо хочеш — можеш записувати reason у payload (опціонально, нижче)
      // payload: JSON.stringify({ ...(JSON.parse(ev.payload||"{}")), returnReason: reasonText, returnedAt: nowIso }),
    });

    // бригадиру
    await bot.sendMessage(
      targetChatId,
      `🔴 *Повернуто адміністратором на доопрацювання*\n📅 Дата: ${ev.date}\n🆔 Подія: 🆔 Подія: *Логістика*\n📝 Причина: *${reasonText}*\n\nВиправ і надішли знову.`,
      { parse_mode: "Markdown" }
    );

    // адміну: підтвердження + прибрати кнопки
    await bot.answerCallbackQuery(q.id, { text: "🔴 Повернено" });
    await safeEditAdmin(`🔴 *Повернено*\n*Логістика*\n📝 Причина: *${reasonText}*`);
    return true;
  }

  // ---------- RETURN (просимо причину) ----------
  if (data.startsWith("lg:adm:return:")) {
    const eventId = data.split(":").slice(3).join(":");

    await bot.answerCallbackQuery(q.id, { text: "✍️ Обери причину" });

    // адміну: показати кнопки причин + скасувати
    if (typeof adminChatId === "number") {
      await bot.sendMessage(adminChatId, `🔴 *Повернення*\n🆔 Подія: *Логістика*n\nОбери причину:`, {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "👥 Не ті люди", callback_data: `lg:adm:return_reason:${eventId}:WRONG_PEOPLE` }],
            [{ text: "🏗 Невірна кількість", callback_data: `lg:adm:return_reason:${eventId}:WRONG_QTY` }],
            [{ text: "🚚 Невірний напрямок", callback_data: `lg:adm:return_reason:${eventId}:WRONG_DEST` }],
            [{ text: "📝 Без коментаря", callback_data: `lg:adm:return_reason:${eventId}:NO_COMMENT` }],
            [{ text: "❎ Скасувати", callback_data: `lg:adm:return_cancel:${eventId}` }],
          ],
        },
      });
    }
    return true;
  }

  // ---------- APPROVE ----------
  if (data.startsWith("lg:adm:approve:")) {
    const eventId = data.split(":").slice(3).join(":");

    const ev = await getEventById(eventId);
    if (!ev) {
      await bot.answerCallbackQuery(q.id, { text: "❌ Подію не знайдено", show_alert: true });
      return true;
    }

    const targetChatId = Number(ev.chatId) > 0 ? Number(ev.chatId) : Number(ev.foremanTgId);
    if (!Number.isFinite(targetChatId) || targetChatId <= 0) {
      await bot.answerCallbackQuery(q.id, { text: "⚠️ Нема куди відправити бригадиру", show_alert: true });
      return true;
    }

    await updateEventById(eventId, {
      status: "ЗАТВЕРДЖЕНО",
      updatedAt: nowIso,
    });

    // бригадиру: повний чек з сумами
    const moneyText = buildLogisticsMoneyTextFromEventPayload({ ...ev, eventId }); // щоб eventId точно був у тексті
    await bot.sendMessage(
      targetChatId,
      `✅ *Логістика затверджена*\n\n${moneyText}`,
      { parse_mode: "Markdown" }
    );

    // адміну: підтвердження + прибрати кнопки в його повідомленні
    await bot.answerCallbackQuery(q.id, { text: "✅ Затверджено" });
    await safeEditAdmin(`✅ *Затверджено*\n🆔 Подія: *Логістика*`);
    return true;
  }

  return true;
}


    // натиснули на заблоковану людину
    if (data.startsWith("lg:emp_locked:")) {
      await bot.answerCallbackQuery(q.id, {
        text: "⛔️ Ця людина вже вибрана для іншого обʼєкта/напрямку",
        show_alert: true,
      });
      return true;
    }
// ---- нижче вже звичайні callbacks, їм потрібен state ----
const lg = getFlowState<LogisticsState>(s, "LOGISTICS");
if (!lg) return false;

/** 
if (data === "lg:back:emp") {
  lg.step = "EMP_PICK";
  await render(bot, chatId, s, q.from.id);
  return true;
}
*/
    if (data === CB.MENU) return false;

    // noop
    if (data === "lg:noop") return true;

    // NAV
    if (data === "lg:add_more") {
      lg.step = "PICK_DEST";
      lg.current = { employeeIds: [], materialIds: [], qty: 1 };
      await render(bot, chatId, s, q.from.id);
      return true;
    }

    if (data === "lg:review") {
      lg.step = "REVIEW";
      await render(bot, chatId, s, q.from.id);
      return true;
    }

    // BACKS
    if (data === "lg:back:dest") {
      lg.step = "PICK_DEST";
      lg.current = { employeeIds: [], materialIds: [], qty: 1 };
      await render(bot, chatId, s, q.from.id);
      return true;
    }

    if (data === "lg:back:qty") {
      lg.step = "ENTER_QTY";
      await render(bot, chatId, s, q.from.id);
      return true;
    }

    // PICK DESTINATION (без повторів)
    if (data.startsWith("lg:dest:")) {
      const id = data.replace("lg:dest:", "");
      const dest = lg.logistics.find((x) => x.id === id);
      if (!dest) return true;

      // якщо вже є в items — не даємо (бо “без повторів”)
      if (lg.items.some((it) => it.logisticId === id) && lg.editing?.itemIndex === undefined) {
        await bot.sendMessage(chatId, "⚠️ Цей напрямок уже доданий. Обери інший.");
        return true;
      }

      lg.current = {
  logisticId: id,
  qty: lg.current?.qty ?? 1,
  employeeIds: [],
  materialIds: [],
  awaitingQtyText: false,
};
      lg.step = "ENTER_QTY";
      await render(bot, chatId, s, q.from.id);
      return true;
    }

    // QTY controls
    if (data === "lg:qty:-") {
      if (!lg.current) lg.current = { employeeIds: [], materialIds: [], qty: 1 };
      lg.current.qty = Math.max(1, (lg.current.qty ?? 1) - 1);
      await render(bot, chatId, s, q.from.id);
      return true;
    }

    if (data === "lg:qty:+") {
      if (!lg.current) lg.current = { employeeIds: [], materialIds: [], qty: 1 };
      lg.current.qty = Math.min(999, (lg.current.qty ?? 1) + 1);
      await render(bot, chatId, s, q.from.id);
      return true;
    }

    if (data.startsWith("lg:qty:set:")) {
      const n = Number(data.replace("lg:qty:set:", ""));
      if (!Number.isFinite(n) || n <= 0) return true;
      if (!lg.current) lg.current = { employeeIds: [], materialIds: [], qty: 1 };
      lg.current.qty = Math.min(999, Math.max(1, Math.floor(n)));
      lg.current.awaitingQtyText = false;
      await render(bot, chatId, s, q.from.id);
      return true;
    }

    if (data === "lg:qty:ask") {
      if (!lg.current) lg.current = { employeeIds: [], materialIds: [], qty: 1 };
      lg.current.awaitingQtyText = true;
      await render(bot, chatId, s, q.from.id);
      return true;
    }

    if (data === "lg:qty:done") {
      if (!lg.current?.logisticId) return true;
      if (!lg.current.qty || lg.current.qty <= 0) {
        await bot.sendMessage(chatId, "❌ Вкажи к-сть обʼєктів (мінімум 1)");
        return true;
      }
      lg.step = "EMP_PICK";
      await render(bot, chatId, s, q.from.id);
      return true;
    }
/** 
    if (data === "lg:emp:next_materials") {
  if (!lg.current?.employeeIds?.length) {
    await bot.sendMessage(chatId, "Обери хоча б 1 працівника ✅");
    return true;
  }
  lg.step = "MAT_PICK";
  await render(bot, chatId, s, q.from.id);
  return true;
}
*/


    // EMP toggle
    // EMP toggle (без повторів між items)
    if (data.startsWith("lg:emp:") && data !== "lg:emp:done") {
      const empId = data.replace("lg:emp:", "");
      if (!lg.current) lg.current = { employeeIds: [], materialIds: [], qty: 1 };

      const editingIdx = lg.editing?.itemIndex;

      // ✅ люди, що вже використані в інших items (окрім редагованого)
      const usedByOther = new Set<string>();
      for (let i = 0; i < lg.items.length; i++) {
        if (editingIdx !== undefined && i === editingIdx) continue;
for (const id of (lg.items[i]?.employeeIds ?? [])) usedByOther.add(id);
      }

      const set = new Set(lg.current.employeeIds);

      // ✅ якщо людина вже зайнята в іншому записі — не даємо додати
      if (!set.has(empId) && usedByOther.has(empId)) {
        await bot.answerCallbackQuery(q.id, {
          text: "⛔️ Ця людина вже вибрана для іншого обʼєкта/напрямку",
          show_alert: true,
        });
        return true;
      }

      // toggle
      if (set.has(empId)) set.delete(empId);
      else set.add(empId);

      lg.current.employeeIds = Array.from(set);
      await render(bot, chatId, s, q.from.id);
      return true;
    }

    // EMP done => commit item
if (data === "lg:emp:done") {
  const cur = lg.current;
  if (!cur?.employeeIds?.length) {
    await bot.sendMessage(chatId, "Обери хоча б 1 працівника ✅");
    return true;
  }

  const id = cur.logisticId;
  const dest = lg.logistics.find((x) => x.id === id);
  if (!id || !dest) return true;

  const item: LogisticsItem = {
    logisticId: dest.id,
    logisticName: dest.name,
    tariff: dest.tariff,
    qty: Math.max(1, Math.floor(cur.qty ?? 1)),
    employeeIds: [...cur.employeeIds],
    materialIds: [],
  };

  lg.items.push(item);

  lg.current = { employeeIds: [], materialIds: [], qty: 1 };
  lg.step = "PICK_DEST";
  await render(bot, chatId, s, q.from.id);
  return true;
}

    // EDIT
    if (data === "lg:edit") {
      lg.step = "EDIT_PICK_ITEM";
      await render(bot, chatId, s, q.from.id);
      return true;
    }

    if (data.startsWith("lg:edit:item:")) {
      const idx = Number(data.replace("lg:edit:item:", ""));
      if (!Number.isFinite(idx) || idx < 0 || idx >= lg.items.length) return true;
      lg.editing = { itemIndex: idx };
      lg.step = "EDIT_ACTION";
      await render(bot, chatId, s, q.from.id);
      return true;
    }

    if (data === "lg:edit:delete") {
      const idx = lg.editing?.itemIndex;
      if (idx === undefined) return true;
      lg.items.splice(idx, 1);
      delete lg.editing;
      lg.step = "REVIEW";
      await render(bot, chatId, s, q.from.id);
      return true;
    }

    if (data === "lg:edit:employees") {
      const idx = lg.editing?.itemIndex;
      if (idx === undefined) return true;

      const it = lg.items[idx];
      if (!it) return true;

lg.current = {
  logisticId: it.logisticId,
  qty: it.qty,
  employeeIds: [...it.employeeIds],
  materialIds: [...(it.materialIds ?? [])],
};      lg.step = "EMP_PICK";
      await render(bot, chatId, s, q.from.id);
      return true;
    }

    if (data === "lg:edit:qty") {
      const idx = lg.editing?.itemIndex;
      if (idx === undefined) return true;

      const it = lg.items[idx];
      if (!it) return true;

lg.current = {
  logisticId: it.logisticId,
  qty: it.qty,
  employeeIds: [...it.employeeIds],
  materialIds: [...(it.materialIds ?? [])],
};      lg.step = "ENTER_QTY";
      await render(bot, chatId, s, q.from.id);
      return true;
    }

    if (data === "lg:edit:dest") {
      // у режимі редагування дозволимо обрати інший напрямок:
      lg.step = "PICK_DEST";
      // але треба дозволити повтор “свого ж” — тому перед вибором видаляємо item
      const idx = lg.editing?.itemIndex;
      if (idx !== undefined) {
        lg.items.splice(idx, 1);
        delete lg.editing;
      }
      lg.current = { employeeIds: [], materialIds: [], qty: 1 };
      await render(bot, chatId, s, q.from.id);
      return true;
    }
/** 
    if (data === "lg:emp:next_materials") {
  if (!lg.current?.employeeIds?.length) {
    await bot.sendMessage(chatId, "Обери хоча б 1 працівника ✅");
    return true;
  }
  if (!lg.current.materialIds) lg.current.materialIds = [];
  lg.step = "MAT_PICK";
  await render(bot, chatId, s, q.from.id);
  return true;
}

if (data.startsWith("lg:mat:") && data !== "lg:mat:done") {
  const matId = data.replace("lg:mat:", "");
  if (!lg.current) lg.current = { employeeIds: [], materialIds: [], qty: 1 };
  if (!lg.current.materialIds) lg.current.materialIds = [];

  const set = new Set(lg.current.materialIds);
  if (set.has(matId)) set.delete(matId);
  else set.add(matId);

  lg.current.materialIds = Array.from(set);
  await render(bot, chatId, s, q.from.id);
  return true;
}
*/
    // SAVE
    if (data === "lg:save") {
      if (!lg.items.length) return true;

      const date = todayISO();
      const foremanTgId = q.from.id;
      const tg = q.from.username ? `@${q.from.username}` : String(q.from.first_name || "");
      const chatId2 = chatId;

      // guard (без objectId тут реально нема що чекати)
      const g = await ensureNotLockedForLogisticsSave({
        bot,
        chatId: chatId2,
        date,
        foremanTgId,
        actionLabel: "Логістика",
      });
      if (!g.ok) return true;

      const eventId = makeEventId("LG");

      // унікальні люди по всій логістиці
      const employeeIds = uniq(lg.items.flatMap((it) => it.employeeIds));

      // totals
      const totalsByEmployee: Record<string, number> = {};
      for (const it of lg.items) {
        const total = calcItemTotal(it, lg);
        const per = it.employeeIds.length ? total / it.employeeIds.length : 0;
        for (const empId of it.employeeIds) {
          totalsByEmployee[empId] = (totalsByEmployee[empId] || 0) + per;
        }
      }

const payloadObj = {
  schemaVersion: 3,
  items: lg.items,
  totalsByEmployee,
  tg,
  // ✅ додай словники, щоб потім можна було красиво показати
  logistics: lg.logistics,
  employees: lg.employees,
//  materials: lg.materials,
};

await upsertEvent({
  eventId,
  status: "АКТИВНА", // ✅ замість "АКТИВНА" для логістики на перевірку
  ts: new Date().toISOString(),
  updatedAt: new Date().toISOString(),

  date,
  foremanTgId,
  chatId: chatId2,

  type: "ЛОГІСТИКА",
  objectId: "",

  employeeIds: JSON.stringify(employeeIds),
  payload: JSON.stringify(payloadObj),

  ...(q.message?.message_id ? { msgId: q.message.message_id } : {}),
});

            // ---- notify admins for approval ----
      const adminIds = getAdminTgIds(lg);

const adminText = buildLogisticsMoneyTextFromEventPayload({
  payload: JSON.stringify(payloadObj),
  date,
  eventId,
});

const adminKb: TelegramBot.InlineKeyboardMarkup = {
  inline_keyboard: [
    [
      { text: "✅ Затвердити", callback_data: `lg:adm:approve:${eventId}` },
      { text: "🔴 Повернути", callback_data: `lg:adm:return:${eventId}` },
    ],
  ],
};

// шлемо всім адмінам (повний чек з сумами)
for (const adminId of adminIds) {
  try {
    await bot.sendMessage(adminId, adminText, {
      parse_mode: "Markdown",
      reply_markup: adminKb,
    });
  } catch (e) {}
}

      // Якщо треба чекліст — його неможливо refreshнути без objectId.
      // Якщо хочеш — прив’яжемо логістику до обраного “об’єкта дня”, але ти саме це прибрав.

      clearFlowState(s, "LOGISTICS");
      s.mode = "MENU";
      delete s.flow;

      await bot.sendMessage(chatId2, "✅ Збережено в «Журнал подій» (логістика)");
      return true;
    }

    return false;
  },
};