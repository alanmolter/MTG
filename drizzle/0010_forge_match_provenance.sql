-- Provenance for forge_matches. Existing rows stay valid: every column is nullable.
-- Writers (playOneArenaMatch and ml_engine.ray_cluster.match_record) fill them
-- for matches recorded after this migration.

ALTER TABLE forge_matches ADD COLUMN IF NOT EXISTS agent_deck_id text;
ALTER TABLE forge_matches ADD COLUMN IF NOT EXISTS opponent_deck_id text;
ALTER TABLE forge_matches ADD COLUMN IF NOT EXISTS seed bigint;
ALTER TABLE forge_matches ADD COLUMN IF NOT EXISTS policy_version text;
ALTER TABLE forge_matches ADD COLUMN IF NOT EXISTS pool_version text;
ALTER TABLE forge_matches ADD COLUMN IF NOT EXISTS bridge_version text;

CREATE INDEX IF NOT EXISTS forge_matches_seed_idx ON forge_matches (seed);
CREATE INDEX IF NOT EXISTS forge_matches_policy_version_idx ON forge_matches (policy_version);
