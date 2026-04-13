import { getDb } from "../db";
import { cardSynergies, CardSynergy } from "../../drizzle/schema";
import { eq, and, or } from "drizzle-orm";

interface SynergyNode {
  cardId: number;
  weight: number;
}

/**
 * Calcula sinergia entre duas cartas baseado em co-ocorrência
 * Retorna peso da conexão (0-100)
 */
export async function getCardSynergy(card1Id: number, card2Id: number): Promise<number> {
  const db = await getDb();
  if (!db) return 0;

  try {
    // Busca em ambas as direções
    const result = await db
      .select()
      .from(cardSynergies)
      .where(
        or(
          and(eq(cardSynergies.card1Id, card1Id), eq(cardSynergies.card2Id, card2Id)),
          and(eq(cardSynergies.card1Id, card2Id), eq(cardSynergies.card2Id, card1Id))
        )
      )
      .limit(1);

    if (!result[0]) return 0;

    const coOccurrenceRate = result[0].coOccurrenceRate ?? 0;
    const weight = result[0].weight ?? 0;
    // Combina co-ocorrência histórica (70%) com peso aprendido (30%)
    const clampedWeight = Math.min(Math.max(weight, 0), 100);
    return Math.round(coOccurrenceRate * 0.7 + clampedWeight * 0.3);
  } catch (error) {
    console.error("Error getting card synergy:", error);
    return 0;
  }
}

/**
 * Obtém cartas sinérgicas com uma carta específica
 */
export async function getSynergyNeighbors(
  cardId: number,
  limit: number = 10
): Promise<SynergyNode[]> {
  const db = await getDb();
  if (!db) return [];

  try {
    const result = await db
      .select()
      .from(cardSynergies)
      .where(
        or(
          eq(cardSynergies.card1Id, cardId),
          eq(cardSynergies.card2Id, cardId)
        )
      )
      .limit(limit);

    return result.map((synergy) => ({
      cardId: synergy.card1Id === cardId ? synergy.card2Id : synergy.card1Id,
      weight: synergy.coOccurrenceRate,
    }));
  } catch (error) {
    console.error("Error getting synergy neighbors:", error);
    return [];
  }
}

/**
 * Adiciona ou atualiza sinergia entre duas cartas
 */
export async function updateSynergy(
  card1Id: number,
  card2Id: number,
  weight: number,
  coOccurrenceRate: number
): Promise<CardSynergy | null> {
  const db = await getDb();
  if (!db) return null;

  // Garantir ordem consistente
  const [minId, maxId] = card1Id < card2Id ? [card1Id, card2Id] : [card2Id, card1Id];

  try {
    const existing = await db
      .select()
      .from(cardSynergies)
      .where(
        and(
          eq(cardSynergies.card1Id, minId),
          eq(cardSynergies.card2Id, maxId)
        )
      )
      .limit(1);

    if (existing.length > 0) {
      await db
        .update(cardSynergies)
        .set({
          weight,
          coOccurrenceRate,
        })
        .where(
          and(
            eq(cardSynergies.card1Id, minId),
            eq(cardSynergies.card2Id, maxId)
          )
        );
      return { ...existing[0], weight, coOccurrenceRate };
    }

    await db.insert(cardSynergies).values({
      card1Id: minId,
      card2Id: maxId,
      weight,
      coOccurrenceRate,
    });

    const result = await db
      .select()
      .from(cardSynergies)
      .where(
        and(
          eq(cardSynergies.card1Id, minId),
          eq(cardSynergies.card2Id, maxId)
        )
      )
      .limit(1);

    return result[0] || null;
  } catch (error) {
    console.error("Error updating synergy:", error);
    return null;
  }
}

/**
 * Calcula sinergia total de um conjunto de cartas
 * Soma os pesos de todas as conexões entre as cartas
 */
export async function calculateDeckSynergy(cardIds: number[]): Promise<number> {
  if (cardIds.length < 2) return 0;

  let totalSynergy = 0;
  for (let i = 0; i < cardIds.length; i++) {
    for (let j = i + 1; j < cardIds.length; j++) {
      const synergy = await getCardSynergy(cardIds[i], cardIds[j]);
      totalSynergy += synergy;
    }
  }

  return totalSynergy;
}

/**
 * Encontra a melhor carta para adicionar a um deck baseado em sinergia
 */
export async function findBestCardForDeck(
  deckCardIds: number[],
  candidateCardIds: number[]
): Promise<number | null> {
  let bestCard = null;
  let bestScore = -1;

  for (const candidateId of candidateCardIds) {
    let score = 0;
    for (const deckCardId of deckCardIds) {
      score += await getCardSynergy(candidateId, deckCardId);
    }

    if (score > bestScore) {
      bestScore = score;
      bestCard = candidateId;
    }
  }

  return bestCard;
}
