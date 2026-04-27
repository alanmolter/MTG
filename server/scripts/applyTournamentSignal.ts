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
import { and, eq, gte, inArray } from "drizzle-orm";
import {
  cardLearning,
  cards,
  competitiveDeckCards,
  competitiveDecks,
} from "../../drizzle/schema";
import { closeDb, getDb } from "../db";
import { getCardLearningQueue } from "../services/cardLearningQueue";
import { describeTrainingPool, isArenaOnlyTraining } from "./utils/poolFilter";

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

  // Pool scope. Quando TRAINING_POOL_ARENA_ONLY=1, filtramos as cartas que
  // recebem reforço pra apenas as legais no MTG Arena. Os scrapers continuam
  // baixando todos os 6 formatos (info útil pra embeddings de sinergia), mas
  // o sinal de peso só vai pra cartas Arena. Sem isso, decks Modern/Legacy
  // injetariam sinal em cartas como Snapcaster Mage que nunca aparecem no
  // pool de treinamento Arena — peso morto poluindo o card_learning.
  const arenaOnly = isArenaOnlyTraining();
  console.log(`  Pool scope         : ${describeTrainingPool()}`);
  if (arenaOnly) {
    console.log(`  (cartas não-Arena serão registradas mas não receberão delta)`);
  }

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

  // Buscar em batches de 50 usando inArray (suportado pelo driver postgres.js)
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
      .where(inArray(competitiveDeckCards.deckId, batch));

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

  // ── 2b. Filtrar por Arena-legal quando flag está on ──────────────
  // Uma única query pra resolver todos os nomes contra cards.is_arena.
  // Mais barato e mais simples que JOIN no select de competitive_deck_cards
  // (cartas com mesmo nome em múltiplos sets gerariam row-multiplication).
  let skippedNonArena = 0;
  if (arenaOnly && deltaMap.size > 0) {
    const cardNamesArray = Array.from(deltaMap.keys());
    const arenaRows = await db
      .select({ name: cards.name })
      .from(cards)
      .where(and(eq(cards.isArena, 1), inArray(cards.name, cardNamesArray)));
    const arenaSet = new Set(arenaRows.map((r) => r.name));

    for (const cardName of cardNamesArray) {
      if (!arenaSet.has(cardName)) {
        deltaMap.delete(cardName);
        skippedNonArena++;
      }
    }
    console.log(`  Filtrados (não-Arena)      : ${skippedNonArena}`);
    console.log(`  Cartas Arena restantes     : ${deltaMap.size}`);
  }

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
  if (arenaOnly) {
    console.log(`  Não-Arena ignoradas: ${skippedNonArena}`);
  }
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
