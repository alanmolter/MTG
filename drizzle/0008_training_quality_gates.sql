-- Data-quality and promotion state for the ML pipeline.
-- This migration is intentionally additive: imported decks are quarantined by
-- metadata instead of being deleted, so a later importer repair can reuse them.

ALTER TABLE competitive_decks
  ADD COLUMN IF NOT EXISTS is_training_eligible boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE competitive_decks
  ADD COLUMN IF NOT EXISTS training_rejection_reason text;
--> statement-breakpoint
ALTER TABLE competitive_decks
  ADD COLUMN IF NOT EXISTS training_quality_checked_at timestamp;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS competitive_decks_training_eligible_idx
  ON competitive_decks (is_training_eligible, format);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS training_runs (
  id serial PRIMARY KEY,
  run_kind varchar(64) NOT NULL,
  status varchar(32) NOT NULL,
  dataset_fingerprint varchar(64),
  valid_decks integer NOT NULL DEFAULT 0,
  rejected_decks integer NOT NULL DEFAULT 0,
  real_match_count integer NOT NULL DEFAULT 0,
  invalid_synergy_count integer NOT NULL DEFAULT 0,
  baseline_metric real,
  candidate_metric real,
  artifact_path text,
  gate_report jsonb NOT NULL DEFAULT '{}'::jsonb,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS training_runs_recent_idx
  ON training_runs (started_at DESC);
--> statement-breakpoint

-- Forge outcomes are the auditable labels used for card/context weight updates.
-- The table already exists on some installations; this keeps fresh databases
-- compatible with the TypeScript recorder.
CREATE TABLE IF NOT EXISTS forge_matches (
  id serial PRIMARY KEY,
  winner integer,
  turns integer,
  created_at timestamp NOT NULL DEFAULT now(),
  raw_json text,
  combo_summary_json text
);
