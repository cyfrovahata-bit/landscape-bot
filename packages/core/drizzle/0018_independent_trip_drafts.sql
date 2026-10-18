CREATE TABLE trip_drafts (
 id text PRIMARY KEY, foreman_tg_id bigint NOT NULL, revision integer NOT NULL DEFAULT 0,
 state text NOT NULL DEFAULT 'open', payload text NOT NULL, updated_at timestamp NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX trip_drafts_owner_idx ON trip_drafts(foreman_tg_id, updated_at);
--> statement-breakpoint
CREATE TABLE trip_draft_history (
 id serial PRIMARY KEY, trip_id text NOT NULL, foreman_tg_id bigint NOT NULL,
 revision integer NOT NULL, action text NOT NULL, payload text NOT NULL, created_at timestamp NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX trip_draft_history_trip_idx ON trip_draft_history(trip_id,id);

--> statement-breakpoint
CREATE TABLE trip_draft_owners (foreman_tg_id bigint PRIMARY KEY, active_trip_id text, adopted_at timestamp NOT NULL DEFAULT now());
