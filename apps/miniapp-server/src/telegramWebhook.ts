import { createHmac } from "node:crypto";
import type { Express, Request, Response } from "express";
import { config, runSyncCycle, db, schema, sheetsClient, sheetNames } from "@landscape/core";
import { normRole } from "./authMiddleware.js";

const { loadSheet, appendRowsByHeaders, updateRow, getCell } = sheetsClient;
const { SHEET_NAMES, USERS_HEADERS } = sheetNames;

// Replaces the deleted legacy bot's ONE still-needed job: /start
// self-registration of new users and the admin's approve/reject buttons.
// Runs as a Telegram webhook inside this same service (no second polling
// process to deploy) -- Telegram POSTs updates to /telegram/webhook on the
// same public HTTPS URL the Mini App already lives on.

type TgUser = { id: number; first_name?: string; last_name?: string; username?: string };
type TgUpdate = {
  message?: { chat: { id: number }; from?: TgUser; text?: string };
  callback_query?: { id: string; from: TgUser; data?: string; message?: { chat: { id: number }; message_id: number } };
};

// Stable webhook secret derived from the bot token -- no extra env var to
// configure, and only Telegram (told the secret via setWebhook) can produce
// it. Telegram echoes it back on every delivery in this header.
const webhookSecret = createHmac("sha256", "landscape-webhook").update(config.botToken).digest("hex");

async function tg(method: string, body: Record<string, unknown>): Promise<any> {
  const res = await fetch(`https://api.telegram.org/bot${config.botToken}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => null)) as any;
  if (!json?.ok) console.warn(`[tg-webhook] ${method} failed: ${JSON.stringify(json)?.slice(0, 300)}`);
  return json;
}

function appButton() {
  return config.publicUrl
    ? { inline_keyboard: [[{ text: "🚀 Відкрити застосунок", web_app: { url: config.publicUrl } }]] }
    : undefined;
}

const truthyActive = (v: unknown) => ["ТАК", "TRUE", "1", "YES"].includes(String(v ?? "").trim().toUpperCase());

/** Every row of КОРИСТУВАЧІ straight from Sheets (the source of truth),
 * INCLUDING pending ones (АКТИВ="Ні") -- Postgres would work for active
 * users, but a pending applicant must be found too, or every repeat /start
 * re-adds a duplicate row and re-pings the admins (the exact bug the old
 * bot once had). Keeps the raw row + header map so updates can patch cells
 * BY HEADER NAME instead of assuming the sheet's column order. */
async function fetchAllUserRows() {
  const sh = await loadSheet(SHEET_NAMES.users);
  return sh.data.map((row, i) => ({
    rowNumber: i + 2, // 1-based + header row
    raw: row as unknown[],
    map: sh.map,
    header: sh.header,
    tgId: Number(getCell(row, sh.map, USERS_HEADERS.tgId) || 0),
    active: String(getCell(row, sh.map, USERS_HEADERS.active) ?? ""),
  }));
}

async function handleStart(chatId: number, user: TgUser) {
  const rows = await fetchAllUserRows();
  const mine = rows.filter((r) => r.tgId === Number(user.id));

  if (mine.some((r) => truthyActive(r.active))) {
    await tg("sendMessage", {
      chat_id: chatId,
      text: "👋 Вітаю! Вся робота — у застосунку «Дорожній табель».",
      reply_markup: appButton(),
    });
    return;
  }
  if (mine.length) {
    await tg("sendMessage", { chat_id: chatId, text: "⏳ Ваша заявка вже подана. Очікуйте підтвердження адміністратора." });
    return;
  }

  await appendRowsByHeaders(SHEET_NAMES.users, [
    {
      [USERS_HEADERS.tgId]: user.id,
      [USERS_HEADERS.username]: user.username ?? "",
      [USERS_HEADERS.pib]: `${user.first_name ?? ""} ${user.last_name ?? ""}`.trim(),
      [USERS_HEADERS.role]: "Очікує",
      [USERS_HEADERS.active]: "Ні",
      [USERS_HEADERS.comment]: "Заявка на доступ",
    },
  ]);

  // Admins are read from Postgres (already-synced, fast) -- an admin by
  // definition isn't a pending row, so the mirror is good enough here.
  const admins = (await db.select().from(schema.users)).filter((u) => u.active && normRole(u.role) === "ADMIN");
  const text = `🆕 Нова заявка\n\n👤 ${user.first_name ?? ""} ${user.last_name ?? ""}\n📛 @${user.username ?? "—"}\n🆔 ${user.id}`;
  for (const admin of admins) {
    await tg("sendMessage", {
      chat_id: Number(admin.tgId),
      text,
      reply_markup: {
        inline_keyboard: [
          [
            { text: "✅ Адмін", callback_data: `reg:admin:${user.id}` },
            { text: "👷 Бригадир", callback_data: `reg:foreman:${user.id}` },
          ],
          [{ text: "❌ Відхилити", callback_data: `reg:reject:${user.id}` }],
        ],
      },
    });
  }

  await tg("sendMessage", { chat_id: chatId, text: "✅ Заявку на доступ відправлено адміністратору.\nОчікуйте підтвердження." });
}

/** Same semantics as the old bot's updateUser: rewrite EVERY row matching
 * the tgId (duplicates from historical repeat-/start taps must all agree,
 * or the sync's "last row wins" dedupe could resurrect a stale pending
 * state), then sync Sheets -> Postgres immediately so the fresh approval
 * doesn't sit invisible to the Mini App until the next scheduled cycle. */
async function updateUserRows(tgId: number, role: string, active: string, comment: string) {
  const rows = await fetchAllUserRows();
  const matches = rows.filter((r) => r.tgId === tgId);
  if (!matches.length) throw new Error(`Користувача з TG_ID=${tgId} не знайдено в КОРИСТУВАЧІ`);
  for (const m of matches) {
    // Rewrite the full row, patching only РОЛЬ/АКТИВ/КОМЕНТАР by header
    // position -- untouched columns keep their existing values.
    const values = m.header.map((_h: string, idx: number) => m.raw[idx] ?? "");
    // Header constants match the sheet's real header text 1:1 (same ones the
    // sync worker reads by), so a plain map lookup is exact.
    const set = (headerName: string, v: string) => {
      const idx = m.map[headerName];
      if (idx !== undefined) values[idx] = v;
    };
    set(USERS_HEADERS.role, role);
    set(USERS_HEADERS.active, active);
    set(USERS_HEADERS.comment, comment);
    await updateRow(SHEET_NAMES.users, m.rowNumber, values);
  }
  await runSyncCycle();
}

async function handleRegCallback(q: NonNullable<TgUpdate["callback_query"]>) {
  const [, action, tgIdRaw] = (q.data ?? "").split(":");
  const applicantTgId = Number(tgIdRaw);

  // The tapping admin is verified against the users table by THEIR OWN id
  // (q.from.id), never trusted from the callback payload.
  const actors = (await db.select().from(schema.users)).filter((u) => Number(u.tgId) === q.from.id);
  const isAdmin = actors.some((u) => u.active && normRole(u.role) === "ADMIN");
  if (!isAdmin) {
    await tg("answerCallbackQuery", { callback_query_id: q.id, text: "⛔️ Тільки адміністратор", show_alert: true });
    return;
  }

  try {
    if (action === "admin") await updateUserRows(applicantTgId, "Адміністратор", "Так", "Підтверджено адміністратором");
    else if (action === "foreman") await updateUserRows(applicantTgId, "Бригадир", "Так", "Підтверджено адміністратором");
    else if (action === "reject") await updateUserRows(applicantTgId, "Відхилено", "Ні", "Відхилено адміністратором");
    else return;

    await tg("answerCallbackQuery", { callback_query_id: q.id, text: "✅ Оброблено" });
    if (q.message) {
      await tg("editMessageText", { chat_id: q.message.chat.id, message_id: q.message.message_id, text: "✅ Оброблено" });
    }
    // Tell the applicant -- the old bot left them guessing until they tried /start again.
    if (action === "reject") {
      await tg("sendMessage", { chat_id: applicantTgId, text: "❌ На жаль, у доступі відмовлено." });
    } else {
      await tg("sendMessage", { chat_id: applicantTgId, text: "✅ Доступ надано! Відкривайте застосунок:", reply_markup: appButton() });
    }
  } catch (e) {
    const reason = (e as Error).message ?? String(e);
    await tg("answerCallbackQuery", { callback_query_id: q.id, text: "❌ Помилка обробки", show_alert: true });
    if (q.message) {
      await tg("sendMessage", { chat_id: q.message.chat.id, text: `⚠️ Не вдалось обробити заявку (TG_ID=${applicantTgId}).\nПричина: ${reason}`.slice(0, 3500) });
    }
  }
}

export function registerTelegramWebhook(app: Express) {
  app.post("/telegram/webhook", async (req: Request, res: Response) => {
    if (req.header("x-telegram-bot-api-secret-token") !== webhookSecret) {
      res.status(403).end();
      return;
    }
    // Always 200 no matter what happens inside -- a non-200 makes Telegram
    // redeliver the same update in a retry loop, spamming admins with
    // duplicate заявка notifications on every transient Sheets error.
    res.json({ ok: true });

    const update = req.body as TgUpdate;
    try {
      if (update.message?.text?.startsWith("/start") && update.message.from) {
        await handleStart(update.message.chat.id, update.message.from);
      } else if (update.callback_query?.data?.startsWith("reg:")) {
        await handleRegCallback(update.callback_query);
      } else if (update.callback_query) {
        // Stale buttons from the deleted bot's old menus -- just clear the spinner.
        await tg("answerCallbackQuery", { callback_query_id: update.callback_query.id });
      }
    } catch (e) {
      console.error(`[tg-webhook] update failed: ${(e as Error).message}`);
    }
  });
}

/** Points the bot's webhook at this service. Called once on startup;
 * replaces whatever webhook/polling state the bot had before. */
export async function setupTelegramWebhook() {
  if (!config.publicUrl) {
    console.warn("[tg-webhook] PUBLIC_APP_URL not set -- /start registration disabled (Mini App menu button still works)");
    return;
  }
  const json = await tg("setWebhook", {
    url: `${config.publicUrl}/telegram/webhook`,
    secret_token: webhookSecret,
    allowed_updates: ["message", "callback_query"],
    drop_pending_updates: true,
  });
  if (json?.ok) console.log(`[tg-webhook] registered at ${config.publicUrl}/telegram/webhook`);
}
