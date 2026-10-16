/**
 * Archive Goldfish (source dropped) and Moxfield fallback placeholder decks.
 * Dry-run by default; --apply writes, in one transaction. Never deletes.
 *
 *   npx tsx server/scripts/archiveDeadDecks.ts               # dry-run
 *   npx tsx server/scripts/archiveDeadDecks.ts --apply --expect 333
 *
 * --expect N aborts (no writes) unless exactly N candidates are found.
 */
import "dotenv/config";
import { closeDb, getRawClient } from "../db";
import {
  ARCHIVE_CANDIDATES_SQL,
  STATUS_COLUMNS_SQL,
  planArchive,
  type ArchiveCandidate,
} from "../services/archiveDeadDecks";

async function main() {
  const apply = process.argv.includes("--apply");
  const expectIdx = process.argv.indexOf("--expect");
  const expected = expectIdx >= 0 ? Number(process.argv[expectIdx + 1]) : undefined;
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set");
  const pg = await getRawClient();
  if (!pg) throw new Error("could not open the database");

  const rows = (await pg.unsafe(ARCHIVE_CANDIDATES_SQL)) as Array<Record<string, unknown>>;
  const candidates: ArchiveCandidate[] = rows.map((r) => ({
    id: Number(r.id),
    source: String(r.source),
    sourceId: String(r.source_id),
    format: String(r.format),
    isSynthetic: Boolean(r.is_synthetic),
    reason: r.reason as ArchiveCandidate["reason"],
  }));
  const columns = ((await pg.unsafe(STATUS_COLUMNS_SQL)) as Array<{ column_name: string }>).map((c) => c.column_name);
  const plan = planArchive(candidates, columns);

  console.log(`[archive] mode=${apply ? "APPLY" : "DRY-RUN"} candidates=${candidates.length}`);
  console.log(`[archive] by source: ${JSON.stringify(plan.bySource)} by reason: ${JSON.stringify(plan.byReason)}`);
  console.log(`[archive] status columns present: ${plan.statusColumnsPresent}`);
  for (const c of candidates) console.log(`[archive] candidate id=${c.id} ${c.source} ${c.sourceId} ${c.format} -> ${c.reason}`);
  for (const s of plan.statements) console.log(`[archive] would run: ${s.description}`);
  for (const p of plan.pending) console.log(`[archive] pending: ${p}`);

  if (expected !== undefined && candidates.length !== expected) {
    console.error(`[archive] expected ${expected} candidates, found ${candidates.length}; aborting without writes`);
    process.exitCode = 1;
    return;
  }
  if (!apply) {
    console.log("[archive] dry-run: nothing written. Re-run with --apply to write.");
    return;
  }
  const pgTx = pg as unknown as { begin: <T>(fn: (tx: { unsafe: (q: string, p?: unknown[]) => Promise<{ count: number }> }) => Promise<T>) => Promise<T> };
  await pgTx.begin(async (tx) => {
    for (const s of plan.statements) {
      const res = await tx.unsafe(s.sql, s.params);
      console.log(`[archive] ${s.description}: ${res.count} rows`);
    }
  });
  console.log("[archive] done");
}

main()
  .catch((err: unknown) => {
    console.error("[archive] fatal:", err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  })
  .finally(() => {
    closeDb().catch(() => undefined).finally(() => process.exit(process.exitCode ?? 0));
  });
