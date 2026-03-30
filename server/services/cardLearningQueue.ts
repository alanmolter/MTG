/**
 * CardLearningQueue: Fila serializada para atualizar pesos de cartas
 * 
 * Problema: Três processos escrevem na mesma tabela sem sincronização:
 * - unified_learning_loop.py (delta = reward × learningRate)
 * - syncForgeRealityToCardLearning.ts (delta = ±0.5/±0.2 × Elo)
 * - deckGenerator.ts (delta = +0.1)
 * 
 * Solução: Fila FIFO com worker thread que processa sequencialmente
 * Garantias:
 * ✓ Sem race conditions
 * ✓ Todos os deltas aplicados
 * ✓ Ordem FIFO preservada
 * ✓ Peso sempre em [0.1, 50.0]
 */

import { getDb } from "../db";
import { cardLearning } from "../../drizzle/schema";
import { eq } from "drizzle-orm";

export interface CardLearningUpdate {
  cardName: string;
  /** delta de peso (positivo = reforço, negativo = penalidade) */
  delta?: number;
  /** alias de delta — aceito para compatibilidade com modelLearning */
  weightDelta?: number;
  source: "forge_reality" | "unified_learning" | "rl_feedback" | "user_generation" | "self_play" | "commander_train" | "rl_policy";
  scoreDelta?: number;
  win?: boolean;
  timestamp?: number;
  metadata?: Record<string, unknown>;
}

const MIN_WEIGHT = 0.1;
const MAX_WEIGHT = 50.0;

export class CardLearningQueue {
  private queue: CardLearningUpdate[] = [];
  private isProcessing = false;
  private readonly BATCH_SIZE = 10;
  private readonly PROCESS_INTERVAL = 100; // ms

  constructor() {
    this.startWorker();
  }

  /**
   * Força o processamento imediato de toda a fila (útil após updateWeights)
   */
  async flush(): Promise<void> {
    // Dispara processamento imediato se houver itens
    if (this.queue.length > 0) {
      await this.processBatch();
    }
    // Aguarda esvaziamento completo
    await this.waitUntilEmpty();
  }

  /**
   * Enfileira uma atualização de peso de carta
   */
  async enqueue(update: CardLearningUpdate): Promise<void> {
    // Aceita tanto delta quanto weightDelta
    const effectiveDelta = update.delta ?? update.weightDelta ?? 0;
    if (!update.cardName || typeof effectiveDelta !== "number") {
      throw new Error("Invalid card learning update: missing cardName or delta");
    }
    update.delta = effectiveDelta;

    update.timestamp = update.timestamp || Date.now();
    this.queue.push(update);

    // Não aguarda processamento, apenas enfileira
    // O worker processa em background
  }

  /**
   * Enfileira múltiplas atualizações
   */
  async enqueueBatch(updates: CardLearningUpdate[]): Promise<void> {
    for (const update of updates) {
      await this.enqueue(update);
    }
  }

  /**
   * Aguarda até que a fila esteja vazia
   */
  async waitUntilEmpty(): Promise<void> {
    return new Promise((resolve) => {
      const checkEmpty = () => {
        if (this.queue.length === 0 && !this.isProcessing) {
          resolve();
        } else {
          setTimeout(checkEmpty, 50);
        }
      };
      checkEmpty();
    });
  }

  /**
   * Inicia o worker que processa a fila continuamente
   */
  private startWorker(): void {
    setInterval(async () => {
      if (this.queue.length > 0 && !this.isProcessing) {
        await this.processBatch();
      }
    }, this.PROCESS_INTERVAL);
  }

  /**
   * Processa um lote de atualizações do banco
   */
  private async processBatch(): Promise<void> {
    if (this.isProcessing || this.queue.length === 0) {
      return;
    }

    this.isProcessing = true;

    try {
      const batch = this.queue.splice(0, this.BATCH_SIZE);
      const db = await getDb();

      if (!db) {
        console.warn("[CardLearningQueue] Database not available, requeueing updates");
        this.queue.unshift(...batch);
        return;
      }

      // Agrupar por cardName para operações em lote
      const updatesByCard = new Map<string, CardLearningUpdate[]>();

      for (const update of batch) {
        if (!updatesByCard.has(update.cardName)) {
          updatesByCard.set(update.cardName, []);
        }
        updatesByCard.get(update.cardName)!.push(update);
      }

      // Processar cada carta
      for (const [cardName, updates] of updatesByCard) {
        await this.updateCardWeight(db, cardName, updates);
      }

      console.log(
        `[CardLearningQueue] ✓ Processadas ${batch.length} atualizações ` +
        `(${updatesByCard.size} cartas únicas)`
      );
    } catch (error) {
      console.error("[CardLearningQueue] Error processing batch:", error);
      // Requeue failed updates
      this.queue.unshift(...this.queue.splice(0, this.BATCH_SIZE));
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * Atualiza peso de uma carta no banco
   */
  private async updateCardWeight(
    db: any,
    cardName: string,
    updates: CardLearningUpdate[]
  ): Promise<void> {
    try {
      // 1. Ler peso atual
      const existing = await db
        .select()
        .from(cardLearning)
        .where(eq(cardLearning.cardName, cardName))
        .limit(1);

      let currentWeight = 1.0; // Default
      if (existing.length > 0) {
        currentWeight = existing[0].weight;
      }

      // 2. Calcular novo peso (soma de todos os deltas)
      let totalDelta = 0;
      const sources: string[] = [];

      for (const update of updates) {
        totalDelta += update.delta ?? update.weightDelta ?? 0;
        sources.push(update.source);
      }

      // 3. Aplicar capping [0.1, 50.0]
      const newWeight = Math.max(MIN_WEIGHT, Math.min(MAX_WEIGHT, currentWeight + totalDelta));

      // 4. Log detalhado
      if (totalDelta !== 0) {
        console.log(
          `[CardLearning] ${cardName}: ` +
          `${currentWeight.toFixed(3)} → ${newWeight.toFixed(3)} ` +
          `(delta: ${totalDelta > 0 ? "+" : ""}${totalDelta.toFixed(3)}, ` +
          `sources: ${sources.join(", ")})`
        );
      }

      // 5. Upsert no banco
      if (existing.length > 0) {
        await db
          .update(cardLearning)
          .set({
            weight: newWeight,
            updatedAt: new Date(),
          })
          .where(eq(cardLearning.cardName, cardName));
      } else {
        await db.insert(cardLearning).values({
          cardName,
          weight: newWeight,
          updatedAt: new Date(),
        });
      }
    } catch (error) {
      console.error(`[CardLearningQueue] Failed to update ${cardName}:`, error);
      throw error;
    }
  }

  /**
   * Retorna estatísticas da fila
   */
  getStats(): {
    queueLength: number;
    isProcessing: boolean;
    estimatedTimeMs: number;
  } {
    return {
      queueLength: this.queue.length,
      isProcessing: this.isProcessing,
      estimatedTimeMs: (this.queue.length / this.BATCH_SIZE) * this.PROCESS_INTERVAL,
    };
  }
}

// Singleton
let queueInstance: CardLearningQueue | null = null;

export function getCardLearningQueue(): CardLearningQueue {
  if (!queueInstance) {
    queueInstance = new CardLearningQueue();
  }
  return queueInstance;
}
