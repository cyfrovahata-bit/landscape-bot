CREATE TABLE "allowances" (
	"id" serial PRIMARY KEY NOT NULL,
	"date" text NOT NULL,
	"object_id" text,
	"foreman_tg_id" bigint NOT NULL,
	"type" text NOT NULL,
	"employee_id" text NOT NULL,
	"employee_name" text NOT NULL,
	"amount" real NOT NULL,
	"meta" text,
	"day_status" text NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cars" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"plate" text,
	"active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "closures" (
	"id" serial PRIMARY KEY NOT NULL,
	"date" text NOT NULL,
	"object_id" text NOT NULL,
	"foreman_tg_id" bigint NOT NULL,
	"submitted_at" timestamp NOT NULL,
	"submitted_by" text NOT NULL,
	"comment" text
);
--> statement-breakpoint
CREATE TABLE "day_statuses" (
	"id" serial PRIMARY KEY NOT NULL,
	"date" text NOT NULL,
	"object_id" text NOT NULL,
	"foreman_tg_id" bigint NOT NULL,
	"status" text NOT NULL,
	"has_timesheet" boolean DEFAULT false NOT NULL,
	"has_reports" boolean DEFAULT false NOT NULL,
	"has_reports_volume_ok" boolean DEFAULT false NOT NULL,
	"has_road" boolean DEFAULT false NOT NULL,
	"has_odo_start" boolean DEFAULT false NOT NULL,
	"has_odo_end" boolean DEFAULT false NOT NULL,
	"has_odo_start_photo" boolean DEFAULT false NOT NULL,
	"has_odo_end_photo" boolean DEFAULT false NOT NULL,
	"has_logistics" boolean DEFAULT false NOT NULL,
	"has_materials" boolean DEFAULT false NOT NULL,
	"return_reason" text,
	"approved_by" text,
	"approved_at" timestamp,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "employees" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"brigade_id" text,
	"position" text,
	"active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "events" (
	"event_id" text PRIMARY KEY NOT NULL,
	"status" text NOT NULL,
	"ref_event_id" text,
	"chat_id" bigint,
	"ts" timestamp NOT NULL,
	"date" text NOT NULL,
	"foreman_tg_id" bigint NOT NULL,
	"type" text NOT NULL,
	"object_id" text,
	"car_id" text,
	"employee_ids" text,
	"payload" text,
	"msg_id" integer,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "material_moves" (
	"move_id" text PRIMARY KEY NOT NULL,
	"time" text NOT NULL,
	"date" text NOT NULL,
	"object_id" text NOT NULL,
	"foreman_tg_id" bigint NOT NULL,
	"material_id" text NOT NULL,
	"material_name" text NOT NULL,
	"qty" real,
	"unit" text NOT NULL,
	"move_type" text NOT NULL,
	"purpose" text,
	"photos" text,
	"payload" text,
	"day_status" text,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "materials" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"unit" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"category" text,
	"comment" text
);
--> statement-breakpoint
CREATE TABLE "objects" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"address" text,
	"active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "odometer_days" (
	"id" serial PRIMARY KEY NOT NULL,
	"date" text NOT NULL,
	"car_id" text NOT NULL,
	"foreman_tg_id" bigint NOT NULL,
	"start_value" real,
	"start_photo" text,
	"end_value" real,
	"end_photo" text,
	"km_day" real,
	"trip_class" text,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reports" (
	"id" serial PRIMARY KEY NOT NULL,
	"date" text NOT NULL,
	"object_id" text NOT NULL,
	"foreman_tg_id" bigint NOT NULL,
	"work_id" text NOT NULL,
	"work_name" text NOT NULL,
	"volume" text,
	"volume_status" text NOT NULL,
	"photos" text,
	"day_status" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" text NOT NULL,
	"comment" text
);
--> statement-breakpoint
CREATE TABLE "sync_cursors" (
	"sheet_name" text PRIMARY KEY NOT NULL,
	"last_row" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "timesheet_entries" (
	"id" serial PRIMARY KEY NOT NULL,
	"date" text NOT NULL,
	"object_id" text NOT NULL,
	"employee_id" text NOT NULL,
	"employee_name" text NOT NULL,
	"hours" real NOT NULL,
	"source" text NOT NULL,
	"discipline_coef" real,
	"productivity_coef" real,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tool_moves" (
	"move_id" text PRIMARY KEY NOT NULL,
	"time" text NOT NULL,
	"date" text NOT NULL,
	"foreman_tg_id" bigint NOT NULL,
	"tool_id" text NOT NULL,
	"tool_name" text NOT NULL,
	"qty" real NOT NULL,
	"move_type" text NOT NULL,
	"purpose" text,
	"photos" text,
	"payload" text,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tools" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"category" text,
	"comment" text
);
--> statement-breakpoint
CREATE TABLE "users" (
	"tg_id" bigint PRIMARY KEY NOT NULL,
	"username" text,
	"pib" text NOT NULL,
	"role" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"comment" text
);
--> statement-breakpoint
CREATE TABLE "works" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"category" text,
	"unit" text,
	"tariff" real DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE INDEX "allowances_date_idx" ON "allowances" USING btree ("date");--> statement-breakpoint
CREATE INDEX "closures_date_object_idx" ON "closures" USING btree ("date","object_id");--> statement-breakpoint
CREATE UNIQUE INDEX "day_status_uq" ON "day_statuses" USING btree ("date","object_id","foreman_tg_id");--> statement-breakpoint
CREATE INDEX "events_date_type_idx" ON "events" USING btree ("date","type");--> statement-breakpoint
CREATE INDEX "events_object_idx" ON "events" USING btree ("object_id");--> statement-breakpoint
CREATE INDEX "material_moves_date_object_idx" ON "material_moves" USING btree ("date","object_id");--> statement-breakpoint
CREATE UNIQUE INDEX "odometer_date_car_uq" ON "odometer_days" USING btree ("date","car_id");--> statement-breakpoint
CREATE INDEX "reports_date_object_idx" ON "reports" USING btree ("date","object_id");--> statement-breakpoint
CREATE INDEX "timesheet_date_object_idx" ON "timesheet_entries" USING btree ("date","object_id");--> statement-breakpoint
CREATE INDEX "tool_moves_date_idx" ON "tool_moves" USING btree ("date");