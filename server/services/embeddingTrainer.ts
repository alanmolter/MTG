import { getDb } from "../db";
import {
  competitiveDeckCards,
  competitiveDecks,
  embeddingsCache,
  cardSynergies,
  cards,
  trainingJobs,
  InsertEmbeddingsCache,
  InsertCardSynergy,
} from "../../drizzle/schema";
import { eq, and, sql, ne } from "drizzle-orm";

const EMBEDDING_DIM = 64;
const MODEL_VERSION = "v2.0-real";
const LEARNING_RATE = 0.025;
const WINDOW_SIZE = 5;
const MIN_COUNT = 2;

export interface TrainingResult {
  jobId: number;
  embeddingsTrained: number;
  synergiesUpdated: number;
  durationMs: number;
  status: "completed" | "failed";
  error?: string;
}

/**
 * Pipeline completo de treinamento:
 * 1. Carrega co-ocorrências dos decks competitivos
 * 2. Treina embeddings Word2Vec simplificado
 * 3. Atualiza grafo de sinergias
 * 4. Persiste tudo no banco
 */
export async function trainEmbeddingsFromDecks(): Promise<TrainingResult> {
  const startTime = Date.now();
  const db = await getDb();

  if (!db) {
    return { jobId: -1, embeddingsTrained: 0, synergiesUpdated: 0, durationMs: 0, status: "failed", error: "DB unavailable" };
  }

  // Criar job de treinamento
  const [jobRow] = await db
    .insert(trainingJobs)
    .values({ status: "running", jobType: "embeddings" })
    .returning({ id: trainingJobs.id });
  const jobId = jobRow.id;

  try {
    console.log(`[Trainer] Job ${jobId} iniciado`);

    // ── 1. Carregar decks competitivos REAIS (excluir sintéticos) ─────────────────────────
    // CORREÇÃO: Decks sintéticos (fallback de API bloqueada) são excluídos para
    // evitar que o modelo aprenda co-ocorrências que não existem em decks reais.
    const allDecks = await db
      .select()
      .from(competitiveDecks)
      .where(ne(competitiveDecks.isSynthetic, true));
    const allDeckCards = await db.select().from(competitiveDeckCards);

    if (allDecks.length === 0) {
      throw new Error("Nenhum deck competitivo real encontrado. Importe decks do MTGGoldfish ou MTGTop8 primeiro.");
    }
    console.log(`[Trainer] Usando ${allDecks.length} decks reais para treinamento (sintéticos excluídos).`);

    // Agrupar cartas por deck
    const deckMap = new Map<number, string[]>();
    for (const dc of allDeckCards) {
      if (dc.section !== "mainboard") continue;
      if (!deckMap.has(dc.deckId)) deckMap.set(dc.deckId, []);
      const arr = deckMap.get(dc.deckId)!;
      for (let qi = 0; qi < dc.quantity; qi++) arr.push(dc.cardName);
    }

    console.log(`[Trainer] Carregados ${allDecks.length} decks, ${allDeckCards.length} entradas de cartas`);

    // ── 2. Construir vocabulário ─────────────────────────────────────────────
    const cardFreq = new Map<string, number>();
    for (const cardList of Array.from(deckMap.values())) {
      for (const card of cardList) {
        cardFreq.set(card, (cardFreq.get(card) || 0) + 1);
      }
    }

    // Filtrar cartas com frequência mínima
    const vocab = Array.from(cardFreq.entries())
      .filter(([, freq]) => freq >= MIN_COUNT)
      .map(([name]) => name);

    const wordToIdx = new Map<string, number>(vocab.map((w: string, i: number) => [w, i]));
    const vocabSize = vocab.length;

    console.log(`[Trainer] Vocabulário: ${vocabSize} cartas únicas (min_count=${MIN_COUNT})`);

    if (vocabSize < 2) {
      throw new Error("Vocabulário muito pequeno. Importe mais decks.");
    }

    // ── 3. Treinar Word2Vec (Skip-Gram simplificado) ─────────────────────────
    // Inicializar vetores aleatórios
    const W1 = initMatrix(vocabSize, EMBEDDING_DIM); // input embeddings
    const W2 = initMatrix(EMBEDDING_DIM, vocabSize); // output embeddings

    let totalLoss = 0;
    let trainingSamples = 0;

    for (const deckEntry of Array.from(deckMap.values())) {
      const cardList = deckEntry;
      const indices = cardList
        .map((c) => wordToIdx.get(c))
        .filter((i): i is number => i !== undefined);

      // Skip-gram: para cada carta, prever as vizinhas
      for (let pos = 0; pos < indices.length; pos++) {
        const centerIdx = indices[pos];

        for (let w = -WINDOW_SIZE; w <= WINDOW_SIZE; w++) {
          if (w === 0) continue;
          const contextPos = pos + w;
          if (contextPos < 0 || contextPos >= indices.length) continue;

          const contextIdx = indices[contextPos];
          const loss = skipGramStep(W1, W2, centerIdx, contextIdx, LEARNING_RATE);
          totalLoss += loss;
          trainingSamples++;
        }
      }
    }

    const avgLoss = trainingSamples > 0 ? totalLoss / trainingSamples : 0;
    console.log(`[Trainer] Treinamento concluído. Loss médio: ${avgLoss.toFixed(4)}, amostras: ${trainingSamples}`);

    // ── 4. Salvar embeddings no banco ────────────────────────────────────────
    let embeddingsSaved = 0;

    // Buscar cartas do banco para mapear por nome
    const dbCards = await db.select({ id: cards.id, name: cards.name }).from(cards);
    const cardNameToId = new Map(dbCards.map((c: { id: number; name: string }) => [c.name.toLowerCase(), c.id]));

    for (let i = 0; i < vocab.length; i++) {
      const cardName = vocab[i];
      const cardId = cardNameToId.get(cardName.toLowerCase());
      if (!cardId) continue;

      const vector = W1[i];
      const vectorJson = JSON.stringify(Array.from(vector));

      await db
        .insert(embeddingsCache)
        .values({
          cardId,
          vectorJson,
          modelVersion: MODEL_VERSION,
        })
        .onConflictDoUpdate({
          target: embeddingsCache.cardId,
          set: { vectorJson, modelVersion: MODEL_VERSION },
        });

      embeddingsSaved++;
    }

    console.log(`[Trainer] ${embeddingsSaved} embeddings salvos no banco`);

    // ── 5. Calcular e salvar sinergias ───────────────────────────────────────
    let synergiesUpdated = 0;

    // Co-ocorrência: contar quantos decks têm cada par de cartas
    const coOccurrence = new Map<string, number>();

    for (const cardList of Array.from(deckMap.values())) {
      const uniqueCards = Array.from(new Set(cardList));
      for (let i = 0; i < uniqueCards.length; i++) {
        for (let j = i + 1; j < uniqueCards.length; j++) {
          const key = `${uniqueCards[i]}|||${uniqueCards[j]}`;
          coOccurrence.set(key, (coOccurrence.get(key) || 0) + 1);
        }
      }
    }

    // Salvar top sinergias no banco
    const topSynergies = Array.from(coOccurrence.entries())
      .sort(([, a], [, b]) => b - a)
      .slice(0, 5000); // Top 5000 pares

    for (const [key, count] of topSynergies) {
      const [name1, name2] = key.split("|||");
      const id1 = cardNameToId.get(name1.toLowerCase());
      const id2 = cardNameToId.get(name2.toLowerCase());

      if (!id1 || !id2) continue;

      const [c1, c2] = id1 < id2 ? [id1, id2] : [id2, id1];
      const weight = Math.min(100, Math.floor((count / allDecks.length) * 100));

      try {
        await db
          .insert(cardSynergies)
          .values({
            card1Id: c1,
            card2Id: c2,
            weight,
            coOccurrenceRate: count,
          })
          .onConflictDoUpdate({
            target: [cardSynergies.card1Id, cardSynergies.card2Id],
            set: { weight, coOccurrenceRate: count },
          });

        synergiesUpdated++;
      } catch {
        // Ignorar conflitos
      }
    }

    console.log(`[Trainer] ${synergiesUpdated} sinergias atualizadas`);

    // ── 6. Atualizar job como concluído ──────────────────────────────────────
    await db
      .update(trainingJobs)
      .set({
        status: "completed",
        totalDecks: allDecks.length,
        totalCards: vocabSize,
        embeddingsTrained: embeddingsSaved,
        synergiesUpdated,
        completedAt: new Date(),
      })
      .where(eq(trainingJobs.id, jobId));

    const durationMs = Date.now() - startTime;
    console.log(`[Trainer] Job ${jobId} concluído em ${durationMs}ms`);

    return { jobId, embeddingsTrained: embeddingsSaved, synergiesUpdated, durationMs, status: "completed" };
  } catch (error: any) {
    const msg = error?.message || "Erro desconhecido";
    console.error(`[Trainer] Job ${jobId} falhou:`, msg);

    await db
      .update(trainingJobs)
      .set({ status: "failed", errorMessage: msg, completedAt: new Date() })
      .where(eq(trainingJobs.id, jobId));

    return {
      jobId,
      embeddingsTrained: 0,
      synergiesUpdated: 0,
      durationMs: Date.now() - startTime,
      status: "failed",
      error: msg,
    };
  }
}

/**
 * Retorna histórico de jobs de treinamento
 */
export async function getTrainingJobHistory(limit = 10) {
  const db = await getDb();
  if (!db) return [];

  return db
    .select()
    .from(trainingJobs)
    .orderBy(sql`${trainingJobs.startedAt} DESC`)
    .limit(limit);
}

// ─── Word2Vec helpers ──────────────────────────────────────────────────────────

function initMatrix(rows: number, cols: number): Float32Array[] {
  return Array.from({ length: rows }, () => {
    const arr = new Float32Array(cols);
    for (let i = 0; i < cols; i++) arr[i] = (Math.random() - 0.5) / cols;
    return arr;
  });
}

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-Math.max(-500, Math.min(500, x))));
}

function skipGramStep(
  W1: Float32Array[],
  W2: Float32Array[],
  centerIdx: number,
  contextIdx: number,
  lr: number
): number {
  const dim = W1[0].length;
  const vocabSize = W2[0].length;

  // Forward: h = W1[center]
  const h = W1[centerIdx];

  // Score para o contexto real
  let score = 0;
  for (let d = 0; d < dim; d++) score += h[d] * W2[d][contextIdx];
  const prob = sigmoid(score);
  const err = prob - 1; // target = 1 (par real)

  // Backward: atualizar W2[*][contextIdx]
  for (let d = 0; d < dim; d++) {
    W2[d][contextIdx] -= lr * err * h[d];
  }

  // Negative sampling simplificado (1 negativo)
  const negIdx = Math.floor(Math.random() * vocabSize);
  let negScore = 0;
  for (let d = 0; d < dim; d++) negScore += h[d] * W2[d][negIdx];
  const negProb = sigmoid(negScore);
  const negErr = negProb; // target = 0

  for (let d = 0; d < dim; d++) {
    W2[d][negIdx] -= lr * negErr * h[d];
  }

  // Atualizar W1[center]
  const grad = new Float32Array(dim);
  for (let d = 0; d < dim; d++) {
    grad[d] = err * W2[d][contextIdx] + negErr * W2[d][negIdx];
  }
  for (let d = 0; d < dim; d++) {
    W1[centerIdx][d] -= lr * grad[d];
  }

  return -Math.log(prob + 1e-10);
}
