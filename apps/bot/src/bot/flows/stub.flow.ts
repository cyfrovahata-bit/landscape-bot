import type TelegramBot from "node-telegram-bot-api";
import type { Flow, FlowModule } from "../core/flowTypes.js";
import { getFlowState, setFlowState } from "../core/helpers.js";

export const StubFlow = (flow: Flow, menuText: string, cbPrefix: string): FlowModule => ({
  flow,
  menuText,
  cbPrefix,

  start: async (bot: TelegramBot, chatId: number, s) => {
    s.mode = "FLOW";
    s.flow = flow;

    if (!getFlowState(s, flow)) setFlowState(s, flow, {});

    await bot.sendMessage(
      chatId,
      `🚧 ${menuText} — ще в розробці.\nНапиши "меню", щоб повернутись.`
    );
  },

  render: async () => {},

  onCallback: async () => false,
});
