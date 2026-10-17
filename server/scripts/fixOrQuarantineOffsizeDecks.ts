/**
 * Fix or quarantine decks whose mainboard is not the format size.
 * Dry-run by default; --apply writes. No DDL, no DELETE.
 *
 *   npx tsx server/scripts/fixOrQuarantineOffsizeDecks.ts [--refetch] [--apply] [--report f.jsonl]
 *
 * --refetch  compare with the live MTGTop8 export (robots.txt, 2 s, cache)
 *
 * fixable_reparse -> deck re-saved from the source (only when the source
 *                    parses to the format size)
 * everything else -> quarantine: archive_reason = 'quarantine:offsize_<class>',
 *                    is_training_eligible = false, archived_at stays NULL
 *                    (not archived; the sanitizer keeps rejecting it on size).
 * within_rule     -> skipped: 61-63 and Yorion 80/81 are eligible (F2 rule);
 *                    use unquarantineOffsizeDecks.ts for rows quarantined before it.
 * Idempotent: rows already carrying the same reason are not touched.
 */
import "dotenv/config";
import { appendFileSync, writeFileSync } from "node:fs";
import { closeDb, getRawClient } from "../db";
import { parseDeckExport, saveCompetitiveDeck } from "../services/competitiveDeckStore";
import { refetchUrls } from "../services/reimportEmptyDecks";
import { CardNameResolver } from "../services/cardNameResolver";
import {
  OFFSIZE_SQL, QUARANTINE_PREFIX, QUARANTINE_SQL, classifyOffsize, targetSize, type OffsizeClass,
} from "../services/offsizeDecks";

process.env.MTGTOP8_CHECK_ROBOTS ??= "1";
process.env.MTGTOP8_MIN_DELAY_MS ??= "2000";
process.env.MTGTOP8_CACHE_DIR ??= ".cache/mtgtop8";
process.env.MTGTOP8_USER_AGENT ??= "mtg-deck-mvp-offsize/1.0 (+https://github.com/alanmolter/MTG)";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const apply = process.argv.includes("--apply");
  const refetch = process.argv.includes("--refetch");
  const reportFile = arg("--report");
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set");
  const pg = await getRawClient();
  if (!pg) throw new Error("could not open the database");
  const { politeFetchText } = await import("../services/mtgtop8Scraper");

  const rows = (await pg.unsafe(OFFSIZE_SQL)) as Array<Record<string, unknown>>;
  if (reportFile) writeFileSync(reportFile, "");
  console.log(`[offsize] mode=${apply ? "APPLY" : "DRY-RUN"} refetch=${refetch} decks=${rows.length}`);

  let resolver: CardNameResolver | null = null;
  const counts: Record<string, number> = {};
  let written = 0;
  for (const r of rows) {
    const id = Number(r.id);
    const base = {
      id, format: String(r.format), mainQtd: Number(r.main_qtd), sideQtd: Number(r.side_qtd),
      yorionSide: Boolean(r.yorion_side),
    };
    let parsed: ReturnType<typeof parseDeckExport> = null;
    let detail = "";
    if (refetch) {
      const url = refetchUrls({
        id, sourceId: String(r.source_id), source: String(r.source), name: String(r.name),
        format: String(r.format), archetype: null, author: null, rawJson: null,
      })[0];
      if (url) {
        try {
          const body = await politeFetchText(url);
          parsed = body ? parseDeckExport(body) : null;
          if (!parsed) detail = "source fetch had no deck";
        } catch (err) {
          detail = `source fetch failed: ${err instanceof Error ? err.message : String(err)}`;
        }
      }
    }
    const sourceMain = parsed ? parsed.mainboard.reduce((s, c) => s + c.quantity, 0) : null;
    const sourceSide = parsed ? parsed.sideboard.reduce((s, c) => s + c.quantity, 0) : null;
    const cls: OffsizeClass = classifyOffsize({ ...base, sourceMain, sourceSide });
    counts[cls] = (counts[cls] ?? 0) + 1;
    let action = cls === "fixable_reparse" ? "re-save" : cls === "within_rule" ? "skip (eligible under F2 rule)" : "quarantine";
    if (apply && cls !== "within_rule") {
      if (cls === "fixable_reparse" && parsed) {
        if (!resolver) {
          const cat = (await pg.unsafe("SELECT name, oracle_id FROM cards ORDER BY (oracle_id IS NULL), id")) as Array<{ name: string; oracle_id: string | null }>;
          resolver = new CardNameResolver(cat.map((c) => ({ name: c.name, oracleId: c.oracle_id })));
        }
        const res = await saveCompetitiveDeck(pg as unknown as object, {
          sourceId: String(r.source_id), source: String(r.source), name: String(r.name), format: String(r.format),
          archetype: (r.archetype as string | null) ?? null, author: (r.author as string | null) ?? null,
          mainboard: parsed.mainboard, sideboard: parsed.sideboard,
        }, { resolveName: (n) => resolver!.canonicalName(n) });
        if (res.imported) written += 1;
        action = res.imported ? "re-saved" : "re-save failed";
      } else {
        const res = (await pg.unsafe(QUARANTINE_SQL, [id, QUARANTINE_PREFIX + cls])) as unknown as { count: number };
        written += res.count;
        action = res.count > 0 ? "quarantined" : "already quarantined";
      }
    }
    const line = { id, source_id: r.source_id, format: base.format, main: base.mainQtd, side: base.sideQtd,
      yorion_side: base.yorionSide, source_main: sourceMain, source_side: sourceSide, class: cls, action, detail: detail || undefined,
      target: targetSize(base.format) };
    console.log(`[offsize] id=${id} ${r.source_id} ${base.format} main=${base.mainQtd} side=${base.sideQtd}` +
      (sourceMain != null ? ` src=${sourceMain}/${sourceSide}` : "") + ` -> ${cls} (${action})${detail ? " " + detail : ""}`);
    if (reportFile) appendFileSync(reportFile, JSON.stringify(line) + "\n");
  }
  console.log(`[offsize] classes: ${JSON.stringify(counts)} rows_written=${written}`);
  if (!apply) console.log("[offsize] dry-run: nothing written. Re-run with --apply.");
}

main()
  .catch((err: unknown) => {
    console.error("[offsize] fatal:", err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  })
  .finally(() => {
    closeDb().catch(() => undefined).finally(() => process.exit(process.exitCode ?? 0));
  });
