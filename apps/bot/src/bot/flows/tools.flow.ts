import type TelegramBot from "node-telegram-bot-api";
import type { FlowModule, Session } from "../core/flowTypes.js";
import { getFlowState, setFlowState, clearFlowState, upsertInline, todayISO } from "../core/helpers.js";
import { CB } from "../core/cb.js";

import type { ToolRow, ToolMoveRow } from "../../google/sheets/types.js";
import { TEXTS } from "../texts.js";
import { fetchTools } from "../../google/sheets/dictionaries.js";
import { appendToolMoves, refreshDayChecklist } from "../../google/sheets/working.js";
import { getDayStatusRow } from "../../google/sheets/checklist.js";


type Step = "PICK_DATE" | "PICK_CATEGORY" | "PICK_TOOL" | "ENTER_QTY" | "PICK_TYPE" | "REVIEW";
type MoveType = "ISSUE" | "RETURN" | "BROKEN" | "LOST" | "FOUND" | "ADJUST";

type State = {
  step: Step;
  date: string;
  toolId?: string;
  toolName?: string;
  qty?: number | null;
  moveType?: MoveType;
  category?: string;
};

const FLOW = "TOOLS";
const PREFIX = "tl:";

const ACT = {
  DATE_TODAY: `${PREFIX}date:today`,
  DATE_YESTERDAY: `${PREFIX}date:yesterday`,
  TOOL: `${PREFIX}tool:`,
  TYPE: `${PREFIX}type:`,
  SAVE: `${PREFIX}save`,
  CANCEL: `${PREFIX}cancel`,
  CAT: `${PREFIX}cat:`,
  CAT_CLEAR: `${PREFIX}cat:all`,
  PICK_CAT: `${PREFIX}pick_cat`,
} as const;

function initState(): State {
  return { step: "PICK_DATE", date: todayISO() };
}

function yesterdayISO() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function makeMoveId() {
  return `TOOL_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
}

async function render(bot: TelegramBot, chatId: number, s: Session, st: State) {
  if (st.step === "PICK_DATE") {
    return upsertInline(
      bot,
      chatId,
      s,
      FLOW as any,
      `🧰 *Інструмент*\n\nОбери дату:`,
      {
        inline_keyboard: [
          [{ text: "Сьогодні", callback_data: ACT.DATE_TODAY }],
          [{ text: "Вчора", callback_data: ACT.DATE_YESTERDAY }],
          [{ text: "⬅️ Меню", callback_data: CB.MENU }],
        ],
      }
    );
  }

if (st.step === "PICK_TOOL") {
  const tools = await fetchTools();
  const active = tools.filter((t: any) => String(t.active ?? "").toLowerCase() !== "ні");

  const filtered = st.category
    ? (st.category === "__NO_CAT__"
        ? active.filter((t: any) => !String(t.category ?? "").trim())
        : active.filter((t: any) => String(t.category ?? "").trim() === st.category))
    : active;

  const rows = filtered.slice(0, 30).map((t) => [
    { text: `🧰 ${t.name}`, callback_data: `${ACT.TOOL}${t.id}` },
  ]);

  rows.unshift([{ text: "🧩 Змінити категорію", callback_data: ACT.PICK_CAT }]);
  rows.push([{ text: "⬅️ Меню", callback_data: CB.MENU }]);

  return upsertInline(
    bot,
    chatId,
    s,
    FLOW as any,
    `🧰 *Інструмент*\n\n📅 ${st.date}\nКатегорія: *${
      st.category ? (st.category === "__NO_CAT__" ? "Без категорії" : st.category) : "Усі"
    }*\n\nОбери інструмент:`,
    { inline_keyboard: rows }
  );
}


  if (st.step === "PICK_CATEGORY") {
  const tools = await fetchTools();
  const active = tools.filter((t: any) => String(t.active ?? "").toLowerCase() !== "ні");

  const cats = Array.from(
    new Set(active.map((t: any) => String(t.category ?? "").trim()).filter(Boolean))
  ).sort((a, b) => a.localeCompare(b, "uk"));

  const rows: TelegramBot.InlineKeyboardButton[][] = [];

  rows.push([{ text: st.category ? "▫️ Усі категорії" : "✅ Усі категорії", callback_data: ACT.CAT_CLEAR }]);
  rows.push([{ text: "🫥 Без категорії", callback_data: `${ACT.CAT}${encodeURIComponent("__NO_CAT__")}` }]);

  for (const c of cats.slice(0, 40)) {
    const on = st.category === c;
    rows.push([{ text: `${on ? "✅" : "▫️"} ${c}`, callback_data: `${ACT.CAT}${encodeURIComponent(c)}` }]);
  }

  rows.push([{ text: "⬅️ Меню", callback_data: CB.MENU }]);

  return upsertInline(bot, chatId, s, FLOW as any, `🧰 *Інструмент*\n\n📅 ${st.date}\n\nОбери категорію:`, {
    inline_keyboard: rows,
  });
}




  if (st.step === "ENTER_QTY") {
    return upsertInline(
      bot,
      chatId,
      s,
      FLOW as any,
      `🧰 *Інструмент*\n\n📅 Дата: *${st.date}*\n\nНапиши кількість (число) в чат:`,
      { inline_keyboard: [[{ text: "⬅️ Меню", callback_data: CB.MENU }]] }
    );
  }

  if (st.step === "PICK_TYPE") {
    const types: MoveType[] = ["ISSUE", "RETURN", "BROKEN", "LOST", "FOUND", "ADJUST"];
    return upsertInline(
      bot,
      chatId,
      s,
      FLOW as any,
      `🧰 *Інструмент*\n\n📅 ${st.date}\n🔢 ${st.qty}\n\nОбери тип:`,
      {
        inline_keyboard: [
          ...types.map((t) => [{ text: t, callback_data: `${ACT.TYPE}${t}` }]),
          [{ text: "⬅️ Меню", callback_data: CB.MENU }],
        ],
      }
    );
  }

  // REVIEW
  return upsertInline(
    bot,
    chatId,
    s,
    FLOW as any,
    `✅ *Перевір*\n\n📅 ${st.date}\n🧰 ${st.toolName ?? st.toolId ?? "—"}\n🔢 ${st.qty}\n🧾 ${st.moveType}\n\nЗберігаємо?`,
    {
      inline_keyboard: [
        [{ text: "✅ Зберегти", callback_data: ACT.SAVE }],
        [{ text: "❌ Скасувати", callback_data: ACT.CANCEL }],
        [{ text: "⬅️ Меню", callback_data: CB.MENU }],
      ],
    }
  );
}

export const ToolsFlow: FlowModule = {
  flow: FLOW as any,
  menuText: TEXTS.buttons.tools,      // ✅ ОБОВʼЯЗКОВО
  cbPrefix: PREFIX,

  async start(bot, chatId, s) {
    s.flow = FLOW as any;
    setFlowState(s, FLOW as any, initState() as any);

    await this.render(bot, chatId, s); // ✅ через render
  },

  async render(bot, chatId, s) {       // ✅ ОБОВʼЯЗКОВО
    const st = getFlowState<State>(s, FLOW as any);
    if (!st) return;
    await render(bot, chatId, s, st);  // твоя внутрішня render(...)
  },

  async onCallback(bot, q, s, data) {
    const chatId = q.message?.chat.id;
    const actorTgId = q.from.id;
    if (!chatId) return false;

    const st = getFlowState<State>(s, FLOW as any);
    if (!st) return false;

    if (data === ACT.CANCEL) {
      clearFlowState(s, FLOW as any);
      delete s.flow;
      await bot.sendMessage(chatId, "❌ Скасовано");
      return true;
    }


if (data === ACT.PICK_CAT) {
  setFlowState(s, FLOW as any, { ...st, step: "PICK_CATEGORY" } as any);
  await render(bot, chatId, s, getFlowState<State>(s, FLOW as any)!);
  return true;
}

if (data === ACT.CAT_CLEAR) {
  setFlowState(s, FLOW as any, {
    ...st,
    category: undefined,
    toolId: undefined,
    toolName: undefined,
    qty: undefined,
    moveType: undefined,
    step: "PICK_TOOL",
  } as any);
  await render(bot, chatId, s, getFlowState<State>(s, FLOW as any)!);
  return true;
}

if (data.startsWith(ACT.CAT)) {
  const raw = decodeURIComponent(data.slice(ACT.CAT.length));
  const category = raw === "__NO_CAT__" ? "__NO_CAT__" : raw;

  setFlowState(s, FLOW as any, {
    ...st,
    category,
    toolId: undefined,
    toolName: undefined,
    qty: undefined,
    moveType: undefined,
    step: "PICK_TOOL",
  } as any);
  await render(bot, chatId, s, getFlowState<State>(s, FLOW as any)!);
  return true;
}

if (data.startsWith(ACT.TOOL)) {
  const toolId = data.slice(ACT.TOOL.length);
  const tools = await fetchTools();
  const tool = tools.find((t: any) => String(t.id) === String(toolId));

  setFlowState(s, FLOW as any, {
    ...st,
    toolId,
    toolName: tool?.name ?? toolId,
    step: "ENTER_QTY",
  } as any);

  await render(bot, chatId, s, getFlowState<State>(s, FLOW as any)!);
  return true;
}


    if (data === ACT.DATE_TODAY) {
setFlowState(s, FLOW as any, { ...st, date: todayISO(), step: "PICK_CATEGORY" } as any);
      await render(bot, chatId, s, getFlowState<State>(s, FLOW as any)!);
      return true;
    }

if (data === ACT.DATE_YESTERDAY) {
  setFlowState(s, FLOW as any, { ...st, date: yesterdayISO(), step: "PICK_CATEGORY" } as any);
  await render(bot, chatId, s, getFlowState<State>(s, FLOW as any)!);
  return true;
}


    if (data === ACT.SAVE) {
      const cur = getFlowState<State>(s, FLOW as any)!;
      if (!cur.toolId || cur.qty == null || !Number.isFinite(cur.qty) || !cur.moveType)
 {
        await bot.sendMessage(chatId, "❌ Не всі поля заповнені");
        return true;
      }

      const tools = await fetchTools();
      const tool = tools.find((t) => t.id === cur.toolId) as ToolRow | undefined;
      if (!tool) {
        await bot.sendMessage(chatId, "❌ Інструмент не знайдено");
        return true;
      }

      const row: ToolMoveRow = {
        moveId: makeMoveId(),
        time: new Date().toISOString(),
        date: cur.date,
        foremanTgId: actorTgId,
        toolId: tool.id,
        toolName: tool.name,
        qty: cur.qty,
        moveType: cur.moveType as any,
        purpose: "",
        photos: "",
        payload: "",
        updatedAt: new Date().toISOString(),
      };

      await appendToolMoves([row]);

      clearFlowState(s, FLOW as any);
      delete s.flow;
      await bot.sendMessage(chatId, "✅ Інструмент збережено");
      return true;
    }

    return false;
  },

  async onMessage(bot, msg, s) {
    const chatId = msg.chat.id;
    const text = (msg.text ?? "").trim();

    const st = getFlowState<State>(s, FLOW as any);
    if (!st) return false;
    if (st.step !== "ENTER_QTY") return false;

    const n = Number(text.replace(",", "."));
    if (!Number.isFinite(n) || n <= 0) {
      await bot.sendMessage(chatId, "❌ Введи число > 0");
      return true;
    }

setFlowState(s, FLOW as any, { ...st, qty: n, step: "PICK_TYPE" } as any);
    await render(bot, chatId, s, getFlowState<State>(s, FLOW as any)!);
    return true;
  },
};
