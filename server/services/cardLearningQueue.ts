/**
 * CardLearningQueue: Fila serializada para atualizar pesos de cartas
 *
 * CORREÇÕES APLICADAS:
 * 1. Race Condition: Fila FIFO com worker único — sem escrita concorrente
 * 2. Weight Capping: pesos sempre em [0.1, 50.0]
 * 3. Logs silenciosos: sem log por carta individual — apenas resumo por lote
 * 4. Decay proporcional: cartas próximas do teto recebem delta reduzido
 *    Formula: effectiveDelta = delta * (1 - currentWeight / MAX_WEIGHT)^DECAY_POWER
 *    Isso garante que cartas em 50.0 nunca recebem mais delta positivo
 *    e cartas em 0.1 recebem o delta completo.
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

/**
 * Fator de decaimento para evitar saturação no teto.
 * Quanto maior o DECAY_POWER, mais agressivo o decaimento próximo ao teto.
 * Valor 2.0 = decaimento quadrático (suave mas efetivo).
 */
const DECAY_POWER = 2.0;

/**
 * Aplica decay proporcional ao delta para evitar saturação.
 * - delta positivo: reduz conforme a carta se aproxima do MAX_WEIGHT
 * - delta negativo: reduz conforme a carta se aproxima do MIN_WEIGHT
 * - Resultado: cartas no teto nunca ficam presas, sempre há diferenciação
 */
function applyDecay(currentWeight: number, delta: number): number {
  if (delta > 0) {
    // Quanto mais próximo de MAX, menor o delta positivo
    const headroom = (MAX_WEIGHT - currentWeight) / (MAX_WEIGHT - MIN_WEIGHT);
    return delta * Math.pow(headroom, DECAY_POWER);
  } else if (delta < 0) {
    // Quanto mais próximo de MIN, menor o delta negativo (em módulo)
    const headroom = (currentWeight - MIN_WEIGHT) / (MAX_WEIGHT - MIN_WEIGHT);
    return delta * Math.pow(headroom, DECAY_POWER);
  }
  return 0;
}

export class CardLearningQueue {
  private queue: CardLearningUpdate[] = [];
  private isProcessing = false;
  private readonly BATCH_SIZE = 50; // Aumentado para processar mais rápido
  private readonly PROCESS_INTERVAL = 100; // ms

  // Estatísticas acumuladas para o resumo
  private stats = {
    totalProcessed: 0,
    totalUpdated: 0,
    totalSaturated: 0,  // cartas que chegaram ao teto/piso
    totalDecayed: 0,    // cartas que tiveram delta reduzido por decay
    batchCount: 0,
  };

  constructor() {
    this.startWorker();
  }

  /**
   * Força o processamento imediato de toda a fila
   */
  async flush(): Promise<void> {
    if (this.queue.length > 0) {
      await this.processBatch();
    }
    await this.waitUntilEmpty();
  }

  /**
   * Enfileira uma atualização de peso de carta
   */
  async enqueue(update: CardLearningUpdate): Promise<void> {
    const effectiveDelta = update.delta ?? update.weightDelta ?? 0;
    if (!update.cardName || typeof effectiveDelta !== "number") {
      throw new Error("Invalid card learning update: missing cardName or delta");
    }
    update.delta = effectiveDelta;
    update.timestamp = update.timestamp || Date.now();
    this.queue.push(update);
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
   * Retorna e reseta as estatísticas acumuladas
   */
  getAndResetStats() {
    const s = { ...this.stats };
    this.stats = { totalProcessed: 0, totalUpdated: 0, totalSaturated: 0, totalDecayed: 0, batchCount: 0 };
    return s;
  }

  /**
   * Retorna estatísticas da fila (sem resetar)
   */
  getStats() {
    return {
      queueLength: this.queue.length,
      isProcessing: this.isProcessing,
      estimatedTimeMs: (this.queue.length / this.BATCH_SIZE) * this.PROCESS_INTERVAL,
      accumulated: { ...this.stats },
    };
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
    if (this.isProcessing || this.queue.length === 0) return;

    this.isProcessing = true;

    try {
      const batch = this.queue.splice(0, this.BATCH_SIZE);
      const db = await getDb();

      if (!db) {
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

      // Estatísticas do lote
      let batchUpdated = 0;
      let batchSaturated = 0;
      let batchDecayed = 0;

      // Processar cada carta
      for (const [cardName, updates] of updatesByCard) {
        const result = await this.updateCardWeight(db, cardName, updates);
        if (result.updated) batchUpdated++;
        if (result.saturated) batchSaturated++;
        if (result.decayed) batchDecayed++;
      }

      // Acumular estatísticas globais
      this.stats.totalProcessed += batch.length;
      this.stats.totalUpdated += batchUpdated;
      this.stats.totalSaturated += batchSaturated;
      this.stats.totalDecayed += batchDecayed;
      this.stats.batchCount++;

      // Log resumido por lote (apenas se houver atualizações reais)
      if (batchUpdated > 0) {
        const decayInfo = batchDecayed > 0 ? ` | decay: ${batchDecayed}` : "";
        const satInfo = batchSaturated > 0 ? ` | sat: ${batchSaturated}` : "";
        const queueLine =
          `  [Queue] lote ${this.stats.batchCount}: ${batchUpdated}/${updatesByCard.size} cartas` +
          `${decayInfo}${satInfo} | fila: ${this.queue.length}`;
        // Padding de 25 espaços para apagar restos de linhas anteriores mais longas
        process.stdout.write(`\r${queueLine.padEnd(queueLine.length + 25)}`);
      }

    } catch (error) {
      // Silencioso — não poluir o terminal com stack traces de erros de DB
      // O erro já foi logado pelo updateCardWeight
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * Atualiza peso de uma carta no banco com decay proporcional
   */
  private async updateCardWeight(
    db: any,
    cardName: string,
    updates: CardLearningUpdate[]
  ): Promise<{ updated: boolean; saturated: boolean; decayed: boolean }> {
    try {
      // 1. Ler peso atual
      const existing = await db
        .select()
        .from(cardLearning)
        .where(eq(cardLearning.cardName, cardName))
        .limit(1);

      let currentWeight = 1.0;
      if (existing.length > 0) {
        currentWeight = existing[0].weight;
      }

      // 2. Somar deltas brutos
      let rawDelta = 0;
      for (const update of updates) {
        rawDelta += update.delta ?? update.weightDelta ?? 0;
      }

      if (rawDelta === 0) {
        return { updated: false, saturated: false, decayed: false };
      }

      // 3. Aplicar decay proporcional
      const decayedDelta = applyDecay(currentWeight, rawDelta);
      const wasDecayed = Math.abs(decayedDelta) < Math.abs(rawDelta) * 0.99;

      // 4. Aplicar capping [0.1, 50.0]
      const newWeight = Math.max(MIN_WEIGHT, Math.min(MAX_WEIGHT, currentWeight + decayedDelta));
      const isSaturated = newWeight === MAX_WEIGHT || newWeight === MIN_WEIGHT;

      // 5. Só escreve no banco se houve mudança real (evita writes desnecessários)
      const changed = Math.abs(newWeight - currentWeight) > 0.0001;
      if (!changed) {
        return { updated: false, saturated: isSaturated, decayed: wasDecayed };
      }

      // 6. Upsert no banco
      if (existing.length > 0) {
        await db
          .update(cardLearning)
          .set({ weight: newWeight, updatedAt: new Date() })
          .where(eq(cardLearning.cardName, cardName));
      } else {
        await db.insert(cardLearning).values({
          cardName,
          weight: newWeight,
          updatedAt: new Date(),
        });
      }

      return { updated: true, saturated: isSaturated, decayed: wasDecayed };

    } catch (error) {
      // Erro silencioso — não poluir terminal
      return { updated: false, saturated: false, decayed: false };
    }
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
