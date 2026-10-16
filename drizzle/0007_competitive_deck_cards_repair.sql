-- Repair migration: older DBs may have competitive_decks without the companion
-- card table because 0004 only created the unique index.
CREATE TABLE IF NOT EXISTS "competitive_deck_cards" (
  "id" serial PRIMARY KEY NOT NULL,
  "deck_id" integer NOT NULL REFERENCES "competitive_decks"("id") ON DELETE CASCADE,
  "card_name" varchar(255) NOT NULL,
  "quantity" integer NOT NULL DEFAULT 1,
  "section" varchar(20) DEFAULT 'mainboard'
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "competitive_deck_cards_deck_card_section_unique"
  ON "competitive_deck_cards" ("deck_id", "card_name", "section");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "competitive_deck_cards_deck_id_idx"
  ON "competitive_deck_cards" ("deck_id");
