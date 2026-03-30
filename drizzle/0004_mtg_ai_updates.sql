-- Migração 0004: MTG AI Updates
-- Adiciona colunas e tabelas novas sem quebrar dados existentes

-- 1. Adicionar campo is_synthetic em competitive_decks (se não existir)
ALTER TABLE "competitive_decks"
  ADD COLUMN IF NOT EXISTS "is_synthetic" boolean NOT NULL DEFAULT false;

-- 2. Criar tabela card_learning (se não existir)
CREATE TABLE IF NOT EXISTS "card_learning" (
  "id" serial PRIMARY KEY NOT NULL,
  "card_name" varchar(255) NOT NULL UNIQUE,
  "weight" real NOT NULL DEFAULT 1.0,
  "win_count" integer NOT NULL DEFAULT 0,
  "loss_count" integer NOT NULL DEFAULT 0,
  "avg_score" real NOT NULL DEFAULT 0.0,
  "updated_at" timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "learning_weight_idx" ON "card_learning" ("weight");

-- 3. Criar tabela rl_decisions (se não existir)
CREATE TABLE IF NOT EXISTS "rl_decisions" (
  "id" serial PRIMARY KEY NOT NULL,
  "deck_id" integer,
  "card_name" varchar(255) NOT NULL,
  "policy_probability" real NOT NULL DEFAULT 0,
  "reward" real,
  "processed" boolean NOT NULL DEFAULT false,
  "created_at" timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "rl_decisions_processed_idx" ON "rl_decisions" ("processed");
CREATE INDEX IF NOT EXISTS "rl_decisions_card_idx" ON "rl_decisions" ("card_name");

-- 4. Adicionar campos extras em cards (se não existirem)
ALTER TABLE "cards"
  ADD COLUMN IF NOT EXISTS "oracle_id" varchar(64),
  ADD COLUMN IF NOT EXISTS "is_arena" integer DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "price_usd" real;

-- 5. Adicionar campo deck_shares (se tabela não existir)
CREATE TABLE IF NOT EXISTS "deck_shares" (
  "id" serial PRIMARY KEY NOT NULL,
  "share_id" varchar(255) NOT NULL UNIQUE,
  "deck_id" integer NOT NULL REFERENCES "decks"("id"),
  "title" varchar(255) NOT NULL,
  "description" text,
  "image_url" text,
  "decklist" text NOT NULL,
  "format" varchar(50) NOT NULL,
  "colors" text,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "expires_at" timestamp
);

-- 6. Garantir que status enum existe (pode já existir)
DO $$ BEGIN
  CREATE TYPE "status" AS ENUM('pending', 'running', 'completed', 'failed');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
