-- RASCUNHO: NÃO APLICAR. Fica fora de drizzle/ até o merge do PR #5 (runner/ledger).
-- Gerado com `npm run db:generate -- --name competitive_decks_provenance` num
-- worktree da branch do PR #5 (fix/drizzle-pg-snapshots-table-ownership, 18df7693),
-- com as mudanças de drizzle/schema.ts de
-- docs/drafts/20261016232131_competitive_decks_provenance.schema.ts.patch. O SQL
-- foi revisado à mão: o bloco gerado vem primeiro, e extensão, wrapper e backfill
-- foram acrescentados depois.
--
-- Depois do merge do #5: aplicar o patch no schema.ts, rodar `npm run db:generate`
-- de novo (o `when` do journal precisa ser maior que o da última migração) e
-- trocar o corpo gerado por este revisado. Conferir com `npm run db:check`.
-- Validação: `db:check` sem DATABASE_URL passou (só journal).
--
-- Divergência schema.ts × banco real (docs/migrations.md): nada aqui depende de
-- coluna divergente. Todas as colunas novas são nullable. O enum é novo.

-- ── Gerado pelo drizzle-kit (revisado) ─────────────────────────────────────────
CREATE TYPE "public"."deck_download_status" AS ENUM('ok', 'empty', 'source_dropped', 'placeholder', 'failed');--> statement-breakpoint
ALTER TABLE "competitive_deck_cards" ADD COLUMN "oracle_id" uuid;--> statement-breakpoint
ALTER TABLE "competitive_deck_cards" ADD COLUMN "raw_name" text;--> statement-breakpoint
ALTER TABLE "competitive_deck_cards" ADD COLUMN "resolved" boolean;--> statement-breakpoint
ALTER TABLE "competitive_decks" ADD COLUMN "download_status" "deck_download_status";--> statement-breakpoint
ALTER TABLE "competitive_decks" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "competitive_decks" ADD COLUMN "archive_reason" text;--> statement-breakpoint
ALTER TABLE "competitive_decks" ADD COLUMN "source_url" text;--> statement-breakpoint
ALTER TABLE "competitive_decks" ADD COLUMN "collected_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "competitive_decks" ADD COLUMN "content_hash" varchar(64);--> statement-breakpoint
ALTER TABLE "competitive_decks" ADD COLUMN "parser_version" text;--> statement-breakpoint
ALTER TABLE "competitive_decks" ADD COLUMN "last_fetch_error" text;--> statement-breakpoint
ALTER TABLE "competitive_decks" ADD COLUMN "import_run_id" uuid;--> statement-breakpoint
CREATE INDEX "competitive_deck_cards_oracle_id_idx" ON "competitive_deck_cards" USING btree ("oracle_id");--> statement-breakpoint

-- ── Acrescentado à mão ─────────────────────────────────────────────────────────
-- oracle_id: uuid com índice, SEM FK até o backfill terminar (cards.oracle_id é
-- varchar hoje; a FK/conversão fica para uma migração posterior).

-- unaccent: usado só na RESOLUÇÃO de nomes, nunca gravado. CREATE EXTENSION pode
-- exigir superuser (ou o privilégio CREATE no banco, em PG13+ para extensões
-- confiáveis; unaccent é trusted). Se o role do migrator não puder, o DBA cria a
-- extensão antes, e esta linha vira no-op.
CREATE EXTENSION IF NOT EXISTS unaccent;--> statement-breakpoint
-- Wrapper IMMUTABLE, exigido caso unaccent seja usado em índice funcional (o
-- unaccent(text) nativo é STABLE). Não há índice nesta migração.
CREATE OR REPLACE FUNCTION public.immutable_unaccent(text) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT
  AS $$ SELECT public.unaccent('public.unaccent'::regdictionary, $1) $$;--> statement-breakpoint

-- Backfill idempotente de download_status (só onde está NULL). O arquivamento
-- source_dropped/placeholder é feito por server/scripts/archiveDeadDecks.ts.
UPDATE "competitive_decks" d SET "download_status" = 'ok'
  WHERE d."download_status" IS NULL
    AND EXISTS (SELECT 1 FROM "competitive_deck_cards" c WHERE c."deck_id" = d."id");--> statement-breakpoint
UPDATE "competitive_decks" d SET "download_status" = 'empty'
  WHERE d."download_status" IS NULL
    AND NOT EXISTS (SELECT 1 FROM "competitive_deck_cards" c WHERE c."deck_id" = d."id");--> statement-breakpoint
-- raw_name preserva o nome importado antes da canonicalização.
UPDATE "competitive_deck_cards" SET "raw_name" = "card_name" WHERE "raw_name" IS NULL;
