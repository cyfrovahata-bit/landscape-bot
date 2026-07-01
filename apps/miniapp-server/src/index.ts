import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import express from "express";
import cors from "cors";
import { startSyncLoop, runMigrations, config } from "@landscape/core";
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

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(cors());
app.use(express.json());

app.get("/health", (_req, res) => res.json({ ok: true }));

const apiRouter = express.Router();
apiRouter.use(requireTelegramAuth);
apiRouter.use("/dictionaries", dictionariesRouter);
apiRouter.use("/logistics", logisticsRouter);
apiRouter.use("/materials", materialsRouter);
apiRouter.use("/stats", statsRouter);
apiRouter.use("/road-timesheet", roadTimesheetRouter);
app.use("/api", apiRouter);

// Serve the built mini-app frontend (apps/miniapp-web/dist) from the same
// service, so the whole mini-app is one Railway service with one HTTPS URL
// to register in @BotFather. Falls back gracefully if it hasn't been built.
const webDist = path.resolve(__dirname, "../../miniapp-web/dist");
if (fs.existsSync(webDist)) {
  app.use(express.static(webDist));
  app.get(/^(?!\/api).*/, (_req, res) => {
    res.sendFile(path.join(webDist, "index.html"));
  });
} else {
  console.warn(`[miniapp-server] no built frontend found at ${webDist} (run "npm run build -w apps/miniapp-web")`);
}

async function main() {
  await runMigrations();

  const port = Number(process.env.PORT || 3001);
  app.listen(port, () => {
    console.log(`[miniapp-server] listening on :${port}`);
  });

  startSyncLoop(config.syncIntervalMs);
}

main().catch((err) => {
  console.error("[miniapp-server] fatal startup error", err);
  process.exit(1);
});
