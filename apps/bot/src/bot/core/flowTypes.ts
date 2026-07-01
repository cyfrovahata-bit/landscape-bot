import type TelegramBot from "node-telegram-bot-api";

export type Mode = "MENU" | "FLOW";

export type Flow =
  | "LOGISTICS"
  | "ROAD"
  | "BRIGADE"
  | "ADD_WORK"
  | "MATERIALS"
  | "TOOLS"
  | "EDIT_DELETE"
  | "CLOSE_DAY"
  | "DAY_STATUS"
  | "PEOPLE_TIMESHEET"
  | "ROAD_TS"
  | "TIMESHEET";

export type FlowBaseState = {
  messageId?: number;
};



export type Session = {
  mode: Mode;
  flow?: Flow;
  updatedAt: number;
  flows: Partial<Record<Flow, FlowBaseState & Record<string, any>>>;
  userTgId?: number;
  userRole?: "ADMIN" | "BRIGADIER";
};

export type FlowModule = {
  flow: Flow;
  menuText: string;
  cbPrefix: string;

  start: (bot: TelegramBot, chatId: number, s: Session) => Promise<void>;
  render: (bot: TelegramBot, chatId: number, s: Session) => Promise<void>;

  onCallback: (
    bot: TelegramBot,
    q: TelegramBot.CallbackQuery,
    s: Session,
    data: string
  ) => Promise<boolean>;

  onMessage?: (
    bot: TelegramBot,
    msg: TelegramBot.Message,
    s: Session
  ) => Promise<boolean>;
};


