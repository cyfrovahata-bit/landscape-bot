import { Readable } from "node:stream";
import { google } from "googleapis";
import { config } from "../config.js";
import { getGoogleAuth } from "./client.js";

export async function uploadPhotoFromBuffer(fileName: string, buffer: Buffer): Promise<string> {
  if (!config.driveFolderId) throw new Error("Missing env: GOOGLE_FOLDER_ID");

  const auth = getGoogleAuth();
  const drive = google.drive({ version: "v3", auth });

  const createRes = await drive.files.create({
    requestBody: {
      name: fileName,
      parents: [config.driveFolderId],
    },
    media: {
      mimeType: "image/jpeg",
      body: Readable.from(buffer),
    },
    fields: "id",
  });

  const fileId = createRes.data.id!;
  await drive.permissions.create({
    fileId,
    requestBody: { role: "reader", type: "anyone" },
  });

  return `https://drive.google.com/file/d/${fileId}/view`;
}
