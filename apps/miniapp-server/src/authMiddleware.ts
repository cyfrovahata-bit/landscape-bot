import type { Request, Response, NextFunction } from "express";
import { validateInitData, db, schema, config } from "@landscape/core";
import { eq } from "drizzle-orm";
import { appSessionCodec, SESSION_COOKIE, SESSION_IDLE_SECONDS, sessionCookieValue } from './lib/appSession.js';

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

/**
 * The app has exactly two levels of access: admins, who approve days and see
 * the money, and everyone else, who fill in their own days. So the РОЛЬ column
 * in КОРИСТУВАЧІ only has to answer one question -- is this person an admin --
 * and anything that isn't one is a brigadier.
 *
 * Defaulting instead of rejecting is deliberate. The old version accepted only
 * an exact "АДМІН"/"БРИГАДИР" and locked out anything else, so a perfectly
 * legitimate job title in that column ("Керівник ландшафту") meant the person
 * simply could not open the app, with nothing on screen to explain why. Access
 * is still gated -- the row must exist in КОРИСТУВАЧІ and be АКТИВ -- this
 * only stops the wording of a job title from being a second, invisible gate.
 *
 * Matched on a word boundary rather than the whole cell, so "Адміністратор"
 * and "головний адмін" both grant admin. Admin is kept the narrow, explicit
 * side of the check: mistaking a brigadier for an admin would hand them
 * approval of payroll, while the reverse only costs them a button.
 */
export function normRole(v: string): "ADMIN" | "BRIGADIER" {
  const raw = v.trim().toUpperCase();
  return /(^|\s)(АДМІН|АДМИН|ADMIN)/.test(raw) ? "ADMIN" : "BRIGADIER";
}

/**
 * Validates the Telegram Mini App `initData` sent as a header, then checks
 * the user against the КОРИСТУВАЧІ dictionary (mirrored in Postgres) exactly
 * like the bot's hydrateAuth does — same access rules, same source of truth.
 */
export function createTelegramAuth(options: {
  secret: string;
  validate: typeof validateInitData;
  findUser: (id: number) => Promise<{ tgId: bigint; pib: string; role: string; active: boolean } | undefined>;
  now?: () => number;
}) {
  const sessions = appSessionCodec(options.secret);
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const now = Math.floor((options.now?.() ?? Date.now()) / 1000);
      const validated = options.validate(req.header('x-telegram-init-data') ?? '');
      const session = sessions.read(sessionCookieValue(req.header('cookie')), now);
      // A freshly authenticated Telegram account takes precedence over an older account cookie.
      const sameAccount = !validated || validated.user.id === session?.userId;
      const usableSession = sameAccount ? session : null;
      const userId = validated?.user.id ?? usableSession?.userId;
      if (!userId) { res.status(401).json({ error: 'Telegram sign-in required' }); return; }
      if (!validated && !['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
        const origin = req.header('origin');
        let sameOrigin = !origin;
        try { if (origin) sameOrigin = new URL(origin).host === req.get('host') && new URL(origin).protocol === 'https:'; } catch { sameOrigin = false; }
        if (req.header('x-greenhand-client') !== 'miniapp' || !sameOrigin) {
          res.status(403).json({ error: 'Invalid session request origin' }); return;
        }
      }
      // Recheck current account access on every request, including requests with a valid session.
      const row = await options.findUser(userId);
      if (!row || !row.active) { res.status(403).json({ error: 'Access denied: not in КОРИСТУВАЧІ or inactive' }); return; }
      req.user = { tgId: Number(row.tgId), pib: row.pib, role: normRole(row.role) };
      // Renew at most twice daily. Absolute expiry still requires a fresh Telegram login.
      if (!usableSession || usableSession.expiresAt - now < SESSION_IDLE_SECONDS - 12 * 3600) {
        const token = sessions.issue(userId, now, usableSession?.startedAt);
        const renewed = sessions.read(token, now)!;
        // Telegram Web may embed the app: partition the cookie to that top-level site.
        // Cookie-authenticated mutations still require our custom header and exact origin above.
        res.cookie(SESSION_COOKIE, token, { httpOnly: true, secure: true, sameSite: 'none', partitioned: true, path: '/', maxAge: (renewed.expiresAt - now) * 1000 });
      }
      res.set('Cache-Control', 'no-store');
      next();
    } catch (error) { next(error); }
  };
}

export const requireTelegramAuth = createTelegramAuth({ secret: config.botToken, validate: validateInitData,
  findUser: async id => (await db.select().from(schema.users).where(eq(schema.users.tgId, BigInt(id))).limit(1))[0],
});
