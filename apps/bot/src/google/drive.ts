import { google } from "googleapis";
import { config } from "../config.js";
import { getGoogleAuth } from "./client.js";

export async function uploadPhotoFromBuffer(fileName: string, buffer: Buffer): Promise<string> {
  const auth = getGoogleAuth();
  const drive = google.drive({ version: "v3", auth });

  const createRes = await drive.files.create({
    requestBody: {
      name: fileName,
      parents: [config.driveFolderId],
    },
    media: {
      mimeType: "image/jpeg",
      body: ReadableFromBuffer(buffer),
    },
    fields: "id",
  });

  const fileId = createRes.data.id!;
  // зробимо доступ по лінку (або під shared drive / домен — налаштовується)
  await drive.permissions.create({
    fileId,
    requestBody: { role: "reader", type: "anyone" },
  });

  return `https://drive.google.com/file/d/${fileId}/view`;
}

function ReadableFromBuffer(buffer: Buffer) {
  // без додаткових пакетів
  const { Readable } = require("stream");
  const s = new Readable();
  s.push(buffer);
  s.push(null);
  return s;
}
