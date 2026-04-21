-- ============================================================================
-- Migration 0006 — PHASE 2: Contextual Distillation
-- Adds per-archetype scalar weight columns to card_learning. This keeps the
-- original `weight` column as a global fallback while letting learners
-- specialize — e.g. [Counterspell] is awesome in control (weight_control=8)
-- but meh in aggro (weight_aggro=1.2).
--
-- Idempotent: all ALTERs use IF NOT EXISTS so re-running is safe.
-- ============================================================================

ALTER TABLE "card_learning"
  ADD COLUMN IF NOT EXISTS "weight_aggro"    REAL NOT NULL DEFAULT 1.0,
  ADD COLUMN IF NOT EXISTS "weight_control"  REAL NOT NULL DEFAULT 1.0,
  ADD COLUMN IF NOT EXISTS "weight_midrange" REAL NOT NULL DEFAULT 1.0,
  ADD COLUMN IF NOT EXISTS "weight_combo"    REAL NOT NULL DEFAULT 1.0,
  ADD COLUMN IF NOT EXISTS "weight_ramp"     REAL NOT NULL DEFAULT 1.0;

-- Backfill: give existing cards the same archetype weights as their global
-- weight so the first reads after migration aren't all 1.0 (cold start).
UPDATE "card_learning" SET
    "weight_aggro"    = "weight",
    "weight_control"  = "weight",
    "weight_midrange" = "weight",
    "weight_combo"    = "weight",
    "weight_ramp"     = "weight"
  WHERE "weight_aggro"    = 1.0
    AND "weight_control"  = 1.0
    AND "weight_midrange" = 1.0
    AND "weight_combo"    = 1.0
    AND "weight_ramp"     = 1.0
    AND "weight" <> 1.0;

-- Indexes used by the generator when it filters by archetype ranking.
CREATE INDEX IF NOT EXISTS "learning_weight_aggro_idx"    ON "card_learning" ("weight_aggro");
CREATE INDEX IF NOT EXISTS "learning_weight_control_idx"  ON "card_learning" ("weight_control");
CREATE INDEX IF NOT EXISTS "learning_weight_midrange_idx" ON "card_learning" ("weight_midrange");
CREATE INDEX IF NOT EXISTS "learning_weight_combo_idx"    ON "card_learning" ("weight_combo");
CREATE INDEX IF NOT EXISTS "learning_weight_ramp_idx"     ON "card_learning" ("weight_ramp");
