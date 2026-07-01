import "dotenv/config";

export const config = {
  botToken: process.env.BOT_TOKEN!,
  sheetId: process.env.GOOGLE_SHEET_ID!,
  driveFolderId: process.env.GOOGLE_FOLDER_ID!,
  google: {
    clientEmail: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL!,
    privateKey: (process.env.GOOGLE_PRIVATE_KEY || "").replace(/\\n/g, "\n"),
  },
  adminIds: (process.env.ADMIN_TG_IDS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number),
};

["botToken", "sheetId", "driveFolderId"].forEach((k) => {
  // @ts-ignore
  if (!config[k]) throw new Error(`Missing env: ${k}`);
});
