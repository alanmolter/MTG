/**
 * Re-import competitive decks that currently have no card rows.
 *
 * Safe to re-run: the query is only decks with zero competitive_deck_cards.
 * Decks that already have cards are left alone. Needs DATABASE_URL in .env
 * (or the environment). Does not start Docker.
 *
 *   npm run db:reimport-empty-decks
 */
import "dotenv/config";
import { closeDb, getRawClient } from "../db";
import {
  EMPTY_DECK_SQL,
  reimportEmptyDecks,
  type EmptyDeckRow,
} from "../services/reimportEmptyDecks";
import { saveCompetitiveDeck } from "../services/competitiveDeckStore";

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

async function fetchText(url: string): Promise<string | null> {
  const response = await fetch(url, {
    headers: { "User-Agent": "MTG-RL-reimport/1.0" },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) return null;
  return response.text();
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error(
      "[reimport] DATABASE_URL is not set. Put it in .env and run again."
    );
    process.exitCode = 1;
    return;
  }
  const pg = await getRawClient();
  if (!pg) {
    console.error("[reimport] could not open the database.");
    process.exitCode = 1;
    return;
  }

  const report = await reimportEmptyDecks({
    listEmpty: async () => {
      const rows = (await pg.unsafe(EMPTY_DECK_SQL)) as RawRow[];
      return rows.map(
        (row): EmptyDeckRow => ({
          id: Number(row.id),
          sourceId: row.source_id,
          source: row.source,
          name: row.name,
          format: row.format,
          archetype: row.archetype,
          author: row.author,
          rawJson: row.raw_json,
        })
      );
    },
    fetchText,
    save: deck => saveCompetitiveDeck(pg as unknown as object, deck),
  });

  console.log(
    `[reimport] considered=${report.considered} reimported=${report.reimported} ` +
      `skipped=${report.skipped.length} failed=${report.failed.length}`
  );
  for (const line of report.skipped) console.log(`[reimport] skip ${line}`);
  for (const line of report.failed) console.error(`[reimport] fail ${line}`);
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
