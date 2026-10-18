import { config } from "./config.js";

export type InlineButton = { text: string; url?: string; webAppUrl?: string };

/**
 * Sends a plain Telegram message via the Bot API (the same bot the Mini App
 * runs under -- config.botToken). Fire-and-forget from the caller's point of
 * view: failures are logged, never thrown, so a notification hiccup never
 * blocks the actual data write it's reporting on.
 */
export async function sendTelegramMessage(
  chatId: number,
  text: string,
  opts?: { buttons?: InlineButton[][] },
): Promise<void> {
  const reply_markup = opts?.buttons
    ? {
        inline_keyboard: opts.buttons.map((row) =>
          row.map((b) => (b.webAppUrl ? { text: b.text, web_app: { url: b.webAppUrl } } : { text: b.text, url: b.url })),
        ),
      }
    : undefined;

  try {
    const send = (formatted: boolean) => fetch(`https://api.telegram.org/bot${config.botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, ...(formatted ? { parse_mode: "Markdown" } : {}), reply_markup }),
    });
    let res = await send(true);
    if (!res.ok) {
      let body = await res.text().catch(() => "");
      // Names and object titles may contain unmatched Markdown characters.
      // Telegram explicitly rejected this message, so one plain-text retry
      // is safe. Never retry ambiguous network failures or other API errors.
      if (res.status === 400 && /can't parse entities|can't find end of the entity/i.test(body)) {
        res = await send(false);
        if (res.ok) return;
        body = await res.text().catch(() => "");
      }
      console.log(`[telegramNotify] sendMessage failed chatId=${chatId} status=${res.status} body=${body}`);
    }
  } catch (e) {
    console.log(`[telegramNotify] sendMessage error chatId=${chatId}: ${(e as Error).message}`);
  }
}
