import { google } from "googleapis";
import { config } from "../config.js";

export function getGoogleAuth() {
  const key = config.google.privateKey?.replace(/\\n/g, "\n");

  return new google.auth.JWT({
    email: config.google.clientEmail,
    key,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
}

export function getSheetsClient() {
  const auth = getGoogleAuth();
  return google.sheets({ version: "v4", auth });
}
