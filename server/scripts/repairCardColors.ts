/**
 * repairCardColors.ts — Anomaly-3 retroactive fix (2026-04-23)
 *
 * Before the seed-scryfall.ts / sync-bulk.ts fix, DFCs and split cards
 * whose top-level `colors` field was undefined were stored in the database
 * as NULL or "" and displayed as "C" (colorless). Example from production:
 *     Aclazotz, Deepest Betrayal (Black MDFC) → shown as "C"
 *
 * The seed/sync scripts now use resolveCardColors(), but cards already in
 * the database keep their bad colors until we refetch and rewrite them.
 *
 * This script:
 *   1. Finds all cards in the database with NULL or empty `colors`.
 *   2. For each, pulls fresh Scryfall data via the public API.
 *   3. Re-resolves colors with the same fallback chain used by seed.
 *   4. Updates the row in place — no delete, no re-seed.
 *
 * Usage:
 *     npx tsx server/scripts/repairCardColors.ts            # dry-run
 *     npx tsx server/scripts/repairCardColors.ts --apply    # actually write
 *     npx tsx server/scripts/repairCardColors.ts --limit=50 # cap for testing
 *
 * Rate-limit: Scryfall requires 50-100ms between requests. We sleep 120ms.
 * Recovery: re-runnable. If a request fails, the row is left untouched and
 * the next run retries it.
 */

import "dotenv/config";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { cards } from "../../drizzle/schema";
import { eq, or, isNull, sql } from "drizzle-orm";

const SCRYFALL_CARD_BY_ID = "https://api.scryfall.com/cards";
const REQUEST_DELAY_MS    = 120; // rate-limit friendly

// ── CLI args ─────────────────────────────────────────────────────────────
const args  = process.argv.slice(2);
const APPLY = args.includes("--apply");
const LIMIT = (() => {
  const arg = args.find((a) => a.startsWith("--limit="));
  return arg ? parseInt(arg.split("=")[1], 10) : 0; // 0 = no limit
})();

// ── The same resolver used by seed-scryfall + sync-bulk ──────────────────
function resolveCardColors(card: any): string | null {
  if (Array.isArray(card.colors) && card.colors.length > 0) {
    return card.colors.join("");
  }
  if (Array.isArray(card.card_faces) && card.card_faces.length > 0) {
    const union = new Set<string>();
    for (const face of card.card_faces) {
      if (Array.isArray(face.colors)) for (const c of face.colors) union.add(c);
    }
    if (union.size > 0) {
      return ["W", "U", "B", "R", "G"].filter((c) => union.has(c)).join("");
    }
  }
  if (Array.isArray(card.color_identity) && card.color_identity.length > 0) {
    return ["W", "U", "B", "R", "G"]
      .filter((c) => card.color_identity.includes(c))
      .join("");
  }
  return null;
}

async function fetchScryfallCard(scryfallId: string): Promise<any | null> {
  try {
    const res = await fetch(`${SCRYFALL_CARD_BY_ID}/${scryfallId}`);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function main() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.error("[repair-colors] DATABASE_URL não configurado.");
    process.exit(1);
  }

  const client = postgres(dbUrl, { max: 1, idle_timeout: 5, connect_timeout: 10 });
  const db     = drizzle(client);

  console.log("\n════════════════════════════════════════════════════════");
  console.log("  REPAIR CARD COLORS — Anomaly-3 retroactive fix");
  console.log("════════════════════════════════════════════════════════");
  console.log(`  Modo    : ${APPLY ? "APPLY (gravando)" : "DRY-RUN (sem gravar)"}`);
  console.log(`  Limite  : ${LIMIT || "sem limite"}`);
  console.log("────────────────────────────────────────────────────────");

  try {
    // Pick rows where colors is NULL OR empty string (both are bugged states).
    const brokenRows = await db
      .select({
        id: cards.id,
        scryfallId: cards.scryfallId,
        name: cards.name,
        colors: cards.colors,
      })
      .from(cards)
      .where(or(isNull(cards.colors), eq(cards.colors, "")));

    const targets = LIMIT > 0 ? brokenRows.slice(0, LIMIT) : brokenRows;
    console.log(`  Cartas com cor nula/vazia: ${brokenRows.length}`);
    console.log(`  A processar nesta run     : ${targets.length}`);
    console.log("────────────────────────────────────────────────────────");

    let fixed = 0;
    let stillColorless = 0;
    let failed = 0;

    for (let i = 0; i < targets.length; i++) {
      const row = targets[i];
      const sc  = await fetchScryfallCard(row.scryfallId);
      if (!sc) {
        failed++;
        process.stdout.write(
          `\r  [${i + 1}/${targets.length}] FAIL ${row.name.slice(0, 40).padEnd(40)}`
        );
      } else {
        const resolved = resolveCardColors(sc);
        const newValue = resolved ?? ""; // persist "" (colorless) distinct from null
        const changed  = (row.colors ?? "") !== newValue;

        if (changed && resolved && resolved.length > 0) {
          fixed++;
          if (APPLY) {
            await db
              .update(cards)
              .set({ colors: newValue, updatedAt: new Date() })
              .where(eq(cards.id, row.id));
          }
          process.stdout.write(
            `\r  [${i + 1}/${targets.length}] FIX  ${row.name.slice(0, 28).padEnd(28)} → ${newValue}`.padEnd(80)
          );
        } else {
          stillColorless++;
          // Ensure we at least pin it to "" instead of NULL so future queries
          // can distinguish "genuinely colorless" from "never resolved".
          if (APPLY && row.colors === null) {
            await db
              .update(cards)
              .set({ colors: "", updatedAt: new Date() })
              .where(eq(cards.id, row.id));
          }
        }
      }

      // Rate-limit politely
      await new Promise((r) => setTimeout(r, REQUEST_DELAY_MS));
    }

    process.stdout.write("\n");
    console.log("════════════════════════════════════════════════════════");
    console.log("  RESULTADO");
    console.log("════════════════════════════════════════════════════════");
    console.log(`  Cartas corrigidas (cor real) : ${fixed}`);
    console.log(`  Realmente incolor ou null    : ${stillColorless}`);
    console.log(`  Falhas HTTP                  : ${failed}`);
    if (!APPLY) {
      console.log("  (dry-run — re-execute com --apply para gravar)");
    }
    console.log("════════════════════════════════════════════════════════\n");
  } catch (err: any) {
    console.error("\n[repair-colors] erro fatal:", err?.message ?? err);
    process.exitCode = 1;
  } finally {
    try { await client.end({ timeout: 3 }); } catch { /* noop */ }
  }
}

main().finally(() => process.exit(process.exitCode ?? 0));
