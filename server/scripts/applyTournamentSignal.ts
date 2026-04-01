/**
 * applyTournamentSignal.ts
 *
 * Alimenta o card_learning com sinal REAL de torneios importados.
 *
 * Lógica:
 *   - Cartas de decks do mainboard (competitive_deck_cards) recebem +0.10
 *   - Cartas que aparecem em múltiplos decks recebem bônus acumulado
 *   - Cartas de sideboard recebem +0.03 (relevantes mas menos centrais)
 *   - Apenas decks reais (is_synthetic = false) são considerados
 *   - Apenas decks importados nas últimas 48h são processados (novidade)
 *
 * Isso quebra o loop circular do Self-Play: o sinal vem de partidas
 * reais de torneio, não de simulações heurísticas com Math.random().
 *
 * Executado automaticamente pelo import-and-train.ts após os scrapers.
 */

import "dotenv/config";
import { and, eq, gte, sql } from "drizzle-orm";
import {
  cardLearning,
  competitiveDeckCards,
  competitiveDecks,
} from "../../drizzle/schema";
import { closeDb, getDb } from "../db";
import { getCardLearningQueue } from "../services/cardLearningQueue";

// Deltas por seção — mainboard vale muito mais que sideboard
const DELTA_MAINBOARD = 0.10;
const DELTA_SIDEBOARD = 0.03;

// Janela de novidade: só processa decks importados nas últimas 48h
// Evita reprocessar os mesmos decks a cada run
const HOURS_WINDOW = 48;

function divider(label: string) {
  console.log(`\n${"─".repeat(56)}`);
  console.log(`  ${label}`);
  console.log("─".repeat(56));
}

export async function applyTournamentSignal(): Promise<{
  cardsReinforced: number;
  totalDelta: number;
  decksProcessed: number;
}> {
  const db = await getDb();
  if (!db) {
    console.warn("[TournamentSignal] Banco indisponível — pulando");
    return { cardsReinforced: 0, totalDelta: 0, decksProcessed: 0 };
  }

  divider("SINAL DE TORNEIO → card_learning");

  // ── 1. Buscar decks reais importados nas últimas 48h ─────────────
  const cutoff = new Date(Date.now() - HOURS_WINDOW * 60 * 60 * 1000);

  const recentDecks = await db
    .select({ id: competitiveDecks.id, name: competitiveDecks.name, format: competitiveDecks.format })
    .from(competitiveDecks)
    .where(
      and(
        eq(competitiveDecks.isSynthetic, false),
        gte(competitiveDecks.importedAt, cutoff)
      )
    );

  if (recentDecks.length === 0) {
    console.log("  Nenhum deck novo nas últimas 48h — sinal já aplicado");
    return { cardsReinforced: 0, totalDelta: 0, decksProcessed: 0 };
  }

  console.log(`  Decks recentes (últimas ${HOURS_WINDOW}h): ${recentDecks.length}`);

  // ── 2. Buscar todas as cartas desses decks ────────────────────────
  const deckIds = recentDecks.map((d) => d.id);

  // Acumular deltas por carta (mesma carta em vários decks = delta somado)
  const deltaMap = new Map<string, number>();

  // Buscar em batches de 50 para não sobrecarregar o banco
  const BATCH_SIZE = 50;
  for (let i = 0; i < deckIds.length; i += BATCH_SIZE) {
    const batch = deckIds.slice(i, i + BATCH_SIZE);

    const rows = await db
      .select({
        cardName: competitiveDeckCards.cardName,
        section: competitiveDeckCards.section,
        quantity: competitiveDeckCards.quantity,
      })
      .from(competitiveDeckCards)
      .where(
        sql`${competitiveDeckCards.deckId} = ANY(ARRAY[${sql.join(
          batch.map((id) => sql`${id}`),
          sql`, `
        )}])`
      );

    for (const row of rows) {
      const delta =
        row.section === "mainboard" ? DELTA_MAINBOARD : DELTA_SIDEBOARD;
      // Multiplicar pelo log da quantidade (4x de uma carta é mais relevante que 1x)
      const quantityBonus = Math.log2((row.quantity ?? 1) + 1);
      const effectiveDelta = delta * quantityBonus;

      deltaMap.set(
        row.cardName,
        (deltaMap.get(row.cardName) ?? 0) + effectiveDelta
      );
    }
  }

  console.log(`  Cartas únicas identificadas: ${deltaMap.size}`);

  // ── 3. Enfileirar atualizações via CardLearningQueue ─────────────
  const queue = getCardLearningQueue();
  let totalDelta = 0;

  for (const [cardName, delta] of Array.from(deltaMap.entries())) {
    await queue.enqueue({
      cardName,
      delta,
      source: "unified_learning", // sinal externo real
    });
    totalDelta += delta;
  }

  // Aguardar flush completo para garantir que os pesos foram gravados
  await queue.flush();

  const stats = queue.getAndResetStats();

  console.log(`  Cartas reforçadas : ${stats.totalUpdated}`);
  console.log(`  Delta total       : +${totalDelta.toFixed(2)}`);
  console.log(`  Decks processados : ${recentDecks.length}`);
  console.log(`  Saturadas (decay) : ${stats.totalSaturated}`);
  console.log("  ✓ Sinal de torneio aplicado ao card_learning");

  return {
    cardsReinforced: stats.totalUpdated,
    totalDelta,
    decksProcessed: recentDecks.length,
  };
}

// ── Execução standalone ───────────────────────────────────────────
if (import.meta.url === `file://${process.argv[1]}`) {
  applyTournamentSignal()
    .then((result) => {
      console.log("\n  Resultado:", result);
    })
    .catch((e) => {
      console.error("[TournamentSignal] Erro:", e?.message);
    })
    .finally(() => {
      closeDb().then(() => process.exit(0)).catch(() => process.exit(1));
    });
}
