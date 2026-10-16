-- Phase 1: which matches were actually driven by the external controller.
-- Existing rows stay valid: both columns are nullable. Writers set them for
-- matches recorded after this migration. Promotion counts only
-- policy_controlled = true.

ALTER TABLE forge_matches ADD COLUMN IF NOT EXISTS policy_controlled boolean;
ALTER TABLE forge_matches ADD COLUMN IF NOT EXISTS protocol_version integer;

CREATE INDEX IF NOT EXISTS forge_matches_policy_controlled_idx
    ON forge_matches (policy_controlled);
