import type TelegramBot from "node-telegram-bot-api";
import type { Flow, Session, FlowBaseState } from "./flowTypes.js";
import { getFlowState } from "./helpers.js";
import { upsertInline } from "./helpers.js";

export type FlowView = {
  text: string;
  kb?: TelegramBot.InlineKeyboardMarkup;
  parseMode?: TelegramBot.ParseMode; // default: "Markdown"
};

/**
 * Єдина точка для рендера/оновлення inline повідомлення flow.
 * - бере state
 * - просить view у callback
 * - робить upsertInline з дефолтними параметрами
 */
export async function renderFlow<TState extends FlowBaseState>(
  bot: TelegramBot,
  chatId: number,
  s: Session,
  flow: Flow,
  buildView: (st: TState) => FlowView | Promise<FlowView>
) {
  const st = getFlowState<TState>(s, flow);
  if (!st) return;

  const view = await buildView(st);

  // upsertInline зараз “зашитий” на Markdown.
  // Тому тут просто віддаємо text/kb як є.
  // Якщо захочеш підтримку parseMode — покажу як апдейтнути upsertInline.
  return upsertInline(bot, chatId, s, flow, view.text, view.kb);
}
