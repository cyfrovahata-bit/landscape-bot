import type { Session } from "./flowTypes.js";


const sessions = new Map<number, Session>();

export function ensureSession(chatId: number): Session {
  let s = sessions.get(chatId);
  if (!s) {
    s = { mode: "MENU", updatedAt: Date.now(), flows: {} };
    sessions.set(chatId, s);
  }
  return s;
}

export function resetSession(chatId: number) {
  sessions.set(chatId, { mode: "MENU", updatedAt: Date.now(), flows: {} });
}

export function getSessionsMap() {
  return sessions;
}

