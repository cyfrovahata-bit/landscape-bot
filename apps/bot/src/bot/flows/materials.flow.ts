import type TelegramBot from "node-telegram-bot-api";
import type { FlowModule, Session } from "../core/flowTypes.js";
import { getFlowState, setFlowState, clearFlowState, upsertInline, todayISO } from "../core/helpers.js";
import { CB } from "../core/cb.js";
import { TEXTS } from "../texts.js";

import { fetchObjects, fetchMaterials } from "../../google/sheets/dictionaries.js";
import { appendMaterialMoves, refreshDayChecklist } from "../../google/sheets/working.js";
import { getDayStatusRow } from "../../google/sheets/checklist.js";

import type { MaterialRow, MaterialMoveRow } from "../../google/sheets/types.js";

type Step = "PICK_DATE" | "PICK_OBJECT" | "PICK_CATEGORY" | "PICK_MATERIAL" | "ENTER_QTY" | "PICK_TYPE" | "REVIEW";

type MoveType = "ISSUE" | "RETURN" | "WRITEOFF" | "ADJUST";

type MaterialItem = {
  materialId: string;
  materialName: string;
  qty: number | null;
  unit?: string;
};

type State = {
  step: Step;
  date: string;
  objectId?: string;
  materialId?: string;
  qty?: number | null;
  moveType?: MoveType;
  purpose?: string;
  category?: string;
  objectName?: string;
  materialName?: string;
  items: MaterialItem[];
};

const FLOW = "MATERIALS";
const PREFIX = "mt:";

const ACT = {
  DATE_TODAY: `${PREFIX}date:today`,
  DATE_YESTERDAY: `${PREFIX}date:yesterday`,
  OBJ: `${PREFIX}obj:`,
  MAT: `${PREFIX}mat:`,
  TYPE: `${PREFIX}type:`,
  SAVE: `${PREFIX}save`,
  CANCEL: `${PREFIX}cancel`,
  CAT: `${PREFIX}cat:`,
  CAT_CLEAR: `${PREFIX}cat:all`,
  PICK_CAT: `${PREFIX}pick_cat`,
  DONE_MATERIALS: `${PREFIX}done_materials`,
} as const;

function initState(): State {
  return { step: "PICK_DATE", date: todayISO(), items: [] };
}

function moveTypeLabel(t?: MoveType) {
  if (!t) return TEXTS.ui.symbols.emptyDash;

  const labels: Record<MoveType, string> = {
    ISSUE: "Видача",
    RETURN: "Повернення",
    WRITEOFF: "Списання",
    ADJUST: "Коригування",
  };

  return labels[t];
}

function isLocked(status?: string) {
  const s = String(status || "").toUpperCase();
  return s === "ЗДАНО" || s === "ЗАТВЕРДЖЕНО";
}

function yesterdayISO() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function fmt(st: State) {
  return [
    `${TEXTS.materialsFlow.labels.date} *${st.date}*`,
    `${TEXTS.materialsFlow.labels.object} *${st.objectName ?? TEXTS.ui.symbols.emptyDash}*`,
    `${TEXTS.materialsFlow.labels.type} *${moveTypeLabel(st.moveType)}*`,
    `${TEXTS.materialsFlow.labels.material} *${
  st.items.length
    ? st.items.map(i => `${i.materialName} — ${i.qty ?? "?"} ${i.unit ?? ""}`).join(", ")
    : (st.materialName ?? TEXTS.ui.symbols.emptyDash)
}*`,
  ].join("\n");
}

async function render(bot: TelegramBot, chatId: number, s: Session, st: State) {
  if (st.step === "PICK_DATE") {
    return upsertInline(
      bot,
      chatId,
      s,
      FLOW,
      TEXTS.materialsFlow.screens.pickDate
  .replace("{title}", `*${TEXTS.materialsFlow.title}*`),
      {
        inline_keyboard: [
[{ text: TEXTS.materialsFlow.buttons.today, callback_data: ACT.DATE_TODAY }],
[{ text: TEXTS.materialsFlow.buttons.yesterday, callback_data: ACT.DATE_YESTERDAY }],
[{ text: TEXTS.ui.buttons.menu, callback_data: CB.MENU }],
        ],
      }
    );
  }

  if (st.step === "PICK_OBJECT") {
    const objects = await fetchObjects();
    const rows = objects.slice(0, 30).map((o) => [
      { text: `🏠 ${o.name}`, callback_data: `${ACT.OBJ}${o.id}` },
    ]);
rows.push([{ text: TEXTS.ui.buttons.menu, callback_data: CB.MENU }]);

    return upsertInline(
      bot,
      chatId,
      s,
      FLOW,
      TEXTS.materialsFlow.screens.pickObject
  .replace("{title}", `*${TEXTS.materialsFlow.title}*`)
  .replace("{fmt}", fmt(st)),

      { inline_keyboard: rows }
    );
  }

    if (st.step === "PICK_CATEGORY") {
    const mats = await fetchMaterials();
    const active = mats.filter((m: any) => String(m.active ?? "").toLowerCase() !== "ні");

    const cats = Array.from(
      new Set(
        active.map((m: any) => String(m.category ?? "").trim()).filter(Boolean)
      )
    ).sort((a, b) => a.localeCompare(b, "uk"));

    const rows: TelegramBot.InlineKeyboardButton[][] = [];

    // Усі категорії
rows.push([{
  text: st.category
    ? TEXTS.materialsFlow.buttons.allCategoriesOff
    : TEXTS.materialsFlow.buttons.allCategoriesOn,
  callback_data: ACT.CAT_CLEAR
}]);

    // Без категорії
rows.push([{ text: TEXTS.materialsFlow.buttons.noCategory, callback_data: `${ACT.CAT}__NO_CAT__` }]);

for (const c of cats.slice(0, 40)) {
  const on = st.category === c;
  // ⚠️ ризик: якщо c довга/емодзі — може вилетіти по 64 bytes
  rows.push([{ text: `${on ? "✅" : "▫️"} ${c}`, callback_data: `${ACT.CAT}${c}` }]);
}

rows.push([{ text: TEXTS.ui.buttons.menu, callback_data: CB.MENU }]);

    return upsertInline(
      bot,
      chatId,
      s,
      FLOW,
TEXTS.materialsFlow.screens.pickCategory
  .replace("{title}", `*${TEXTS.materialsFlow.title}*`)
  .replace("{fmt}", fmt(st)),
      { inline_keyboard: rows }
    );
  }


    if (st.step === "PICK_MATERIAL") {
    const mats = await fetchMaterials();
    const active = mats.filter((m: any) => String(m.active ?? "").toLowerCase() !== "ні");

    const filtered = st.category
      ? (st.category === "__NO_CAT__"
          ? active.filter((m: any) => !String(m.category ?? "").trim())
          : active.filter((m: any) => String(m.category ?? "").trim() === st.category))
      : active;

    const rows = filtered.slice(0, 30).map((m) => [
      { text: `🧱 ${m.name}`, callback_data: `${ACT.MAT}${m.id}` },
    ]);

    // кнопка змінити категорію
rows.unshift([{ text: TEXTS.materialsFlow.buttons.changeCategory, callback_data: ACT.PICK_CAT }]);

if (st.items.length > 0) {
  rows.push([{ text: "✅ Завершити вибір матеріалів", callback_data: ACT.DONE_MATERIALS }]);
}

rows.push([{ text: TEXTS.ui.buttons.menu, callback_data: CB.MENU }]);

    return upsertInline(
      bot,
      chatId,
      s,
      FLOW,
TEXTS.materialsFlow.screens.pickMaterial
  .replace("{title}", `*${TEXTS.materialsFlow.title}*`)
  .replace("{fmt}", fmt(st))
  .replace("{cat}",
    st.category
      ? (st.category === "__NO_CAT__" ? "Без категорії" : st.category)
      : "Усі"
  ),
      { inline_keyboard: rows }
    );
  }

  if (st.step === "ENTER_QTY") {
  return upsertInline(
    bot,
    chatId,
    s,
    FLOW,
TEXTS.materialsFlow.screens.enterQty
  .replace("{title}", `*${TEXTS.materialsFlow.title}*`)
  .replace("{fmt}", fmt(st)),
    { inline_keyboard: [[{ text: "⬅️ Меню", callback_data: CB.MENU }]] }
  );
}





  if (st.step === "PICK_TYPE") {
    const types: MoveType[] = ["ISSUE", "RETURN", "WRITEOFF", "ADJUST"];
    return upsertInline(
      bot,
      chatId,
      s,
      FLOW,
TEXTS.materialsFlow.screens.pickType
  .replace("{title}", `*${TEXTS.materialsFlow.title}*`)
  .replace("{fmt}", fmt(st)),
      {
        inline_keyboard: [
          ...types.map((t) => [{ text: moveTypeLabel(t), callback_data: `${ACT.TYPE}${t}` }]),
[{ text: TEXTS.ui.buttons.menu, callback_data: CB.MENU }],
        ],
      }
    );
  }

  // REVIEW
  return upsertInline(
    bot,
    chatId,
    s,
    FLOW,
TEXTS.materialsFlow.screens.review
  .replace("{check}", `*${TEXTS.materialsFlow.buttons.check}*`)
  .replace("{fmt}", fmt(st)),
    {
      inline_keyboard: [
[{ text: TEXTS.materialsFlow.buttons.save, callback_data: ACT.SAVE }],
[{ text: TEXTS.materialsFlow.buttons.cancel, callback_data: ACT.CANCEL }],
[{ text: TEXTS.ui.buttons.menu, callback_data: CB.MENU }],
      ],
    }
  );
}

async function sendNewMaterialsScreen(
  bot: TelegramBot,
  chatId: number,
  st: State
) {
  const mats = await fetchMaterials();
  const active = mats.filter((m: any) => String(m.active ?? "").toLowerCase() !== "ні");

  const filtered = st.category
    ? (st.category === "__NO_CAT__"
        ? active.filter((m: any) => !String(m.category ?? "").trim())
        : active.filter((m: any) => String(m.category ?? "").trim() === st.category))
    : active;

  const rows = filtered.slice(0, 30).map((m) => [
    { text: `🧱 ${m.name}`, callback_data: `${ACT.MAT}${m.id}` },
  ]);

  rows.unshift([{ text: TEXTS.materialsFlow.buttons.changeCategory, callback_data: ACT.PICK_CAT }]);

  if (st.items.length > 0) {
    rows.push([{ text: "✅ Завершити вибір матеріалів", callback_data: ACT.DONE_MATERIALS }]);
  }

  rows.push([{ text: TEXTS.ui.buttons.menu, callback_data: CB.MENU }]);

  await bot.sendMessage(
    chatId,
    TEXTS.materialsFlow.screens.pickMaterial
      .replace("{title}", `*${TEXTS.materialsFlow.title}*`)
      .replace("{fmt}", fmt(st))
      .replace("{cat}",
        st.category
          ? (st.category === "__NO_CAT__" ? "Без категорії" : st.category)
          : "Усі"
      ),
    {
      parse_mode: "Markdown",
      reply_markup: { inline_keyboard: rows },
    }
  );
}

function makeMoveId() {
  // простий стабільний id без залежностей
  return `MAT_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
}

export const MaterialsFlow: FlowModule = {
  flow: FLOW as any,
  menuText: TEXTS.buttons.materials,
  cbPrefix: PREFIX,

  async start(bot, chatId, s) {
    s.flow = FLOW as any;
    setFlowState(s, FLOW as any, initState() as any); // без messageId: undefined
    await this.render(bot, chatId, s);
  },

  async render(bot, chatId, s) {
    const st = getFlowState<State>(s, FLOW as any);
    if (!st) return;
    await render(bot, chatId, s, st);
  },

  async onCallback(bot, q, s, data) {
    const chatId = q.message?.chat.id;
    const actorTgId = q.from.id;
    if (typeof chatId !== "number") return false;


    const st = getFlowState<State>(s, FLOW as any);
    if (!st) return false;

    if (data === ACT.CANCEL) {
      clearFlowState(s, FLOW as any);
      delete s.flow;
await bot.sendMessage(chatId, TEXTS.materialsFlow.messages.canceled);
      return true;
    }

    if (data === ACT.CAT_CLEAR) {
  setFlowState(s, FLOW as any, {
    ...st,
    category: undefined,
    materialId: undefined,
    qty: undefined,
    moveType: undefined,
    step: "PICK_MATERIAL",
  } as any);
  await render(bot, chatId, s, getFlowState<State>(s, FLOW as any)!);
  return true;
}

if (data.startsWith(ACT.CAT)) {
const raw = data.slice(ACT.CAT.length);
  const category = raw === "__NO_CAT__" ? "__NO_CAT__" : raw;

  setFlowState(s, FLOW as any, {
    ...st,
    category,
    materialId: undefined,
    qty: undefined,
    moveType: undefined,
    step: "PICK_MATERIAL",
  } as any);
  await render(bot, chatId, s, getFlowState<State>(s, FLOW as any)!);
  return true;
}


    if (data === ACT.DATE_TODAY) {
setFlowState(s, FLOW as any, { ...st, date: todayISO(), step: "PICK_OBJECT" } as any);
      await render(bot, chatId, s, getFlowState<State>(s, FLOW as any)!);
      return true;
    }

    if (data.startsWith(ACT.CAT)) {
      const raw = decodeURIComponent(data.slice(ACT.CAT.length));
      const category = raw === "__NO_CAT__" ? "__NO_CAT__" : raw;

      setFlowState(s, FLOW as any, { ...st, category, step: "PICK_MATERIAL" } as any);
      await render(bot, chatId, s, getFlowState<State>(s, FLOW as any)!);
      return true;
    }

    if (data === ACT.DATE_YESTERDAY) {
setFlowState(s, FLOW as any, { ...st, date: yesterdayISO(), step: "PICK_OBJECT" } as any);
      await render(bot, chatId, s, getFlowState<State>(s, FLOW as any)!);
      return true;
    }

    if (data === ACT.PICK_CAT) {
  setFlowState(s, FLOW as any, { ...st, step: "PICK_CATEGORY" } as any);
  await render(bot, chatId, s, getFlowState<State>(s, FLOW as any)!);
  return true;
}


if (data.startsWith(ACT.OBJ)) {
  const objectId = data.slice(ACT.OBJ.length);

  const objects = await fetchObjects();
  const obj = objects.find((o: any) => String(o.id) === String(objectId));

  setFlowState(s, FLOW as any, {
    ...st,
    objectId,
    objectName: obj?.name ?? objectId,
    step: "PICK_CATEGORY",
  } as any);

  await render(bot, chatId, s, getFlowState<State>(s, FLOW as any)!);
  return true;
}

if (data.startsWith(ACT.MAT)) {
  const materialId = data.slice(ACT.MAT.length);

  const mats = await fetchMaterials();
  const mat = mats.find(m => m.id === materialId);

  setFlowState(s, FLOW as any, {
    ...st,
    materialId,
    materialName: mat?.name ?? materialId,
    step: "ENTER_QTY"
  } as any);

  await bot.sendMessage(
    chatId,
    `📦 Матеріал: *${mat?.name ?? materialId}*\n\nВведи кількість в чат.`,
    {
      parse_mode: "Markdown",
      reply_markup: {
        force_reply: true,
        input_field_placeholder: "Введи кількість...",
      },
    }
  );

  return true;
}

if (data === ACT.DONE_MATERIALS) {
  if (!st.items.length) {
    await bot.sendMessage(chatId, "Спочатку вибери хоча б один матеріал.");
    return true;
  }

  setFlowState(s, FLOW as any, {
    ...st,
    step: "PICK_TYPE",
  } as any);

  await render(bot, chatId, s, getFlowState<State>(s, FLOW as any)!);
  return true;
}

    if (data.startsWith(ACT.TYPE)) {
      const moveType = data.slice(ACT.TYPE.length) as MoveType;
setFlowState(s, FLOW as any, { ...st, moveType, step: "REVIEW" } as any);
      await render(bot, chatId, s, getFlowState<State>(s, FLOW as any)!);
      return true;
    }

if (data === ACT.SAVE) {
  const cur = getFlowState<State>(s, FLOW as any)!;

  if (!cur.objectId || !(cur.items ?? []).length || !cur.moveType) {
    await bot.sendMessage(chatId, TEXTS.materialsFlow.errors.notAllFilled);
    return true;
  }

  const ds = await getDayStatusRow(cur.date, cur.objectId, actorTgId);
  if (isLocked(ds?.status)) {
    await bot.sendMessage(
      chatId,
      TEXTS.materialsFlow.errors.locked.replace(
        "{status}",
        String(ds?.status ?? TEXTS.ui.symbols.unknown)
      )
    );
    return true;
  }

  const mats = await fetchMaterials();

  const rows: MaterialMoveRow[] = cur.items.map((item) => {
    const mat = mats.find((m) => String(m.id) === String(item.materialId)) as MaterialRow | undefined;

    return {
      moveId: makeMoveId(),
      time: new Date().toISOString(),
      date: cur.date,
      objectId: cur.objectId!,
      foremanTgId: actorTgId,
      materialId: item.materialId,
      materialName: mat?.name ?? item.materialName,
      qty: item.qty ?? null,
      unit: mat?.unit ?? item.unit ?? "",
      moveType: cur.moveType as any,
      purpose: cur.purpose ?? "",
      photos: "",
      payload: "",
      dayStatus: "",
      updatedAt: new Date().toISOString(),
    };
  });

  await appendMaterialMoves(rows);
  await refreshDayChecklist(cur.date, cur.objectId, actorTgId);

  clearFlowState(s, FLOW as any);
  delete s.flow;

  await bot.sendMessage(chatId, TEXTS.materialsFlow.messages.saved);
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

    // пусто або ?
if (!text || text === "?") {
  setFlowState(s, FLOW as any, {
    ...st,
    items: [
      ...(st.items ?? []),
      {
        materialId: st.materialId!,
        materialName: st.materialName!,
        qty: null,
      },
    ],
    materialId: undefined,
    materialName: undefined,
    qty: undefined,
    step: "PICK_MATERIAL",
  } as any);

  await render(bot, chatId, s, getFlowState<State>(s, FLOW as any)!);
  return true;
}

    const n = Number(text.replace(",", "."));
    if (!Number.isFinite(n) || n < 0) {
await bot.sendMessage(chatId, TEXTS.materialsFlow.errors.enterNumberOrQ);
      return true;
    }

setFlowState(s, FLOW as any, {
  ...st,
  items: [
    ...st.items,
    {
      materialId: st.materialId!,
      materialName: st.materialName!,
      qty: n,
    },
  ],
  materialId: undefined,
  materialName: undefined,
  qty: undefined,
  step: "PICK_MATERIAL",
} as any);

const newSt = getFlowState<State>(s, FLOW as any)!;
await sendNewMaterialsScreen(bot, chatId, newSt);
return true;
  },
};
