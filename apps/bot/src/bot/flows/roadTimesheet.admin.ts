// src/bot/flows/roadTimesheet.admin.ts
import type TelegramBot from "node-telegram-bot-api";
import { fetchUsers } from "../../google/sheets/dictionaries.js";
import { getEventById, updateEventById, setDayStatus, fetchEvents, appendPayrollRows, fetchReportsForPayroll  } from "../../google/sheets/working.js";
import { cb } from "./roadTimesheet.cb.js";


type CallbackQuery = TelegramBot.CallbackQuery;

function pickObjectIdFromPayload(payloadRaw: string | undefined): string {
  try {
    const p = payloadRaw ? JSON.parse(String(payloadRaw)) : {};
    return String(
      p.objectId ??
      p.activeObjectId ??
      (Array.isArray(p.objectIds) ? p.objectIds[0] : "") ??
      ""
    ).trim();
  } catch {
    return "";
  }
}

async function resolveDayStatusObjectId(ev: any): Promise<string> {
  const direct = String(ev?.objectId ?? "").trim();
  if (direct) return direct;

  const fromPayload = pickObjectIdFromPayload(ev?.payload);
  if (fromPayload) return fromPayload;

  const sameDayEvents = await fetchEvents({
    date: String(ev?.date ?? "").trim(),
    foremanTgId: Number(ev?.foremanTgId ?? 0),
  });

  const candidates = [...sameDayEvents]
    .reverse()
    .map((x) => String(x.objectId ?? "").trim())
    .filter(Boolean);

  return candidates[0] ?? "";
}

async function buildPayrollRowsFromApprovedEvent(ev: any) {
  const p = ev?.payload ? JSON.parse(String(ev.payload)) : {};

  const employeeIds = String(ev.employeeIds || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);

  const reports = await fetchReportsForPayroll({
    date: String(ev.date ?? "").trim(),
    foremanTgId: Number(ev.foremanTgId),
    objectId: String(ev.objectId ?? "").trim(),
  });

  const rows: any[][] = [];
  let n = 1;

  for (const empId of employeeIds) {
    for (const r of reports) {
      rows.push([
        n++,
        empId,
        ev.objectId,
        r.workName,
        r.volume,
        "",
        "",
        "",
        "",
        "",
        "",
      ]);
    }
  }

  return rows;
}

export async function handleRoadAdminCallbacks(args: {
  bot: TelegramBot;
  q: CallbackQuery;
  data: string;
}): Promise<boolean> {
  const { bot, q, data } = args;

  // ✅ ADMIN callbacks must work even if ROAD_TS state is missing (admin chat)
  const isAdminCb =
    data.startsWith(cb.ADM_APPROVE) ||
    data.startsWith(cb.ADM_RETURN) ||
    data.startsWith(cb.ADM_RETURN_REASON) ||
    data.startsWith(cb.ADM_RETURN_CANCEL);

  if (!isAdminCb) return false;

  const nowIso = new Date().toISOString();

  // --- admin check (без state) ---
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

  const adminChatId = q.message?.chat?.id;
  const adminMsgId = q.message?.message_id;

  async function safeEditAdmin(text: string) {
    if (typeof adminChatId !== "number" || typeof adminMsgId !== "number") return;
    try {
      await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: adminChatId, message_id: adminMsgId });
    } catch {}
    try {
      await bot.editMessageText(text, { chat_id: adminChatId, message_id: adminMsgId, parse_mode: "Markdown" });
    } catch {}
  }

  // CANCEL
  if (data.startsWith(cb.ADM_RETURN_CANCEL)) {
    const eventId = data.slice(cb.ADM_RETURN_CANCEL.length);
    await bot.answerCallbackQuery(q.id, { text: "✅ Скасовано" });
    await safeEditAdmin(`❎ *Повернення скасовано*\n🆔 Подія: *Логістика*`);
    return true;
  }

  // RETURN REASON
  if (data.startsWith(cb.ADM_RETURN_REASON)) {
    // формат: rts:adm:return_reason:<eventId>:<code>
    const rest = data.slice(cb.ADM_RETURN_REASON.length);
    const parts = rest.split(":");
    const reasonCode = parts.pop() || "OTHER";
    const eventId = parts.join(":");

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
      WRONG_ODO: "ODO некоректний",
      WRONG_PEOPLE: "Не ті люди",
      WRONG_OBJECTS: "Не ті обʼєкти",
      NO_PHOTO: "Нема фото",
      OTHER: "Інше",
    };
    const reasonText = reasonMap[reasonCode] ?? reasonMap.OTHER;

    await updateEventById(eventId, {
      status: "ПОВЕРНУТО",
      updatedAt: nowIso,
      // (опційно) можна записати reason у payload
      // payload: JSON.stringify({ ...(JSON.parse(ev.payload||"{}")), returnReason: reasonText, returnedAt: nowIso }),
    });

    const foremanTgId = Number(ev.foremanTgId);
if (Number.isFinite(foremanTgId) && foremanTgId > 0) {
  const objectId = await resolveDayStatusObjectId(ev);

  if (objectId) {

const safeReasonText = String(reasonText ?? "").trim();
    
await setDayStatus({
  date: String(ev.date ?? "").trim(),
  objectId,
  foremanTgId,
  status: "ПОВЕРНУТО",
  returnReason: safeReasonText,
});
  }
}

    await bot.sendMessage(
      targetChatId,
      `🔴 *Повернено адміністратором*\n📅 Дата: ${ev.date}\n🆔 Подія: *Робочий день*\n📝 Причина: *${reasonText}*\n\nВиправ і надішли знову.`,
      { parse_mode: "Markdown" }
    );

    await bot.answerCallbackQuery(q.id, { text: "🔴 Повернено" });
    await safeEditAdmin(`🔴 *Повернено*\n🆔 Подія: *Робочий день*\n📝 Причина: *${reasonText}*`);
    return true;
  }

  // RETURN (показати причини)
  if (data.startsWith(cb.ADM_RETURN)) {
    const eventId = data.slice(cb.ADM_RETURN.length);
    await bot.answerCallbackQuery(q.id, { text: "✍️ Обери причину" });

    if (typeof adminChatId === "number") {
      await bot.sendMessage(adminChatId, `🔴 *Повернення*\n🆔 Подія: *Робочий день*\n\nОбери причину:`, {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "📸 Нема фото", callback_data: `${cb.ADM_RETURN_REASON}${eventId}:NO_PHOTO` }],
            [{ text: "🔢 ODO некоректний", callback_data: `${cb.ADM_RETURN_REASON}${eventId}:WRONG_ODO` }],
            [{ text: "👥 Не ті люди", callback_data: `${cb.ADM_RETURN_REASON}${eventId}:WRONG_PEOPLE` }],
            [{ text: "🏗 Не ті обʼєкти", callback_data: `${cb.ADM_RETURN_REASON}${eventId}:WRONG_OBJECTS` }],
            [{ text: "❎ Скасувати", callback_data: `${cb.ADM_RETURN_CANCEL}${eventId}` }],
          ],
        },
      });
    }
    return true;
  }

  // APPROVE
// APPROVE
if (data.startsWith(cb.ADM_APPROVE)) {
  const eventId = data.slice(cb.ADM_APPROVE.length);

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

const foremanTgId = Number(ev.foremanTgId);
if (!Number.isFinite(foremanTgId) || foremanTgId <= 0) {
  await bot.answerCallbackQuery(q.id, { text: "❌ Некоректний foremanTgId", show_alert: true });
  return true;
}

const objectId = await resolveDayStatusObjectId(ev);
if (!objectId) {
  await bot.answerCallbackQuery(q.id, { text: "❌ Не вдалося визначити objectId", show_alert: true });
  return true;
}

await setDayStatus({
  date: String(ev.date ?? "").trim(),
  objectId,
  foremanTgId,
  status: "ЗАТВЕРДЖЕНО",
  approvedBy: String(q.from.id),
  approvedAt: nowIso,
});

  const evUpdated = await getEventById(eventId);
  if (!evUpdated) {
    await bot.answerCallbackQuery(q.id, { text: "❌ Не вдалося перечитати подію", show_alert: true });
    return true;
  }
 
  const payrollRows = await buildPayrollRowsFromApprovedEvent(evUpdated);

if (payrollRows.length > 0) {
  await appendPayrollRows(payrollRows);
}
  
const { buildRoadApprovedShortText, sendLongHtml } = await import("./roadTimesheet.utils.js");

const approvedText = buildRoadApprovedShortText(evUpdated, {
  title: "✅ *День затверджено*",
});

  try {
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