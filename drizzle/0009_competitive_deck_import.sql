-- Align drizzle with the live mtg database (pg_dump, 2026-10) for deck import.
--
-- Drift that matters:
--   competitive_decks.source default is 'moxfield' in Postgres. The old
--   drizzle default was 'mtggoldfish'. Scrapers set source themselves.
--   competitive_deck_cards needs UNIQUE (deck_id, card_name, section). The
--   importers used to insert the header and then each card outside a
--   transaction, so a failed card write left competitive_decks rows with
--   zero cards and a null raw_json. The unique index is what ON CONFLICT
--   targets; 0007 creates it on databases that never had the table.
--
-- Re-running the MTGGoldfish / MTGTop8 importers now stores raw_json and
-- replaces competitive_deck_cards inside one transaction.

ALTER TABLE competitive_decks ALTER COLUMN source SET DEFAULT 'moxfield';
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS competitive_deck_cards_deck_card_section_unique
  ON competitive_deck_cards (deck_id, card_name, section);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS competitive_deck_cards_deck_id_idx
  ON competitive_deck_cards (deck_id);
