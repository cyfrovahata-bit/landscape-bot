import { createHmac } from "node:crypto";
import { config } from "./config.js";

export type TelegramWebAppUser = {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
  language_code?: string;
};

export type ValidatedInitData = {
  user: TelegramWebAppUser;
  authDate: number;
};

/**
 * Validates Telegram Mini App `initData` per Telegram's documented algorithm:
 * https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 * Returns the parsed user on success, or null if the signature is invalid/expired.
 */
export function validateInitData(initData: string, maxAgeSeconds = 24 * 60 * 60): ValidatedInitData | null {
  if (!initData) return null;

  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return null;
  params.delete("hash");

  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");

  const secretKey = createHmac("sha256", "WebAppData").update(config.botToken).digest();
  const computedHash = createHmac("sha256", secretKey).update(dataCheckString).digest("hex");

  if (computedHash !== hash) return null;

  const authDate = Number(params.get("auth_date") || 0);
  if (!authDate || Date.now() / 1000 - authDate > maxAgeSeconds) return null;

  const userRaw = params.get("user");
  if (!userRaw) return null;

  try {
    const user = JSON.parse(userRaw) as TelegramWebAppUser;
    if (!user?.id) return null;
    return { user, authDate };
  } catch {
    return null;
  }
}
