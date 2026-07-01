import path from "node:path";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { db } from "./db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(__dirname, "../drizzle");

/** Applies any pending SQL migrations to DATABASE_URL. Safe to call on every boot. */
export async function runMigrations() {
  console.log("[MIGRATE] applying pending migrations...");
  await migrate(db, { migrationsFolder });
  console.log("[MIGRATE] up to date");
}
