import "dotenv/config";

export const config = {
  sheetId: process.env.GOOGLE_SHEET_ID!,
  google: {
    clientEmail: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL!,
    privateKey: (process.env.GOOGLE_PRIVATE_KEY || "").replace(/\\n/g, "\n"),
  },
  botToken: process.env.BOT_TOKEN!, // used to validate Telegram WebApp initData
  syncIntervalMs: Number(process.env.SYNC_INTERVAL_MS || 45_000),
};

["sheetId"].forEach((k) => {
  // @ts-ignore
  if (!config[k]) throw new Error(`Missing env: ${k}`);
});
