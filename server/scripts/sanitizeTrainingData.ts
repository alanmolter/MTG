/**
 * Audits imported decklists and quarantines bad rows from ML training.
 *
 * Default mode is read-only. `--apply` writes eligibility metadata and removes
 * only impossible self-synergy links (card1_id = card2_id). It never deletes
 * imported decks, so repaired importers can recover their source rows.
 */
import "dotenv/config";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { count, eq, sql } from "drizzle-orm";
import {
  cardSynergies,
  competitiveDeckCards,
  competitiveDecks,
  forgeMatches,
  trainingRuns,
} from "../../drizzle/schema";
import { closeDb, getDb } from "../db";
import {
  evaluateDataReadiness,
  validateTrainingDeck,
} from "../services/trainingQuality";

const APPLY = process.argv.includes("--apply");
const REQUIRE_READY = process.argv.includes("--require-ready");
/** --no-record: pure read-only audit, skips the training_runs row (refused with --apply). */
const NO_RECORD = process.argv.includes("--no-record");
if (APPLY && NO_RECORD) throw new Error("--no-record cannot be combined with --apply");
/**
 * Rollback report (jsonl). With --apply it is always written (default
 * reports/sanitize-<timestamp>.jsonl): one line per deck whose eligibility or
 * rejection reason changes, with the previous values. See docs/migrations.md.
 */
function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const REPORT =
  argValue("--report") ??
  (APPLY
    ? `reports/sanitize-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`
    : undefined);

function bar(value: number, total: number, width = 28): string {
  const filled = total ? Math.round((value / total) * width) : 0;
  return "[" + "█".repeat(filled) + "░".repeat(width - filled) + "]";
}

async function main(): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("Banco indisponível");

  console.log("\n════════════════════════════════════════════════════════════");
  console.log("  QUALITY GATE — dados de treino");
  console.log(
    `  Modo: ${APPLY ? "APLICAR quarentena segura" : "AUDITORIA (somente leitura)"}`
  );
  console.log("════════════════════════════════════════════════════════════");

  const [decks, deckCards] = await Promise.all([
    db.select().from(competitiveDecks),
    db.select().from(competitiveDeckCards),
  ]);
  const cardsByDeck = new Map<number, typeof deckCards>();
  for (const card of deckCards) {
    const bucket = cardsByDeck.get(card.deckId) ?? [];
    bucket.push(card);
    cardsByDeck.set(card.deckId, bucket);
  }

  if (REPORT) {
    mkdirSync(dirname(REPORT), { recursive: true });
    writeFileSync(REPORT, "");
  }
  const sizeClasses: Record<string, { total: number; eligible: number }> = {};
  let changed = 0;
  let valid = 0;
  const rejected: Array<{ id: number; reason: string }> = [];
  const digest = createHash("sha256");
  for (const deck of decks) {
    const validation = validateTrainingDeck({
      format: deck.format,
      isSynthetic: deck.isSynthetic,
      cards: (cardsByDeck.get(deck.id) ?? []).map(card => ({
        cardName: card.cardName,
        quantity: card.quantity,
        section: card.section,
      })),
    });
    digest.update(
      `${deck.id}:${deck.importedAt.toISOString()}:${validation.eligible};`
    );
    const bucket = (sizeClasses[validation.sizeClass] ??= { total: 0, eligible: 0 });
    bucket.total++;
    if (validation.eligible) bucket.eligible++;
    const newReason = validation.eligible ? null : validation.reasons.join(",");
    if (
      deck.isTrainingEligible !== validation.eligible ||
      (deck.trainingRejectionReason ?? null) !== newReason
    ) {
      changed++;
      if (REPORT)
        appendFileSync(
          REPORT,
          JSON.stringify({
            deck_id: deck.id,
            old_is_training_eligible: deck.isTrainingEligible,
            old_training_rejection_reason: deck.trainingRejectionReason ?? null,
            old_training_quality_checked_at:
              deck.trainingQualityCheckedAt?.toISOString() ?? null,
            new_is_training_eligible: validation.eligible,
            new_training_rejection_reason: newReason,
            size_class: validation.sizeClass,
            main: validation.mainboardCards,
            side: validation.sideboardCards,
            applied: APPLY,
          }) + "\n"
        );
    }
    if (validation.eligible) valid++;
    else rejected.push({ id: deck.id, reason: validation.reasons.join(",") });

    if (APPLY) {
      await db
        .update(competitiveDecks)
        .set({
          isTrainingEligible: validation.eligible,
          trainingRejectionReason: validation.eligible
            ? null
            : validation.reasons.join(","),
          trainingQualityCheckedAt: new Date(),
        })
        .where(eq(competitiveDecks.id, deck.id));
    }
  }

  const [{ value: invalidSynergyCount }] = await db
    .select({ value: count() })
    .from(cardSynergies)
    .where(sql`${cardSynergies.card1Id} = ${cardSynergies.card2Id}`);
  const [{ value: realMatchCount }] = await db
    .select({ value: count() })
    .from(forgeMatches);

  if (APPLY && Number(invalidSynergyCount) > 0) {
    await db
      .delete(cardSynergies)
      .where(sql`${cardSynergies.card1Id} = ${cardSynergies.card2Id}`);
  }

  const postCleanupInvalid = APPLY ? 0 : Number(invalidSynergyCount);
  const gates = evaluateDataReadiness({
    validDecks: valid,
    invalidSynergyCount: postCleanupInvalid,
  });
  const fingerprint = digest.digest("hex").slice(0, 16);

  console.log(`\n  Decks importados       : ${decks.length}`);
  console.log(
    `  Elegíveis para treino  : ${bar(valid, decks.length)} ${valid}`
  );
  console.log(
    `  Em quarentena          : ${bar(rejected.length, decks.length)} ${rejected.length}`
  );
  console.log(`  Mudanças de elegib.    : ${changed}${REPORT ? ` (relatório: ${REPORT})` : ""}`);
  console.log(
    `  Classes de tamanho     : ${Object.entries(sizeClasses)
      .map(([k, v]) => `${k}=${v.eligible}/${v.total}`)
      .join(" ")}`
  );
  console.log(`  Partidas Forge gravadas: ${Number(realMatchCount)}`);
  console.log(
    `  Auto-sinergias         : ${Number(invalidSynergyCount)}${APPLY ? " → 0" : ""}`
  );
  console.log(`  Snapshot               : ${fingerprint}`);
  if (rejected.length) {
    const samples = rejected
      .slice(0, 5)
      .map(d => `#${d.id}: ${d.reason}`)
      .join("\n    ");
    console.log(`\n  Exemplos rejeitados:\n    ${samples}`);
  }

  if (!NO_RECORD) await db.insert(trainingRuns).values({
    runKind: "data_quality",
    status: gates.passed ? "ready" : "blocked",
    datasetFingerprint: fingerprint,
    validDecks: valid,
    rejectedDecks: rejected.length,
    realMatchCount: Number(realMatchCount),
    invalidSynergyCount: postCleanupInvalid,
    gateReport: {
      failures: gates.failures,
      apply: APPLY,
      // Size class per deck is derived in code (validateTrainingDeck); no
      // column for it on competitive_decks, so the run keeps the histogram.
      sizeClasses,
      eligibilityChanges: changed,
      rollbackReport: REPORT ?? null,
    },
    completedAt: new Date(),
  });

  if (gates.passed) {
    console.log(
      "\n  ✓ Dados prontos para treino. A promoção ainda exigirá partidas Forge e um checkpoint melhor que o baseline."
    );
  } else {
    console.log(`\n  BLOQUEADO: ${gates.failures.join(", ")}`);
    console.log(
      "  Nenhum checkpoint será promovido e nenhum peso deve ser atualizado por self-play heurístico."
    );
  }
  console.log("════════════════════════════════════════════════════════════\n");

  if (REQUIRE_READY && !gates.passed) process.exitCode = 2;
}

main()
  .catch(error => {
    console.error("[sanitizeTrainingData] erro:", error?.message ?? error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDb();
  });
