import { createHmac, timingSafeEqual } from 'node:crypto';

export const SESSION_COOKIE = '__Host-greenhand_session';
const DAY = 86400;
export const SESSION_IDLE_SECONDS = 7 * DAY;
export const SESSION_MAX_SECONDS = 30 * DAY;
type Session = { userId: number; startedAt: number; expiresAt: number };

/** Authentication only: no roles or work data in the signed, HttpOnly cookie. */
export function appSessionCodec(secret: string) {
  const sign = (body: string) => createHmac('sha256', secret).update(`greenhand-session-v1:${body}`).digest('base64url');
  return {
    issue(userId: number, now: number, startedAt = now): string {
      if (!secret) throw new Error('Session signing is unavailable');
      const body = Buffer.from(JSON.stringify({ userId, startedAt, expiresAt: Math.min(now + SESSION_IDLE_SECONDS, startedAt + SESSION_MAX_SECONDS) })).toString('base64url');
      return `${body}.${sign(body)}`;
    },
    read(token: string | undefined, now: number): Session | null {
      if (!secret || !token || token.length > 1024) return null;
      const [body, signature, extra] = token.split('.');
      if (!body || !signature || extra) return null;
      const expected = Buffer.from(sign(body)), actual = Buffer.from(signature);
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
      try {
        const session = JSON.parse(Buffer.from(body, 'base64url').toString()) as Session;
        if (!Number.isSafeInteger(session.userId) || session.userId <= 0 || !Number.isSafeInteger(session.startedAt) ||
            !Number.isSafeInteger(session.expiresAt) || session.startedAt > now || session.expiresAt <= now ||
            now >= session.startedAt + SESSION_MAX_SECONDS || session.expiresAt > session.startedAt + SESSION_MAX_SECONDS) return null;
        return session;
      } catch { return null; }
    },
  };
}

export function sessionCookieValue(header = ''): string | undefined {
  return header.split(';').map(part => part.trim()).find(part => part.startsWith(`${SESSION_COOKIE}=`))?.slice(SESSION_COOKIE.length + 1);
}
