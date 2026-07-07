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
  sheetId: process.env.GOOGLE_SHEET_ID!,
  driveFolderId: process.env.GOOGLE_FOLDER_ID || "",
  google: {
    clientEmail: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL!,
    privateKey: normalizePrivateKey(process.env.GOOGLE_PRIVATE_KEY),
  },
  botToken: process.env.BOT_TOKEN!, // used to validate Telegram WebApp initData
  syncIntervalMs: Number(process.env.SYNC_INTERVAL_MS || 45_000),
};

["sheetId"].forEach((k) => {
  // @ts-ignore
  if (!config[k]) throw new Error(`Missing env: ${k}`);
});
