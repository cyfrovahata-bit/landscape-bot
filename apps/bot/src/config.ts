import "dotenv/config";

// PEM keys pasted into env UIs (Railway etc.) commonly arrive wrapped in
// quotes, with \n as literal backslash-n, or with \r from Windows clipboards.
// OpenSSL 3 then fails with "DECODER routines::unsupported" at JWT-sign time.
// Normalize all of those instead of trusting the paste to be perfect.
function normalizePrivateKey(raw: string | undefined): string {
  let key = (raw || "").trim();
  if ((key.startsWith('"') && key.endsWith('"')) || (key.startsWith("'") && key.endsWith("'"))) {
    key = key.slice(1, -1);
  }
  return key.replace(/\\n/g, "\n").replace(/\r/g, "").trim();
}

export const config = {
  botToken: process.env.BOT_TOKEN!,
  sheetId: process.env.GOOGLE_SHEET_ID!,
  driveFolderId: process.env.GOOGLE_FOLDER_ID!,
  google: {
    clientEmail: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL!,
    privateKey: normalizePrivateKey(process.env.GOOGLE_PRIVATE_KEY),
  },
  adminIds: (process.env.ADMIN_TG_IDS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number),
  // The Mini App's public HTTPS URL (same one registered as its Mini App in
  // @BotFather) -- the welcome message's "Відкрити застосунок" button opens
  // this as a Telegram Web App. Falls back to the old callback-based menu if
  // unset, so the bot still works before this is configured.
  miniAppUrl: (process.env.PUBLIC_APP_URL || "").replace(/\/+$/, ""),
};

["botToken", "sheetId", "driveFolderId"].forEach((k) => {
  // @ts-ignore
  if (!config[k]) throw new Error(`Missing env: ${k}`);
});
