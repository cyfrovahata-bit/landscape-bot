import TelegramBot from "node-telegram-bot-api";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { TEXTS } from "./texts.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ===== INLINE: кнопка "Розпочати" (тільки для welcome) =====
export const START_INLINE_MENU: TelegramBot.InlineKeyboardMarkup = {
  inline_keyboard: [[{ text: TEXTS.buttons.start, callback_data: "start_menu" }]],
};

// ===== REPLY: ГОЛОВНЕ МЕНЮ (кнопки внизу, як “головне меню”) =====
export const MAIN_MENU: TelegramBot.ReplyKeyboardMarkup = {
  keyboard: [
    [{ text: TEXTS.buttons.logistics }],
    [{ text: TEXTS.buttons.roadTimesheet }],
    [{ text: TEXTS.buttons.stats }],
    [{ text: TEXTS.buttons.materials }],
  ],
  resize_keyboard: true,
  one_time_keyboard: false,
};


// ===== ПРИВІТАЛЬНЕ ПОВІДОМЛЕННЯ =====
export async function sendWelcome(bot: TelegramBot, chatId: number) {
  const text =
  `${TEXTS.welcome.title}\n\n` +
  `${TEXTS.welcome.description}\n\n` +
  `${TEXTS.welcome.action}`;
  const photoPath = path.join(__dirname, "../../images/welcome.png");

  try {
    if (fs.existsSync(photoPath)) {
      await bot.sendPhoto(chatId, photoPath, {
        caption: text,
        parse_mode: "Markdown",
        reply_markup: START_INLINE_MENU,
      });
    } else {
      await bot.sendMessage(chatId, text, {
        
        reply_markup: START_INLINE_MENU,
      });
    }
  } catch (err) {
    await bot.sendMessage(chatId, text, {
      
      reply_markup: START_INLINE_MENU,
    });
  }
}

// ===== ПОКАЗАТИ ГОЛОВНЕ МЕНЮ (ReplyKeyboard) =====
export async function showMainMenu(bot: TelegramBot, chatId: number) {
  return bot.sendMessage(chatId, TEXTS.menu.opened, {
    reply_markup: MAIN_MENU,
  });
}

