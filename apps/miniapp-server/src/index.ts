import "dotenv/config";
import express from "express";
import cors from "cors";
import { startSyncLoop, config } from "@landscape/core";
import { requireTelegramAuth } from "./authMiddleware.js";
import { dictionariesRouter } from "./routes/dictionaries.js";
import { logisticsRouter } from "./routes/logistics.js";
import { materialsRouter } from "./routes/materials.js";
import { statsRouter } from "./routes/stats.js";
import { roadTimesheetRouter } from "./routes/roadTimesheet.js";

// Telegram IDs are stored as bigint; make them JSON-serializable as strings.
(BigInt.prototype as any).toJSON = function (this: bigint) {
  return this.toString();
};

const app = express();
app.use(cors());
app.use(express.json());

app.get("/health", (_req, res) => res.json({ ok: true }));

app.use(requireTelegramAuth);

app.use("/api/dictionaries", dictionariesRouter);
app.use("/api/logistics", logisticsRouter);
app.use("/api/materials", materialsRouter);
app.use("/api/stats", statsRouter);
app.use("/api/road-timesheet", roadTimesheetRouter);

const port = Number(process.env.PORT || 3001);
app.listen(port, () => {
  console.log(`[miniapp-server] listening on :${port}`);
});

startSyncLoop(config.syncIntervalMs);
