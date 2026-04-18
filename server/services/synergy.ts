import { getDb } from "../db";
import { cardSynergies, CardSynergy } from "../../drizzle/schema";
import { eq, and, or } from "drizzle-orm";

interface SynergyNode {
  cardId: number;
  weight: number;
}

/**
 * Circuit breaker + error throttling.
 *
 * Contexto: quando a tabela `card_synergies` sofre corrupção física (PostgreSQL
 * XX001: "invalid page in block N"), TODAS as queries desta tabela falham em
 * cascata. Sem este mecanismo, um único treino gera 10.000+ linhas de stack
 * trace idênticas inundando o stdout.
 *
 * Comportamento:
 *  - Detecta erros XX001 (disk corruption) ou códigos similares.
 *  - Após MAX_ERRORS_BEFORE_TRIP erros, abre o circuito: queries retornam
 *    no-op imediatamente (sem hit no banco) até reset manual.
 *  - Loga apenas os primeiros LOG_ERROR_LIMIT; depois reporta por amostragem.
 */
const MAX_ERRORS_BEFORE_TRIP = 25;
const LOG_ERROR_LIMIT = 5;

let circuitTripped = false;
let errorCount = 0;
let corruptionDetected = false;
let lastLoggedAt = 0;

function isCorruptionError(error: any): boolean {
  const code = error?.code || error?.cause?.code;
  const msg = String(error?.message || "");
  // XX001 = data_corrupted. 58P01 = file related. Também cobrimos sinais textuais.
  return (
    code === "XX001" ||
    code === "XX002" ||
    /invalid page in block/i.test(msg) ||
    /could not read block/i.test(msg)
  );
}

function handleError(context: string, error: any): void {
  errorCount++;

  if (isCorruptionError(error)) {
    corruptionDetected = true;
  }

  // Log throttling: primeiros N verbosos, depois 1 a cada 10s.
  const now = Date.now();
  if (errorCount <= LOG_ERROR_LIMIT) {
    console.error(`[synergy:${context}]`, error?.message || error);
    if (errorCount === LOG_ERROR_LIMIT) {
      console.error(
        `[synergy] ${LOG_ERROR_LIMIT} erros consecutivos. Suprimindo logs futuros (sample a cada 10s).`
      );
    }
  } else if (now - lastLoggedAt > 10_000) {
    lastLoggedAt = now;
    console.error(
      `[synergy] ainda em erro (total=${errorCount}, corruption=${corruptionDetected}): ${error?.message || error}`
    );
  }

  if (!circuitTripped && errorCount >= MAX_ERRORS_BEFORE_TRIP) {
    circuitTripped = true;
    console.error(
      `\n════════════════════════════════════════════════════════════\n` +
        `  [synergy] CIRCUIT BREAKER ATIVADO (${errorCount} erros).\n` +
        (corruptionDetected
          ? `  CAUSA: corrupção física detectada em card_synergies.\n` +
            `  REPARO: npx tsx server/scripts/repairSynergies.ts\n`
          : `  CAUSA: falhas repetidas de query em card_synergies.\n`) +
        `  As próximas chamadas a este módulo retornarão no-op.\n` +
        `════════════════════════════════════════════════════════════\n`
    );
  }
}

export function getSynergyStatus() {
  return { circuitTripped, errorCount, corruptionDetected };
}

export function resetSynergyCircuit() {
  circuitTripped = false;
  errorCount = 0;
  corruptionDetected = false;
  lastLoggedAt = 0;
}

/**
 * Calcula sinergia entre duas cartas baseado em co-ocorrência
 * Retorna peso da conexão (0-100)
 */
export async function getCardSynergy(card1Id: number, card2Id: number): Promise<number> {
  if (circuitTripped) return 0;
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
    handleError("getCardSynergy", error);
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
  if (circuitTripped) return [];
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
    handleError("getSynergyNeighbors", error);
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
  if (circuitTripped) return null;
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
    handleError("updateSynergy", error);
    return null;
  }
}

/**
 * Calcula sinergia total de um conjunto de cartas
 * Soma os pesos de todas as conexões entre as cartas
 */
export async function calculateDeckSynergy(cardIds: number[]): Promise<number> {
  if (cardIds.length < 2) return 0;
  if (circuitTripped) return 0;

  let totalSynergy = 0;
  for (let i = 0; i < cardIds.length; i++) {
    for (let j = i + 1; j < cardIds.length; j++) {
      const synergy = await getCardSynergy(cardIds[i], cardIds[j]);
      totalSynergy += synergy;
      if (circuitTripped) return totalSynergy; // short-circuit se cair durante loop
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
      if (circuitTripped) break;
    }

    if (score > bestScore) {
      bestScore = score;
      bestCard = candidateId;
    }
  }

  return bestCard;
}
