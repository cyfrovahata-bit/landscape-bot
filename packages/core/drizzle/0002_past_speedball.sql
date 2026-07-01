CREATE TABLE "logistic_directions" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"tariff" real DEFAULT 0 NOT NULL,
	"discounts_by_qty" text,
	"active" boolean DEFAULT true NOT NULL
);
