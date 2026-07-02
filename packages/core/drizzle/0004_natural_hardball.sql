DROP INDEX "reports_date_object_work_uq";--> statement-breakpoint
CREATE UNIQUE INDEX "reports_date_object_work_foreman_uq" ON "reports" USING btree ("date","object_id","work_id","foreman_tg_id");