import type TelegramBot from "node-telegram-bot-api";
import { fetchUsers } from "../../google/sheets.js";
import { ensureSession } from "./session.js";

export type UserRole = "ADMIN" | "BRIGADIER";

function normRole(v: any): "ADMIN" | "BRIGADIER" | null {
  const raw = String(v ?? "").trim().toUpperCase();

  // ADMIN
  if (
    raw === "ADMIN" ||
    raw === "АДМІН" ||
    raw === "АДМИН" ||
    raw === "АДМІНІСТРАТОР" ||
    raw === "АДМИНИСТРАТОР"
  ) {
    return "ADMIN";
  }

  // BRIGADIER
  if (
    raw === "BRIGADIER" ||
    raw === "БРИГАДИР"
  ) {
    return "BRIGADIER";
  }

  return null;
}


function isTruthyActive(v: any) {
  const s = String(v ?? "").trim().toUpperCase();
  return s === "TRUE" || s === "1" || s === "YES" || s === "ON" || s === "АКТИВ" || s === "ТАК";
}

/**
 * Підтягує юзера з Google Sheets (КОРИСТУВАЧІ) у session:
 * - session.userTgId = actorTgId (msg.from.id)
 * - session.userRole = ADMIN|BRIGADIER
 *
 * Якщо юзер не знайдений або не активний — блокує (кидає помилку).
 */
export async function hydrateAuth(bot: TelegramBot, chatId: number, actorTgId: number) {
  const s = ensureSession(chatId);

  // кеш в сесії (щоб не читати Sheets кожен апдейт)
  if (s.userTgId === actorTgId && s.userRole) return s;

  const users = await fetchUsers();

  // ВАЖЛИВО: fetchUsers має повертати обʼєкти з полями tgId, role, active
  // Якщо у тебе інакше названо — скажеш, я піджену.
  const me = users.find((u: any) => Number(u.tgId) === Number(actorTgId) && isTruthyActive(u.active));

  if (!me) {
    await bot.sendMessage(
      chatId,
      "⛔️ Немає доступу.\nТвій TG_ID відсутній у листі КОРИСТУВАЧІ або АКТИВ = FALSE."
    );
    throw new Error("ACCESS_DENIED");
  }

const role = normRole(me.role);
if (!role) {
  await bot.sendMessage(
    chatId,
    `⛔️ Невірна роль у КОРИСТУВАЧІ: "${me.role}".\nОчікую: Адмін / Бригадир`
  );
  throw new Error("BAD_ROLE");
}

s.userRole = role;


  s.userTgId = actorTgId;
  s.userRole = role as UserRole;

  return s;
}
