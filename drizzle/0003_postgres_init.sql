CREATE TYPE "role" AS ENUM('user', 'admin');
CREATE TYPE "job_status" AS ENUM('pending', 'running', 'completed', 'failed');

CREATE TABLE "users" (
	"id" serial PRIMARY KEY NOT NULL,
	"openId" varchar(64) NOT NULL UNIQUE,
	"name" text,
	"email" varchar(320),
	"loginMethod" varchar(64),
	"role" "role" NOT NULL DEFAULT 'user',
	"createdAt" timestamp NOT NULL DEFAULT now(),
	"updatedAt" timestamp NOT NULL DEFAULT now(),
	"lastSignedIn" timestamp NOT NULL DEFAULT now()
);

CREATE TABLE "cards" (
	"id" serial PRIMARY KEY NOT NULL,
	"scryfall_id" varchar(64) NOT NULL UNIQUE,
	"name" varchar(255) NOT NULL,
	"type" text,
	"colors" varchar(10),
	"cmc" integer,
	"rarity" varchar(20),
	"image_url" text,
	"power" varchar(10),
	"toughness" varchar(10),
	"text" text,
	"created_at" timestamp NOT NULL DEFAULT now(),
	"updated_at" timestamp NOT NULL DEFAULT now()
);

CREATE TABLE "decks" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL REFERENCES "users"("id"),
	"name" varchar(255) NOT NULL,
	"format" varchar(50) NOT NULL,
	"archetype" varchar(100),
	"description" text,
	"is_public" integer DEFAULT 0,
	"created_at" timestamp NOT NULL DEFAULT now(),
	"updated_at" timestamp NOT NULL DEFAULT now()
);

CREATE TABLE "deck_cards" (
	"id" serial PRIMARY KEY NOT NULL,
	"deck_id" integer NOT NULL REFERENCES "decks"("id"),
	"card_id" integer NOT NULL REFERENCES "cards"("id"),
	"quantity" integer NOT NULL DEFAULT 1,
	UNIQUE("deck_id", "card_id")
);

CREATE TABLE "card_synergies" (
	"id" serial PRIMARY KEY NOT NULL,
	"card1_id" integer NOT NULL REFERENCES "cards"("id"),
	"card2_id" integer NOT NULL REFERENCES "cards"("id"),
	"weight" integer NOT NULL DEFAULT 0,
	"co_occurrence_rate" integer NOT NULL DEFAULT 0,
	"updated_at" timestamp NOT NULL DEFAULT now(),
	UNIQUE("card1_id", "card2_id")
);

CREATE TABLE "meta_stats" (
	"id" serial PRIMARY KEY NOT NULL,
	"card_id" integer NOT NULL REFERENCES "cards"("id"),
	"format" varchar(50) NOT NULL,
	"archetype" varchar(100),
	"play_rate" integer NOT NULL DEFAULT 0,
	"win_rate" integer NOT NULL DEFAULT 0,
	"frequency" integer NOT NULL DEFAULT 0,
	"updated_at" timestamp NOT NULL DEFAULT now(),
	UNIQUE("card_id", "format", "archetype")
);

CREATE TABLE "embeddings_cache" (
	"id" serial PRIMARY KEY NOT NULL,
	"card_id" integer NOT NULL UNIQUE REFERENCES "cards"("id"),
	"vector_json" text NOT NULL,
	"model_version" varchar(50) NOT NULL,
	"created_at" timestamp NOT NULL DEFAULT now()
);

CREATE TABLE "competitive_decks" (
	"id" serial PRIMARY KEY NOT NULL,
	"source_id" varchar(128) NOT NULL UNIQUE,
	"source" varchar(50) NOT NULL DEFAULT 'moxfield',
	"name" varchar(255) NOT NULL,
	"format" varchar(50) NOT NULL,
	"archetype" varchar(100),
	"author" varchar(128),
	"likes" integer DEFAULT 0,
	"views" integer DEFAULT 0,
	"colors" varchar(10),
	"raw_json" text,
	"imported_at" timestamp NOT NULL DEFAULT now()
);

CREATE TABLE "competitive_deck_cards" (
	"id" serial PRIMARY KEY NOT NULL,
	"deck_id" integer NOT NULL REFERENCES "competitive_decks"("id"),
	"card_name" varchar(255) NOT NULL,
	"quantity" integer NOT NULL DEFAULT 1,
	"section" varchar(20) DEFAULT 'mainboard',
	UNIQUE("deck_id", "card_name", "section")
);

CREATE TABLE "training_jobs" (
	"id" serial PRIMARY KEY NOT NULL,
	"status" "job_status" NOT NULL DEFAULT 'pending',
	"job_type" varchar(50) NOT NULL DEFAULT 'embeddings',
	"total_decks" integer DEFAULT 0,
	"total_cards" integer DEFAULT 0,
	"embeddings_trained" integer DEFAULT 0,
	"synergies_updated" integer DEFAULT 0,
	"error_message" text,
	"started_at" timestamp NOT NULL DEFAULT now(),
	"completed_at" timestamp
);
