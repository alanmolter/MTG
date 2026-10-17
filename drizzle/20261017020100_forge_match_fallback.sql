-- Fallback counters the bridge already reports, stored with the match so
-- training and promotion can see them without the JVM log.

ALTER TABLE forge_matches ADD COLUMN IF NOT EXISTS ai_fallback_decisions integer;
--> statement-breakpoint
ALTER TABLE forge_matches ADD COLUMN IF NOT EXISTS policy_decisions integer;
--> statement-breakpoint
ALTER TABLE forge_matches ADD COLUMN IF NOT EXISTS ai_fallback_by_kind jsonb;
