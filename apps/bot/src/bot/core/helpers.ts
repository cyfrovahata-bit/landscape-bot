import type TelegramBot from "node-telegram-bot-api";
import type { Flow, FlowBaseState, Session } from "./flowTypes.js";


export function getFlowState<T>(
  s: Session,
  flow: Flow
): (T & FlowBaseState) | undefined {
  return s.flows[flow] as any;
}

export function setFlowState<T extends FlowBaseState>(s: Session, flow: Flow, patch: T) {
  s.flows[flow] = { ...(s.flows[flow] || {}), ...patch } as any;
}

export function clearFlowState(s: Session, flow: Flow) {
  delete s.flows[flow];
}
function escapeMdV2(s: string) {
  return s.replace(/[_*\[\]()~`>#+\-=|{}.!\\]/g, "\\$&");
}



export async function upsertInline(
  bot: TelegramBot,
  chatId: number,
  s: Session,
  flow: Flow,
  text: string,
  reply_markup?: TelegramBot.InlineKeyboardMarkup
) {
  const st = getFlowState<FlowBaseState>(s, flow) as any;
  if (!st) return;

  // ✅ Пріоритет: uiMsgId (екран поточного UI), fallback: messageId (старі флови)
  const msgId = st.uiMsgId ?? st.messageId;

  // Якщо нема що редагувати — шлемо нове і запам’ятовуємо як UI
  if (!msgId) {
const msg = await bot.sendMessage(chatId, text, {
  reply_markup,
});


    // ✅ записуємо в uiMsgId, і паралельно в messageId для сумісності
    st.uiMsgId = msg.message_id;
    st.messageId = msg.message_id;
    return;
  }

  try {
await bot.editMessageText(text, {
  chat_id: chatId,
  message_id: msgId,
  reply_markup,
});


    // ✅ синхронізуємо (щоб не роз’їхалось)
    st.uiMsgId = msgId;
    st.messageId = msgId;
  } catch {
    const msg = await bot.sendMessage(chatId, text, {
      reply_markup,
      parse_mode: "Markdown",
    });

    st.uiMsgId = msg.message_id;
    st.messageId = msg.message_id;
  }
}


export function todayISO(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Kyiv",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date()); // YYYY-MM-DD
}

export function kb(rows: TelegramBot.InlineKeyboardButton[][]): TelegramBot.InlineKeyboardMarkup {
  return { inline_keyboard: rows };
}

export function mdEscape(s: string) {
  // простий escape під Markdown (як у тебе було в flow)
  return String(s).replace(/([_*[\]()`])/g, "\\$1");
}

export function uniq<T>(arr: T[]) {
  return Array.from(new Set(arr));
}

export function clampCoef01(x: number) {
  const v = Math.round(x * 10) / 10; // крок 0.1
  if (!Number.isFinite(v)) return 1.0;
  return Math.min(3, Math.max(0.1, v));
}

export function parseCoef(text: string): number | undefined {
  const cleaned = String(text ?? "").trim().replace(",", ".");
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return undefined;
  if (n < 0.1 || n > 3) return undefined;
  return Math.round(n * 100) / 100;
}

export function isLocked(status?: string) {
  const s = String(status || "").toUpperCase();
  return s === "ЗДАНО" || s === "ЗАТВЕРДЖЕНО";
}