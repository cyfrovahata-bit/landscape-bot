import type TelegramBot from "node-telegram-bot-api";
import { getFlowState, setFlowState, todayISO } from "../core/helpers.js";
import { fetchUsers } from "../../google/sheets/dictionaries.js";
import { getEventById, updateEventById } from "../../google/sheets/working.js";
import {
  appendAccountingReportForApprovedRoadEvent,
  resolveApprovedRoadEvent,
} from "../../google/sheets/accounting.js";
import type { State } from "./roadTimesheet.types.js";
import { cb, FLOW } from "./roadTimesheet.cb.js";
import {
  buildRoadApprovedShortText,
  safeEditMessageText,
  sendLongHtml,
  uniq,
} from "./roadTimesheet.utils.js";

export async function handleRoadApprovalCallbacks(args: {
  bot: TelegramBot;
  q: TelegramBot.CallbackQuery;
  s: any;
  data: string;
}): Promise<boolean> {
  const { bot, q, s, data } = args;

  if (
    !data.startsWith(cb.ADM_APPROVE) &&
    !data.startsWith(cb.ADM_RETURN) &&
    !data.startsWith(cb.ADM_RETURN_REASON) &&
    !data.startsWith(cb.ADM_RETURN_CANCEL)
  ) {
    return false;
  }

  const nowIso = new Date().toISOString();
  const users = await fetchUsers();
  const usersNorm = (users ?? [])
    .map((u: any) => ({
      tgId: Number(u.tgId) || 0,
      role: String(u.role ?? ""),
      active: Boolean(u.active),
    }))
    .filter((u: any) => u.tgId > 0 && u.active);

  const role = String(
    usersNorm.find((u: any) => u.tgId === Number(q.from.id))?.role ?? "",
  )
    .toUpperCase()
    .trim();

  const isAdmin = role.includes("АДМІН") || role.includes("ADMIN");
  if (!isAdmin) {
    await bot.answerCallbackQuery(q.id, {
      text: "⛔️ Тільки адміністратор",
      show_alert: true,
    });
    return true;
  }

  const adminChatId = q.message?.chat?.id;
  const adminMsgId = q.message?.message_id;

  async function safeEditAdmin(text: string) {
    if (typeof adminChatId !== "number" || typeof adminMsgId !== "number")
      return;
    try {
      await bot.editMessageReplyMarkup(
        { inline_keyboard: [] },
        { chat_id: adminChatId, message_id: adminMsgId },
      );
    } catch {}
    try {
      await safeEditMessageText(bot, adminChatId, adminMsgId, text, {
        parse_mode: "Markdown",
      });
    } catch {}
  }

  if (data.startsWith(cb.ADM_RETURN_CANCEL)) {
    const eventId = data.slice(cb.ADM_RETURN_CANCEL.length);
    await bot.answerCallbackQuery(q.id, { text: "✅ Скасовано" });
    await safeEditAdmin(
      `❎ *Повернення скасовано*\n🆔 Подія: *Робочий день*`,
    );
    return true;
  }

  if (data.startsWith(cb.ADM_RETURN_REASON)) {
    const rest = data.slice(cb.ADM_RETURN_REASON.length);
    const parts = rest.split(":");
    const reasonCode = parts.pop() || "OTHER";
    const eventId = parts.join(":");

    const ev = await getEventById(eventId);
    if (!ev) {
      await bot.answerCallbackQuery(q.id, {
        text: "❌ Подію не знайдено",
        show_alert: true,
      });
      return true;
    }

    const targetChatId =
      Number(ev.chatId) > 0 ? Number(ev.chatId) : Number(ev.foremanTgId);
    if (!Number.isFinite(targetChatId) || targetChatId <= 0) {
      await bot.answerCallbackQuery(q.id, {
        text: "⚠️ Нема куди відправити бригадиру",
        show_alert: true,
      });
      return true;
    }

    const reasonMap: Record<string, string> = {
      WRONG_ODO: "ODO некоректний",
      WRONG_PEOPLE: "Не ті люди",
      WRONG_OBJECTS: "Не ті обʼєкти",
      WRONG_QTY: "Невірні обсяги",
      NO_PHOTO: "Нема фото",
      OTHER: "Інше",
    };
    const reasonText = reasonMap[reasonCode] ?? reasonMap.OTHER;

    await updateEventById(eventId, {
      status: "ПОВЕРНУТО",
      updatedAt: nowIso,
    });

    const targetForemanTgId = Number(ev.foremanTgId) || 0;

if (targetForemanTgId > 0) {
  const root2 = getFlowState<Record<number, State>>(s, FLOW) || {};
  const st2 = root2[targetForemanTgId] as any;

  if (st2) {
    st2.submittedForApproval = false;
    st2.adminReviewEventId = "";


st2.submittedForApproval = false;
st2.adminReviewEventId = "";
st2.step = "RETURN_EDIT_OBJECTS" as any;

(st2 as any).editReturned = true;
(st2 as any).editAddedPeopleIds = [];
(st2 as any).editRemovedPeopleIds = [];
(st2 as any).editOriginalPeopleIds = uniq([
  ...((st2.members ?? []).map((m: any) => String(m.employeeId)).filter(Boolean)),
  ...((st2.inCarIds ?? []).map(String).filter(Boolean)),
]);



    root2[targetForemanTgId] = st2;
    setFlowState(s, FLOW, root2);
  }
}

await bot.sendMessage(
  targetChatId,
  `🔴 *День повернено адміністратором*\n📅 Дата: ${ev.date}\n📝 Причина: *${reasonText}*\n\nРедагування знову доступне. Відкрий меню робочого дня, виправ дані і надішли повторно.`,
  { parse_mode: "Markdown" },
);

    await bot.answerCallbackQuery(q.id, { text: "🔴 Повернено" });
    await safeEditAdmin(
      `🔴 *Повернено*\n🆔 Подія: *Робочий день*\n📝 Причина: *${reasonText}*`,
    );
    return true;
  }

  if (data.startsWith(cb.ADM_RETURN)) {
    const eventId = data.slice(cb.ADM_RETURN.length);
    await bot.answerCallbackQuery(q.id, { text: "✍️ Обери причину" });

    if (typeof adminChatId === "number") {
      await bot.sendMessage(
        adminChatId,
        `🔴 *Повернення*\n🆔 Подія: *Робочий день*\n\nОбери причину:`,
        {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: "📸 Нема фото",
                  callback_data: `${cb.ADM_RETURN_REASON}${eventId}:NO_PHOTO`,
                },
              ],
              [
                {
                  text: "🔢 ODO некоректний",
                  callback_data: `${cb.ADM_RETURN_REASON}${eventId}:WRONG_ODO`,
                },
              ],
              [
                {
                  text: "👥 Не ті люди",
                  callback_data: `${cb.ADM_RETURN_REASON}${eventId}:WRONG_PEOPLE`,
                },
              ],
              [
                {
                  text: "🏗 Не ті обʼєкти",
                  callback_data: `${cb.ADM_RETURN_REASON}${eventId}:WRONG_OBJECTS`,
                },
              ],
              [
  {
    text: "🧮 Невірні обсяги",
    callback_data: `${cb.ADM_RETURN_REASON}${eventId}:WRONG_QTY`,
  },
],
              [
                {
                  text: "❎ Скасувати",
                  callback_data: `${cb.ADM_RETURN_CANCEL}${eventId}`,
                },
              ],
            ],
          },
        },
      );
    }
    return true;
  }

  if (data.startsWith(cb.ADM_APPROVE)) {
    const eventId = data.slice(cb.ADM_APPROVE.length);

    const ev = await getEventById(eventId);
    if (!ev) {
      await bot.answerCallbackQuery(q.id, {
        text: "❌ Подію не знайдено",
        show_alert: true,
      });
      return true;
    }

    const resolved = await resolveApprovedRoadEvent({
      eventId: ev.eventId,
      date: ev.date,
      foremanTgId: ev.foremanTgId,
      payload: ev.payload,
      ts: ev.ts,
      status: ev.status,
      chatId: ev.chatId,
      msgId: ev.msgId,
      type: ev.type,
      objectId: ev.objectId,
      carId: ev.carId,
      employeeIds: ev.employeeIds,
      refEventId: ev.refEventId,
      updatedAt: ev.updatedAt,
    });

    const approvedEv = resolved.event;
    const targetChatId =
      Number(approvedEv.chatId) > 0 ? Number(approvedEv.chatId) : Number(approvedEv.foremanTgId);
    if (!Number.isFinite(targetChatId) || targetChatId <= 0) {
      await bot.answerCallbackQuery(q.id, {
        text: "⚠️ Нема куди відправити бригадиру",
        show_alert: true,
      });
      return true;
    }

    console.log(
      [
        "[accounting] approve resolve",
        `callbackEventId=${eventId}`,
        `resolvedEventId=${approvedEv.eventId}`,
        `isResubmission=${resolved.isResubmission}`,
        `savesCount=${resolved.savesCount}`,
        `date=${approvedEv.date}`,
        `foremanTgId=${approvedEv.foremanTgId}`,
      ].join(" "),
    );

    await updateEventById(approvedEv.eventId, {
      status: "ЗАТВЕРДЖЕНО",
      updatedAt: nowIso,
    });

    await appendAccountingReportForApprovedRoadEvent({
      eventId: approvedEv.eventId,
      date: approvedEv.date,
      foremanTgId: approvedEv.foremanTgId,
      payload: approvedEv.payload,
    }).catch((e: any) => {
      console.log(
        `[accounting] failed eventId=${approvedEv.eventId}: ${e?.message ?? String(e)}`,
      );
    });

    const targetForemanTgId = Number(approvedEv.foremanTgId) || 0;

if (targetForemanTgId > 0) {
  const root2 = getFlowState<Record<number, State>>(s, FLOW) || {};

  root2[targetForemanTgId] = {
    step: "START",
    date: todayISO(),
    phase: "SETUP",
    plannedObjectIds: [],
    objects: {},
    inCarIds: [],
    members: [],
    driveActive: false,
    returnActive: false,
    qtyUnlocked: false,
  } as State;

  setFlowState(s, FLOW, root2);
}

const approvedText = buildRoadApprovedShortText(approvedEv as any, {
  title: "✅ *День затверджено*",
});

try {
  if (typeof adminChatId === "number") {
    await bot.sendMessage(
      adminChatId,
      [
        `DEBUG APPROVE`,
        `eventId=${approvedEv.eventId}`,
        `callbackEventId=${eventId}`,
        `targetChatId=${targetChatId}`,
        `ev.chatId=${approvedEv?.chatId}`,
        `ev.foremanTgId=${approvedEv?.foremanTgId}`,
        `payloadLen=${String(approvedEv?.payload ?? "").length}`,
      ].join("\n"),
    ).catch(() => {});

    await bot.sendMessage(
      adminChatId,
      `approvedTextLen=${approvedText.length}`,
    ).catch(() => {});
  }

  await sendLongHtml(bot, targetChatId, approvedText, {
    disable_web_page_preview: true,
  });
} catch (e: any) {
  const errText =
    e?.response?.body?.description ??
    e?.message ??
    String(e);

  await bot.sendMessage(
    targetChatId,
    `✅ День затверджено адміністратором.\n⚠️ Не зміг надіслати підсумок.`,
  ).catch(() => {});

  if (typeof adminChatId === "number") {
    await bot.sendMessage(
      adminChatId,
      `⚠️ Не зміг надіслати підсумок бригадиру (chatId=${targetChatId}).\nПричина: ${errText}`.slice(0, 3500),
    ).catch(() => {});
  }
}
    await bot.answerCallbackQuery(q.id, { text: "✅ Затверджено" });
    await safeEditAdmin(`✅ *Затверджено*\n🆔 Подія: *Робочий день*`);
    return true;
  }

  return true;
}
