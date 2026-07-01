import TelegramBot from "node-telegram-bot-api";
import { config } from "./config.js";
import { onStart, handleCallback, handleMessage } from "./bot/wizard.js";
import { isSheetsQuotaError } from "./google/sheets/core.js";

const bot = new TelegramBot(config.botToken, { polling: true });

const SHEETS_QUOTA_TEXT =
  "Google Sheets тимчасово обмежив запити. Спробуйте ще раз через кілька секунд.";

function errorText(err: any) {
  return (
    err?.response?.body?.description ??
    err?.response?.body?.error?.message ??
    err?.message ??
    String(err)
  );
}

async function handleBotError(
  bot: TelegramBot,
  chatId: number | undefined,
  err: any,
  callbackQueryId?: string,
) {
  if (isSheetsQuotaError(err)) {
    console.warn(`[SHEETS][QUOTA] handled ${errorText(err)}`);
    if (callbackQueryId) {
      await bot
        .answerCallbackQuery(callbackQueryId, {
          text: SHEETS_QUOTA_TEXT,
          show_alert: true,
        })
        .catch(() => {});
    }
    if (chatId) {
      await bot.sendMessage(chatId, SHEETS_QUOTA_TEXT).catch(() => {});
    }
    return;
  }

  console.error("[BOT][ERROR]", errorText(err));
  if (callbackQueryId) {
    await bot
      .answerCallbackQuery(callbackQueryId, {
        text: "Сталася помилка. Спробуйте ще раз.",
        show_alert: true,
      })
      .catch(() => {});
  }
}

bot.onText(/\/start/, async (msg) => {
  try {
    await onStart(bot, msg);
  } catch (err) {
    await handleBotError(bot, msg.chat.id, err);
  }
});

bot.on("message", async (msg) => {
  if (msg.text?.startsWith("/")) return; // щоб /start не дублювався
  try {
    await handleMessage(bot, msg);
  } catch (err) {
    await handleBotError(bot, msg.chat.id, err);
  }
});

bot.on("callback_query", async (q) => {
  try {
    await handleCallback(bot, q);
  } catch (err) {
    await handleBotError(bot, q.message?.chat.id, err, q.id);
  }
});

bot.on("polling_error", (err) => {
  console.error("[BOT][POLLING_ERROR]", errorText(err));
});

process.on("unhandledRejection", (err) => {
  console.error("[BOT][UNHANDLED_REJECTION]", errorText(err));
});

console.log("Bot is running (polling)...");
