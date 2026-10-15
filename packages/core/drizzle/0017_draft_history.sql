CREATE TABLE "draft_heads" (
  "foreman_tg_id" bigint PRIMARY KEY,
  "revision" integer NOT NULL DEFAULT 0,
  "managed" boolean NOT NULL DEFAULT false
);
--> statement-breakpoint
CREATE TABLE "draft_history" (
  "id" serial PRIMARY KEY,
  "foreman_tg_id" bigint NOT NULL,
  "revision" integer NOT NULL,
  "action" text NOT NULL,
  "snapshot" text NOT NULL,
  "created_at" timestamp NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX "draft_history_foreman_created_idx" ON "draft_history" ("foreman_tg_id", "created_at");
--> statement-breakpoint
INSERT INTO draft_heads (foreman_tg_id, revision) SELECT foreman_tg_id, 0 FROM day_drafts;
--> statement-breakpoint
INSERT INTO draft_history (foreman_tg_id, revision, action, snapshot)
SELECT foreman_tg_id, 0, 'migration_backup', row_to_json(d)::text FROM day_drafts d;
