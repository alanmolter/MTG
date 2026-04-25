/**
 * repairArenaFlag.ts — Backfill `cards.is_arena` from Scryfall's `games[]`.
 *
 * The seed-scryfall.ts logic was historically too permissive — it set
 * `is_arena=1` for any card with `arena_id`, `set_type=alchemy`, or
 * `digital=true`. That overflowed into MTGO-only digital reprints and
 * legacy cards no longer on the Arena client. The canonical Scryfall
 * signal is `games[]` containing the literal string "arena".
 *
 * The seed/sync paths now use that canonical signal, but rows that were
 * imported under the old logic keep their bugged is_arena value until
 * we rewrite them. This script does that, idempotently, in bulk.
 *
 * Strategy:
 *   1. Audit the current is_arena distribution (count 0 vs 1).
 *   2. Download Scryfall's default-cards bulk JSON.
 *   3. Build a map { scryfall_id → correctIsArena } from the bulk.
 *   4. Read the local cards table (id, scryfall_id, is_arena).
 *   5. For each row whose computed is_arena differs from the stored one,
 *      push to an update batch. Apply in chunks of 500.
 *   6. Audit again and report deltas.
 *
 * Usage:
 *     npx tsx server/scripts/repairArenaFlag.ts             # dry-run
 *     npx tsx server/scripts/repairArenaFlag.ts --apply     # actually write
 *     npx tsx server/scripts/repairArenaFlag.ts --limit=200 # cap mismatches
 *
 * Recovery: re-runnable. Idempotent — applying twice yields the same
 * end-state because the comparison is content-based.
 */

import "dotenv/config";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { cards } from "../../drizzle/schema";
import { eq, sql } from "drizzle-orm";

const SCRYFALL_BULK_META_URL = "https://api.scryfall.com/bulk-data";
const META_TIMEOUT_MS         = 20_000;
const DOWNLOAD_TIMEOUT_MS     = 180_000;
const UPDATE_BATCH_SIZE       = 500;

// ── CLI args ─────────────────────────────────────────────────────────────
const args  = process.argv.slice(2);
const APPLY = args.includes("--apply");
const LIMIT = (() => {
  const arg = args.find((a) => a.startsWith("--limit="));
  return arg ? parseInt(arg.split("=")[1], 10) : 0; // 0 = no limit
})();

// ── Helpers ──────────────────────────────────────────────────────────────

function isArenaFromBulk(card: any): 0 | 1 {
  return Array.isArray(card.games) && card.games.includes("arena") ? 1 : 0;
}

async function fetchBulkUrl(): Promise<string> {
  const ctrl    = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), META_TIMEOUT_MS);
  try {
    const res = await fetch(SCRYFALL_BULK_META_URL, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`bulk-data meta HTTP ${res.status}`);
    const meta = await res.json();
    const entry = (meta.data ?? []).find((d: any) => d.type === "default_cards");
    if (!entry?.download_uri) throw new Error("default_cards entry missing download_uri");
    return entry.download_uri as string;
  } finally {
    clearTimeout(timeout);
  }
}

async function downloadBulkArray(url: string): Promise<any[]> {
  const ctrl    = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), DOWNLOAD_TIMEOUT_MS);
  try {
    process.stdout.write("  Baixando default-cards bulk JSON ");
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`bulk download HTTP ${res.status}`);
    const json = await res.json();
    if (!Array.isArray(json)) throw new Error("bulk JSON not an array");
    process.stdout.write(`(${json.length} cartas)\n`);
    return json;
  } finally {
    clearTimeout(timeout);
  }
}

// ── Main ─────────────────────────────────────────────────────────────────

async function main() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.error("[repair-arena] DATABASE_URL não configurado.");
    process.exit(1);
  }

  const client = postgres(dbUrl, { max: 1, idle_timeout: 5, connect_timeout: 10 });
  const db     = drizzle(client);

  console.log("\n════════════════════════════════════════════════════════");
  console.log("  REPAIR ARENA FLAG — backfill cards.is_arena from games[]");
  console.log("════════════════════════════════════════════════════════");
  console.log(`  Modo    : ${APPLY ? "APPLY (gravando)" : "DRY-RUN (sem gravar)"}`);
  console.log(`  Limite  : ${LIMIT > 0 ? `${LIMIT} mismatches` : "sem limite"}`);
  console.log("────────────────────────────────────────────────────────");

  try {
    // ── Audit before ─────────────────────────────────────────────────────
    const auditBefore = await db.execute(sql`
      SELECT
        COUNT(*)                                    AS total,
        SUM(CASE WHEN is_arena = 1 THEN 1 ELSE 0 END) AS arena,
        SUM(CASE WHEN is_arena = 0 OR is_arena IS NULL THEN 1 ELSE 0 END) AS non_arena
      FROM cards
    `);
    const before = (auditBefore as any)[0] ?? {};
    const total      = Number(before.total ?? 0);
    const beforeArena = Number(before.arena ?? 0);
    const beforeNon   = Number(before.non_arena ?? 0);
    const beforePct   = total > 0 ? ((beforeArena / total) * 100).toFixed(1) : "0.0";
    console.log(`  Estado atual:`);
    console.log(`    Total                : ${total}`);
    console.log(`    is_arena=1           : ${beforeArena} (${beforePct}%)`);
    console.log(`    is_arena=0 ou null   : ${beforeNon}`);
    console.log("────────────────────────────────────────────────────────");

    if (total === 0) {
      console.log("  Banco vazio. Rode `npm run seed:scryfall` ou `tsx server/sync-bulk.ts` primeiro.");
      return;
    }

    // ── Fetch Scryfall bulk + build map ──────────────────────────────────
    console.log("  Consultando Scryfall bulk-data meta...");
    const bulkUrl = await fetchBulkUrl();
    const bulk    = await downloadBulkArray(bulkUrl);

    const correctById = new Map<string, 0 | 1>();
    let bulkArenaCount = 0;
    for (const c of bulk) {
      if (typeof c.id !== "string") continue;
      const v = isArenaFromBulk(c);
      correctById.set(c.id, v);
      if (v === 1) bulkArenaCount++;
    }
    console.log(`  Scryfall bulk: ${bulk.length} cartas, ${bulkArenaCount} marcadas como Arena`);
    console.log("────────────────────────────────────────────────────────");

    // ── Compare with local rows ──────────────────────────────────────────
    const localRows = await db
      .select({
        id:         cards.id,
        scryfallId: cards.scryfallId,
        isArena:    cards.isArena,
      })
      .from(cards);

    type Mismatch = { id: number; from: number; to: 0 | 1 };
    const mismatches: Mismatch[] = [];
    let unknownInBulk = 0;
    for (const row of localRows) {
      const desired = correctById.get(row.scryfallId);
      if (desired === undefined) { unknownInBulk++; continue; }
      const current = (row.isArena ?? 0) as number;
      if (current !== desired) {
        mismatches.push({ id: row.id, from: current, to: desired });
      }
    }

    const flipUp   = mismatches.filter(m => m.to === 1).length;
    const flipDown = mismatches.filter(m => m.to === 0).length;

    console.log(`  Comparação:`);
    console.log(`    Cartas locais não encontradas no bulk : ${unknownInBulk}`);
    console.log(`    Mismatches totais                     : ${mismatches.length}`);
    console.log(`      0 → 1 (faltava marcar como Arena)   : ${flipUp}`);
    console.log(`      1 → 0 (estava marcada errada)       : ${flipDown}`);
    console.log("────────────────────────────────────────────────────────");

    const targets = LIMIT > 0 ? mismatches.slice(0, LIMIT) : mismatches;
    if (targets.length === 0) {
      console.log("  Nada a fazer — is_arena já está consistente com Scryfall.");
      return;
    }

    if (!APPLY) {
      console.log(`  DRY-RUN: ${targets.length} updates pendentes.`);
      console.log("  Re-execute com --apply para gravar.");
      return;
    }

    // ── Apply in batches ─────────────────────────────────────────────────
    let written = 0;
    for (let i = 0; i < targets.length; i += UPDATE_BATCH_SIZE) {
      const batch = targets.slice(i, i + UPDATE_BATCH_SIZE);
      // Single multi-row UPDATE via VALUES join; one round-trip per batch.
      // Postgres-friendly idiom; works on Drizzle's `db.execute(sql\`...\`)`.
      const valuesFragments = batch.map(
        (t) => sql`(${t.id}::int, ${t.to}::int)`
      );
      const valuesSql = sql.join(valuesFragments, sql`, `);
      await db.execute(sql`
        UPDATE cards AS c
        SET is_arena   = v.target,
            updated_at = NOW()
        FROM (VALUES ${valuesSql}) AS v(id, target)
        WHERE c.id = v.id
      `);
      written += batch.length;
      process.stdout.write(`\r  [apply] ${written}/${targets.length} rows updated`);
    }
    process.stdout.write("\n");

    // ── Audit after ──────────────────────────────────────────────────────
    const auditAfter = await db.execute(sql`
      SELECT SUM(CASE WHEN is_arena = 1 THEN 1 ELSE 0 END) AS arena
      FROM cards
    `);
    const afterArena = Number((auditAfter as any)[0]?.arena ?? 0);
    const afterPct   = total > 0 ? ((afterArena / total) * 100).toFixed(1) : "0.0";

    console.log("════════════════════════════════════════════════════════");
    console.log("  RESULTADO");
    console.log("════════════════════════════════════════════════════════");
    console.log(`  Cartas atualizadas      : ${written}`);
    console.log(`  is_arena=1 antes        : ${beforeArena} (${beforePct}%)`);
    console.log(`  is_arena=1 depois       : ${afterArena} (${afterPct}%)`);
    console.log(`  Δ Arena                 : ${afterArena - beforeArena > 0 ? "+" : ""}${afterArena - beforeArena}`);
    console.log("════════════════════════════════════════════════════════\n");
  } catch (err: any) {
    console.error("\n[repair-arena] erro fatal:", err?.message ?? err);
    if (err?.cause) console.error("  cause:", err.cause?.message ?? err.cause);
    process.exitCode = 1;
  } finally {
    try { await client.end({ timeout: 3 }); } catch { /* noop */ }
  }
}

main().finally(() => process.exit(process.exitCode ?? 0));
