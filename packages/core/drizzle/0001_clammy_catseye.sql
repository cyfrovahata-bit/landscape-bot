CREATE UNIQUE INDEX "allowances_date_employee_type_uq" ON "allowances" USING btree ("date","employee_id","type");--> statement-breakpoint
CREATE UNIQUE INDEX "closures_date_object_uq" ON "closures" USING btree ("date","object_id");--> statement-breakpoint
CREATE UNIQUE INDEX "reports_date_object_work_uq" ON "reports" USING btree ("date","object_id","work_id");--> statement-breakpoint
CREATE UNIQUE INDEX "timesheet_date_object_employee_uq" ON "timesheet_entries" USING btree ("date","object_id","employee_id");