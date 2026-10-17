/**
 * Backfill for migration 20261016234006_competitive_decks_provenance.
 * Dry-run by default (counts and name resolution only, no writes).
 *
 *   npx tsx server/scripts/backfillDeckProvenance.ts
 *   npx tsx server/scripts/backfillDeckProvenance.ts --apply --batch-size 5000
 *
 * Idempotent: it only touches rows whose target column is still NULL.
 * Each batch is its own statement, so row locks last only that batch.
 * download_status and raw_name batches are capped at --batch-size ROWS. The
 * oracle_id step is capped at --batch-size distinct card NAMES, so one batch can
 * touch every deck line with those names (e.g. 16 names -> 144k lines in a test).
 * Run it outside the import pipeline, or lower --batch-size if that matters.
 */
import "dotenv/config";
import { closeDb, getRawClient } from "../db";
import { CardNameResolver } from "../services/cardNameResolver";
import { backfillDeckProvenance, type Query } from "../services/deckProvenanceBackfill";

async function main() {
  const apply = process.argv.includes("--apply");
  const i = process.argv.indexOf("--batch-size");
  const batchSize = i >= 0 ? Number(process.argv[i + 1]) : 5000;
  if (!Number.isInteger(batchSize) || batchSize <= 0) throw new Error("--batch-size must be a positive integer");
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set");
  const pg = await getRawClient();
  if (!pg) throw new Error("could not open the database");
  const query: Query = async (sql, params) =>
    Array.from((await (params ? pg.unsafe(sql, params as never[]) : pg.unsafe(sql))) as Array<Record<string, unknown>>);

  const cols = await query(`SELECT column_name FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name IN ('competitive_decks','competitive_deck_cards')
      AND column_name IN ('download_status','raw_name','oracle_id','resolved')`);
  if (cols.length < 4) {
    console.error("[backfill] provenance columns missing: run `npm run db:migrate` first");
    process.exitCode = 1;
    return;
  }
  // Printings with oracle_id first (the resolver also prefers them).
  const catalog = await query("SELECT name, oracle_id FROM cards ORDER BY (oracle_id IS NULL), id");
  const resolver = new CardNameResolver(
    catalog.map((c) => ({ name: String(c.name), oracleId: (c.oracle_id as string | null) ?? null })),
  );
  console.log(`[backfill] mode=${apply ? "APPLY" : "DRY-RUN"} batch=${batchSize}`);
  const report = await backfillDeckProvenance(query, {
    apply,
    batchSize,
    resolver,
    log: (m) => console.log(`[backfill] ${m}`),
  });
  console.log(`[backfill] pending before: ${JSON.stringify(report.pending)}`);
  console.log(`[backfill] updated: ${JSON.stringify(report.updated)}`);
  console.log(`[backfill] names resolved=${report.names.resolved} unresolved=${report.names.unresolved}`);
  for (const n of report.names.unresolvedSample) console.log(`[backfill] unresolved: ${n}`);
  if (!apply) console.log("[backfill] dry-run: nothing written. Re-run with --apply.");
}

main()
  .catch((err: unknown) => {
    console.error("[backfill] fatal:", err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  })
  .finally(() => {
    closeDb().catch(() => undefined).finally(() => process.exit(process.exitCode ?? 0));
  });
