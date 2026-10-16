/**
 * Re-import competitive decks that currently have no card rows.
 *
 * Safe to re-run: only decks with zero competitive_deck_cards are selected,
 * and each deck is checked again right before its write. Decks with cards are
 * never touched. Needs DATABASE_URL. Does not start Docker.
 *
 *   npx tsx server/scripts/reimportEmptyDecks.ts --dry-run
 *   npx tsx server/scripts/reimportEmptyDecks.ts --batch-size 50 --max-batches 1
 *
 * Flags:
 *   --dry-run            list what would be fetched/written; no writes, no fetches
 *   --batch-size N       decks per batch (default 50)
 *   --max-batches N      stop after N batches (default: all)
 *   --source S           only this source (default mtgtop8; "all" for every source)
 *   --report FILE        write the per-deck log as JSON lines
 *
 * MTGTop8 requests go through the importer's polite fetch: robots.txt is
 * checked first, one request every 2 s, responses cached in .cache/mtgtop8.
 * Env overrides: MTGTOP8_MIN_DELAY_MS, MTGTOP8_CACHE_DIR, MTGTOP8_CHECK_ROBOTS.
 */
import "dotenv/config";
import { appendFileSync, writeFileSync } from "node:fs";
import { closeDb, getRawClient } from "../db";
import {
  EMPTY_DECK_SQL,
  reimportEmptyDecks,
  type EmptyDeckRow,
} from "../services/reimportEmptyDecks";
import { saveCompetitiveDeck } from "../services/competitiveDeckStore";
import { CardNameResolver } from "../services/cardNameResolver";

process.env.MTGTOP8_CHECK_ROBOTS ??= "1";
process.env.MTGTOP8_MIN_DELAY_MS ??= "2000";
process.env.MTGTOP8_CACHE_DIR ??= ".cache/mtgtop8";
process.env.MTGTOP8_USER_AGENT ??= "mtg-deck-mvp-reimport/1.0 (+https://github.com/alanmolter/MTG)";

type RawRow = {
  id: number;
  source_id: string;
  source: string;
  name: string;
  format: string;
  archetype: string | null;
  author: string | null;
  raw_json: string | null;
};

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function positiveInt(name: string, fallback?: number): number | undefined {
  const raw = arg(name);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${name} must be a positive integer`);
  return n;
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const batchSize = positiveInt("--batch-size", 50)!;
  const maxBatches = positiveInt("--max-batches");
  const sourceArg = arg("--source") ?? "mtgtop8";
  const source = sourceArg === "all" ? undefined : sourceArg;
  const reportFile = arg("--report");

  if (!process.env.DATABASE_URL) {
    console.error("[reimport] DATABASE_URL is not set. Put it in .env and run again.");
    process.exitCode = 1;
    return;
  }
  const pg = await getRawClient();
  if (!pg) {
    console.error("[reimport] could not open the database.");
    process.exitCode = 1;
    return;
  }
  // Loaded lazily so the scraper module reads the env defaults above.
  const { politeFetchText } = await import("../services/mtgtop8Scraper");

  let resolver: CardNameResolver | null = null;
  if (!dryRun) {
    const catalog = (await pg.unsafe("SELECT name, oracle_id FROM cards")) as Array<{ name: string; oracle_id: string | null }>;
    resolver = new CardNameResolver(catalog.map((c) => ({ name: c.name, oracleId: c.oracle_id })));
  }

  // download_status / last_fetch_error exist only after migration
  // 20261016234006_competitive_decks_provenance. Without them: skip, warn once.
  const statusCols = new Set(
    ((await pg.unsafe(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = current_schema() AND table_name = 'competitive_decks'
         AND column_name IN ('download_status', 'last_fetch_error')`,
    )) as Array<{ column_name: string }>).map((c) => c.column_name),
  );
  const canMarkStatus = statusCols.has("download_status");
  if (!dryRun && !canMarkStatus) {
    console.warn("[reimport] download_status column missing (migration not applied): fetch status will not be recorded");
  }
  const markStatus = async (row: EmptyDeckRow, status: "ok" | "failed", error: string | null) => {
    if (!canMarkStatus) return;
    if (statusCols.has("last_fetch_error")) {
      await pg.unsafe(
        "UPDATE competitive_decks SET download_status = $2::deck_download_status, last_fetch_error = $3 WHERE id = $1",
        [row.id, status, error ? error.slice(0, 2000) : null],
      );
    } else {
      await pg.unsafe(
        "UPDATE competitive_decks SET download_status = $2::deck_download_status WHERE id = $1",
        [row.id, status],
      );
    }
  };

  if (reportFile) writeFileSync(reportFile, "");
  console.log(`[reimport] mode=${dryRun ? "DRY-RUN" : "APPLY"} source=${source ?? "all"} batch=${batchSize} maxBatches=${maxBatches ?? "all"}`);

  const report = await reimportEmptyDecks(
    {
      listEmpty: async () => {
        const rows = (await pg.unsafe(EMPTY_DECK_SQL)) as RawRow[];
        return rows.map((row): EmptyDeckRow => ({
          id: Number(row.id),
          sourceId: row.source_id,
          source: row.source,
          name: row.name,
          format: row.format,
          archetype: row.archetype,
          author: row.author,
          rawJson: row.raw_json,
        }));
      },
      fetchText: (url) => politeFetchText(url),
      isStillEmpty: async (row) => {
        const rows = (await pg.unsafe(
          "SELECT 1 FROM competitive_deck_cards WHERE deck_id = $1 LIMIT 1",
          [row.id],
        )) as unknown[];
        return rows.length === 0;
      },
      markStatus,
      save: (deck) =>
        saveCompetitiveDeck(pg as unknown as object, deck, {
          resolveName: resolver ? (n) => resolver!.canonicalName(n) : undefined,
        }),
    },
    {
      dryRun,
      batchSize,
      maxBatches,
      source,
      onBatch: (batch, entries) => {
        for (const e of entries) {
          console.log(
            `[reimport] ${e.outcome.padEnd(17)} id=${e.id} ${e.sourceId}` +
              (e.url ? ` url=${e.url}` : "") +
              (e.mainCards !== undefined ? ` main=${e.mainCards} side=${e.sideCards}` : "") +
              (e.detail ? ` (${e.detail})` : ""),
          );
          if (reportFile) appendFileSync(reportFile, JSON.stringify({ batch, ...e }) + "\n");
        }
        console.log(`[reimport] batch ${batch} done (${entries.length} decks)`);
      },
    },
  );

  const counts = report.log.reduce<Record<string, number>>((acc, e) => {
    acc[e.outcome] = (acc[e.outcome] ?? 0) + 1;
    return acc;
  }, {});
  console.log(
    `[reimport] considered=${report.considered} processed=${report.log.length} batches=${report.batches} ` +
      Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(" "),
  );
  if (report.failed.length > 0) process.exitCode = 1;
}

main()
  .catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[reimport] fatal:", message);
    process.exitCode = 1;
  })
  .finally(() => {
    closeDb()
      .catch(() => undefined)
      .finally(() => process.exit(process.exitCode ?? 0));
  });
