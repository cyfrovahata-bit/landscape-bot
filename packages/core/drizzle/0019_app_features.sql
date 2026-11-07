CREATE TABLE IF NOT EXISTS app_features (
  key text PRIMARY KEY,
  enabled boolean NOT NULL DEFAULT false,
  updated_by bigint NOT NULL,
  updated_at timestamp NOT NULL DEFAULT now()
);
