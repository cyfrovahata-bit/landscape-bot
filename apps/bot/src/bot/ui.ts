import TelegramBot from "node-telegram-bot-api";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { config } from "../config.js";
import { TEXTS } from "./texts.js";
import { CB } from "./core/cb.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ===== INLINE: кнопка відкриття Mini App =====
// Opens the Mini App as a Telegram Web App -- everything that used to be the
// bottom ReplyKeyboard menu (Логістика/Дорожній табель/...) now lives there.
// Falls back to the old menu callback if PUBLIC_APP_URL isn't configured yet,
// so the bot doesn't dead-end before that env var is set.
export const OPEN_APP_INLINE: TelegramBot.InlineKeyboardMarkup = {
  inline_keyboard: [
    [
      config.miniAppUrl
        ? { text: TEXTS.menu.openApp, web_app: { url: config.miniAppUrl } }
        : { text: TEXTS.menu.openApp, callback_data: CB.START_MENU },
    ],
  ],
};

// ===== ПРИВІТАЛЬНЕ ПОВІДОМЛЕННЯ + КНОПКА ВІДКРИТТЯ ЗАСТОСУНКУ =====
// Replaces the old two-step "welcome -> tap Розпочати -> ReplyKeyboard menu"
// flow: one message, with the Mini App link right on it. remove_keyboard
// clears any bottom keyboard a returning user still has pinned from before
// this change (can't combine remove_keyboard and an inline keyboard on the
// same message, hence the two calls).
export async function sendAppWelcome(bot: TelegramBot, chatId: number) {
  const text = `${TEXTS.welcome.title}\n\n${TEXTS.welcome.description}\n\n${TEXTS.welcome.action}`;
  const photoPath = path.join(__dirname, "../../images/welcome.png");

  try {
    if (fs.existsSync(photoPath)) {
      await bot.sendPhoto(chatId, photoPath, {
        caption: text,
        parse_mode: "Markdown",
        reply_markup: { remove_keyboard: true },
      });
    } else {
      await bot.sendMessage(chatId, text, { reply_markup: { remove_keyboard: true } });
    }
  } catch {
    await bot.sendMessage(chatId, text, { reply_markup: { remove_keyboard: true } }).catch(() => {});
  }

  await bot.sendMessage(chatId, TEXTS.menu.opened, { reply_markup: OPEN_APP_INLINE });
}

