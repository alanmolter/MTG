/**
 * Audits imported decklists and quarantines bad rows from ML training.
 *
 * Default mode is read-only. `--apply` writes eligibility metadata and removes
 * only impossible self-synergy links (card1_id = card2_id). It never deletes
 * imported decks, so repaired importers can recover their source rows.
 */
import "dotenv/config";
import { createHash } from "node:crypto";
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

  await db.insert(trainingRuns).values({
    runKind: "data_quality",
    status: gates.passed ? "ready" : "blocked",
    datasetFingerprint: fingerprint,
    validDecks: valid,
    rejectedDecks: rejected.length,
    realMatchCount: Number(realMatchCount),
    invalidSynergyCount: postCleanupInvalid,
    gateReport: { failures: gates.failures, apply: APPLY },
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
