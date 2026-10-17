/**
 * F2 stage 2: release from quarantine the off-size decks that the new
 * sanitizer rule accepts (main 61-63, or 80/81 with Yorion in companion or
 * sideboard; side <= 15). 77, 150 and anything else stays quarantined.
 *
 *   npx tsx server/scripts/unquarantineOffsizeDecks.ts [--apply] [--report f.jsonl]
 *
 * Dry-run by default. --apply only clears archive_reason
 * ('quarantine:offsize_*' -> NULL) on those rows: no DELETE, archived_at and
 * is_training_eligible untouched (the sanitizer --apply recomputes it next).
 * Idempotent: a second run finds nothing to release.
 * With --apply a jsonl report is always written (default
 * reports/unquarantine-<timestamp>.jsonl) with deck_id and the old values,
 * the source for rollback (docs/migrations.md, "F2 offsize").
 */
import "dotenv/config";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { closeDb, getRawClient } from "../db";
import { deckSizeClass } from "../services/trainingQuality";
import { passesSizeRule, UNQUARANTINE_CANDIDATES_SQL, UNQUARANTINE_SQL } from "../services/offsizeDecks";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const apply = process.argv.includes("--apply");
  const report = arg("--report") ?? (apply ? `reports/unquarantine-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl` : undefined);
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set");
  const pg = await getRawClient();
  if (!pg) throw new Error("could not open the database");
  if (report) { mkdirSync(dirname(report), { recursive: true }); writeFileSync(report, ""); }

  const rows = (await pg.unsafe(UNQUARANTINE_CANDIDATES_SQL)) as Array<Record<string, unknown>>;
  console.log(`[unquarantine] mode=${apply ? "APPLY" : "DRY-RUN"} quarantined=${rows.length}`);
  const counts: Record<string, number> = {};
  let released = 0;
  let kept = 0;
  for (const r of rows) {
    const row = { id: Number(r.id), format: String(r.format), mainQtd: Number(r.main_qtd), sideQtd: Number(r.side_qtd), yorionSide: Boolean(r.yorion_side) };
    const cls = deckSizeClass(row.format, row.mainQtd, row.yorionSide);
    const release = passesSizeRule(row);
    let action = release ? "release" : "keep";
    if (release) {
      counts[cls] = (counts[cls] ?? 0) + 1;
      if (apply) {
        const res = (await pg.unsafe(UNQUARANTINE_SQL, [row.id])) as unknown as { count: number };
        released += res.count;
        action = res.count > 0 ? "released" : "already released";
      }
    } else kept++;
    console.log(`[unquarantine] id=${row.id} main=${row.mainQtd} side=${row.sideQtd} yorion=${row.yorionSide} class=${cls} ${r.archive_reason} -> ${action}`);
    if (report)
      appendFileSync(report, JSON.stringify({
        deck_id: row.id, old_archive_reason: r.archive_reason, old_is_training_eligible: r.is_training_eligible,
        old_training_rejection_reason: r.training_rejection_reason, main: row.mainQtd, side: row.sideQtd,
        yorion: row.yorionSide, size_class: cls, action, applied: apply,
      }) + "\n");
  }
  console.log(`[unquarantine] release=${JSON.stringify(counts)} keep=${kept} rows_written=${released}`);
  if (!apply) console.log("[unquarantine] dry-run: nothing written. Re-run with --apply, then sanitizeTrainingData --apply.");
}

main()
  .catch((err: unknown) => {
    console.error("[unquarantine] fatal:", err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  })
  .finally(() => {
    closeDb().catch(() => undefined).finally(() => process.exit(process.exitCode ?? 0));
  });
