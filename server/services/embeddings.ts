import { getDb } from "../db";
import { embeddingsCache, EmbeddingsCache, cards, Card } from "../../drizzle/schema";
import { eq } from "drizzle-orm";

const MODEL_VERSION = "v1.0";

/**
 * Calcula similaridade coseno entre dois vetores
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  return denominator === 0 ? 0 : dotProduct / denominator;
}

/**
 * Gera embedding simples baseado em características da carta
 * Em produção, isso seria substituído por Word2Vec real
 */
function generateSimpleEmbedding(card: Card): number[] {
  const embedding: number[] = new Array(50).fill(0);

  // Usar características da carta para gerar embedding
  if (card.colors) {
    const colors = card.colors.split("");
    colors.forEach((color, idx) => {
      embedding[idx] = color.charCodeAt(0) / 100;
    });
  }

  if (card.cmc !== null) {
    embedding[5] = card.cmc / 10;
  }

  if (card.type) {
    const typeHash = card.type.split("").reduce((acc, c) => acc + c.charCodeAt(0), 0);
    for (let i = 6; i < 15; i++) {
      embedding[i] = (typeHash % (i + 1)) / 100;
    }
  }

  if (card.rarity) {
    const rarityValue = { common: 0.1, uncommon: 0.3, rare: 0.6, mythic: 0.9 };
    embedding[15] = rarityValue[card.rarity as keyof typeof rarityValue] || 0.5;
  }

  // Adicionar ruído determinístico baseado no ID da carta para diversidade
  if (card.id) {
    for (let i = 16; i < 50; i++) {
      embedding[i] = ((card.id * (i + 1)) % 100) / 100;
    }
  }

  return embedding;
}

/**
 * Obtém ou gera embedding para uma carta
 */
export async function getCardEmbedding(cardId: number): Promise<number[] | null> {
  const db = await getDb();
  if (!db) return null;

  try {
    // Buscar no cache
    const cached = await db
      .select()
      .from(embeddingsCache)
      .where(eq(embeddingsCache.cardId, cardId))
      .limit(1);

    if (cached.length > 0) {
      try {
        return JSON.parse(cached[0].vectorJson);
      } catch {
        return null;
      }
    }

    // Gerar novo embedding
    const card = await db
      .select()
      .from(cards)
      .where(eq(cards.id, cardId))
      .limit(1);

    if (card.length === 0) return null;

    const embedding = generateSimpleEmbedding(card[0]);

    // Cachear
    try {
      await db.insert(embeddingsCache).values({
        cardId,
        vectorJson: JSON.stringify(embedding),
        modelVersion: MODEL_VERSION,
      });
    } catch (error) {
      // Pode falhar se já existe, ignorar
    }

    return embedding;
  } catch (error) {
    console.error("Error getting card embedding:", error);
    return null;
  }
}

/**
 * Encontra cartas similares a uma carta específica
 */
export async function findSimilarCards(
  cardId: number,
  limit: number = 10
): Promise<(Card & { similarity: number })[]> {
  const db = await getDb();
  if (!db) return [];

  try {
    const sourceEmbedding = await getCardEmbedding(cardId);
    if (!sourceEmbedding) return [];

    // Obter todas as cartas
    const allCards = await db.select().from(cards).limit(1000);

    // Calcular similaridade com cada carta
    const similarities = await Promise.all(
      allCards
        .filter((c) => c.id !== cardId)
        .map(async (card) => {
          const embedding = await getCardEmbedding(card.id);
          if (!embedding) return { card, similarity: 0 };

          const similarity = cosineSimilarity(sourceEmbedding, embedding);
          return { card, similarity };
        })
    );

    // Ordenar por similaridade e retornar top N
    return similarities
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, limit)
      .map((item) => ({
        ...item.card,
        similarity: item.similarity,
      }));
  } catch (error) {
    console.error("Error finding similar cards:", error);
    return [];
  }
}

/**
 * Encontra cartas similares baseado em múltiplas cartas
 */
export async function findSimilarCardsForDeck(
  deckCardIds: number[],
  limit: number = 10
): Promise<(Card & { similarity: number })[]> {
  if (deckCardIds.length === 0) return [];

  try {
    // Calcular embedding médio do deck
    const embeddings = await Promise.all(
      deckCardIds.map((id) => getCardEmbedding(id))
    );

    const validEmbeddings = embeddings.filter((e) => e !== null) as number[][];
    if (validEmbeddings.length === 0) return [];

    const avgEmbedding = new Array(50).fill(0);
    for (const embedding of validEmbeddings) {
      for (let i = 0; i < embedding.length; i++) {
        avgEmbedding[i] += embedding[i] / validEmbeddings.length;
      }
    }

    const db = await getDb();
    if (!db) return [];

    // Obter todas as cartas
    const allCards = await db.select().from(cards).limit(1000);

    // Calcular similaridade com cada carta
    const similarities = await Promise.all(
      allCards
        .filter((c) => !deckCardIds.includes(c.id))
        .map(async (card) => {
          const embedding = await getCardEmbedding(card.id);
          if (!embedding) return { card, similarity: 0 };

          const similarity = cosineSimilarity(avgEmbedding, embedding);
          return { card, similarity };
        })
    );

    // Ordenar por similaridade e retornar top N
    return similarities
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, limit)
      .map((item) => ({
        ...item.card,
        similarity: item.similarity,
      }));
  } catch (error) {
    console.error("Error finding similar cards for deck:", error);
    return [];
  }
}

/**
 * Limpa cache de embeddings (útil para retrainamento)
 */
export async function clearEmbeddingsCache(): Promise<boolean> {
  const db = await getDb();
  if (!db) return false;

  try {
    await db.delete(embeddingsCache);
    return true;
  } catch (error) {
    console.error("Error clearing embeddings cache:", error);
    return false;
  }
}
