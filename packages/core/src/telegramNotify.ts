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
    const res = await fetch(`https://api.telegram.org/bot${config.botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "Markdown", reply_markup }),
    });
    if (!res.ok) {
      console.log(`[telegramNotify] sendMessage failed chatId=${chatId} status=${res.status} body=${await res.text().catch(() => "")}`);
    }
  } catch (e) {
    console.log(`[telegramNotify] sendMessage error chatId=${chatId}: ${(e as Error).message}`);
  }
}
