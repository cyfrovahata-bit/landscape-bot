DROP INDEX "allowances_date_employee_type_uq";--> statement-breakpoint
UPDATE "allowances" SET "object_id" = '' WHERE "object_id" IS NULL;--> statement-breakpoint
ALTER TABLE "allowances" ALTER COLUMN "object_id" SET DEFAULT '';--> statement-breakpoint
ALTER TABLE "allowances" ALTER COLUMN "object_id" SET NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "allowances_date_foreman_type_employee_object_uq" ON "allowances" USING btree ("date","foreman_tg_id","type","employee_id","object_id");