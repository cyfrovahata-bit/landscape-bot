import type { Request, Response, NextFunction } from "express";
import { validateInitData, db, schema } from "@landscape/core";
import { eq } from "drizzle-orm";

export type AuthedUser = {
  tgId: number;
  pib: string;
  role: "ADMIN" | "BRIGADIER";
};

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthedUser;
    }
  }
}

export function normRole(v: string): "ADMIN" | "BRIGADIER" | null {
  const raw = v.trim().toUpperCase();
  if (["ADMIN", "АДМІН", "АДМИН", "АДМІНІСТРАТОР", "АДМИНИСТРАТОР"].includes(raw)) return "ADMIN";
  if (["BRIGADIER", "БРИГАДИР"].includes(raw)) return "BRIGADIER";
  return null;
}

/**
 * Validates the Telegram Mini App `initData` sent as a header, then checks
 * the user against the КОРИСТУВАЧІ dictionary (mirrored in Postgres) exactly
 * like the bot's hydrateAuth does — same access rules, same source of truth.
 */
export async function requireTelegramAuth(req: Request, res: Response, next: NextFunction) {
  const initData = req.header("x-telegram-init-data");
  if (!initData) {
    res.status(401).json({ error: "Missing X-Telegram-Init-Data header" });
    return;
  }

  const validated = validateInitData(initData);
  if (!validated) {
    res.status(401).json({ error: "Invalid or expired Telegram initData" });
    return;
  }

  const [row] = await db.select().from(schema.users).where(eq(schema.users.tgId, BigInt(validated.user.id))).limit(1);

  if (!row || !row.active) {
    res.status(403).json({ error: "Access denied: not in КОРИСТУВАЧІ or inactive" });
    return;
  }

  const role = normRole(row.role);
  if (!role) {
    res.status(403).json({ error: `Unknown role "${row.role}"` });
    return;
  }

  req.user = { tgId: Number(row.tgId), pib: row.pib, role };
  next();
}
