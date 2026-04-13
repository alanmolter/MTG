import { getDb } from "../db";
import { embeddingsCache, EmbeddingsCache, cards, Card } from "../../drizzle/schema";
import { eq, and } from "drizzle-orm";

// Deve coincidir com o modelVersion gerado pelo embeddingTrainer.ts
const MODEL_VERSION = "v2.0-real";

// Vocabulário fixo de 64 termos MTG relevantes — cada dimensão representa
// a frequência normalizada desse termo no texto oracle da carta.
const MTG_VOCAB: string[] = [
  "destroy","exile","counter","draw","search","library","creature","instant",
  "sorcery","land","flying","haste","trample","token","sacrifice","graveyard",
  "discard","hexproof","vigilance","lifelink","deathtouch","flash","equip",
  "enchant","whenever","beginning","planeswalker","artifact","target","each",
  "player","damage","life","turn","mana","add","tapped","untap","attack",
  "block","combat","control","permanent","battlefield","hand","enter","copy",
  "cast","return","bounce","mill","reveal","shuffle","loyalty","power",
  "toughness","double","strike","reach","indestructible","shroud","prowess",
  "protection","basic",
];

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
 * Gera embedding semântico baseado no texto oracle da carta.
 * Dimensão 64: frequência TF dos 62 termos MTG + CMC normalizado + valor de raridade.
 * Cartas com oracle text similar (ex: dois wrath effects) terão alta similaridade coseno.
 */
function generateTextEmbedding(card: Card): number[] {
  const DIM = 64;
  const embedding: number[] = new Array(DIM).fill(0);

  const text = ((card.text ?? "") + " " + (card.type ?? "") + " " + (card.name ?? ""))
    .toLowerCase()
    .replace(/[{}()\[\].,;:'"!?]/g, " ");
  const tokens = text.split(/\s+/).filter(Boolean);
  const total = tokens.length || 1;

  // Dimensões 0-61: TF por termo do vocabulário MTG
  for (let i = 0; i < MTG_VOCAB.length; i++) {
    const term = MTG_VOCAB[i];
    const freq = tokens.filter(t => t === term || t.startsWith(term)).length;
    embedding[i] = freq / total;
  }

  // Dimensão 62: CMC normalizado (0–10 → 0–1)
  embedding[62] = Math.min((card.cmc ?? 0) / 10, 1.0);

  // Dimensão 63: valor de raridade
  const rarityMap: Record<string, number> = { common: 0.1, uncommon: 0.3, rare: 0.6, mythic: 0.9 };
  embedding[63] = rarityMap[card.rarity ?? ""] ?? 0.5;

  // L2-normalização
  const norm = Math.sqrt(embedding.reduce((s, v) => s + v * v, 0));
  if (norm > 0) {
    for (let i = 0; i < DIM; i++) embedding[i] /= norm;
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
    // Buscar no cache filtrando pela versão atual (evita retornar vetores v1.0 obsoletos)
    const cached = await db
      .select()
      .from(embeddingsCache)
      .where(and(eq(embeddingsCache.cardId, cardId), eq(embeddingsCache.modelVersion, MODEL_VERSION)))
      .limit(1);

    if (cached.length > 0) {
      try {
        return JSON.parse(cached[0].vectorJson);
      } catch {
        return null;
      }
    }

    // Gerar novo embedding semântico baseado no texto oracle
    const card = await db
      .select()
      .from(cards)
      .where(eq(cards.id, cardId))
      .limit(1);

    if (card.length === 0) return null;

    const embedding = generateTextEmbedding(card[0]);

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

    const dim = validEmbeddings[0].length;
    const avgEmbedding = new Array(dim).fill(0);
    for (const embedding of validEmbeddings) {
      for (let i = 0; i < dim; i++) {
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
