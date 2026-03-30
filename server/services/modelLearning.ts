import { getDb } from "../db";
import { cardLearning, cards, Card } from "../../drizzle/schema";
import { eq, sql } from "drizzle-orm";
import { ModelEvaluator } from "./modelEvaluation";
import { evaluateDeckWithBrain } from "./deckEvaluationBrain";
import { getCardLearningQueue } from "./cardLearningQueue";

/**
 * Model Learning Service (Nível AlphaZero)
 *
 * Este serviço gerencia o loop de aprendizado contínuo, evolução genética
 * e self-play para transformar o gerador em uma verdadeira IA de decks.
 *
 * CORREÇÃO CRÍTICA (Race Condition #2):
 *   Todas as escritas em card_learning passam pela CardLearningQueue,
 *   que serializa as atualizações em uma fila FIFO com worker único.
 *   Isso elimina a race condition entre os três escritores concorrentes:
 *     1. Front-end (geração de deck pelo usuário)
 *     2. Self-play / treinamento contínuo
 *     3. Commander specialist training
 *
 * CORREÇÃO CRÍTICA (Weight Capping):
 *   Todos os pesos são limitados ao intervalo [0.1, 50.0] via SQL LEAST/GREATEST,
 *   evitando que cartas acumulem pesos infinitos após muitas iterações.
 *
 * CORREÇÃO CRÍTICA (Log Spam):
 *   getCardWeights() usa cache em memória com TTL de 60 segundos.
 *   O log de status é emitido apenas UMA vez por sessão (flag _logged).
 *   Isso evita que o self-play (100+ decks/iteração) polua o terminal
 *   com milhares de linhas idênticas de "[Brain] Dados de inteligencia...".
 */

/** Limites de peso para evitar divergência */
export const WEIGHT_MIN = 0.1;
export const WEIGHT_MAX = 50.0;

/** TTL do cache de pesos em memória (ms) */
const WEIGHT_CACHE_TTL_MS = 60_000; // 60 segundos

/** Cache em memória dos pesos de aprendizado */
let _weightCache: Record<string, number> | null = null;
let _weightCacheTimestamp = 0;
let _weightCacheLogged = false; // garante log único por sessão de processo

/** Fonte de aprendizado — usada para rastrear qual processo atualizou o peso */
export type LearningSource = "user_generation" | "self_play" | "commander_train" | "rl_policy" | "forge_reality";

export class modelLearningService {
  /**
   * Recupera os pesos atuais de aprendizado do banco.
   *
   * OTIMIZAÇÃO: Cache em memória com TTL de 60s.
   * O SELECT no banco ocorre no máximo 1x por minuto, independentemente de
   * quantos decks sejam gerados em paralelo durante o self-play.
   *
   * LOG: Emitido apenas UMA vez por sessão de processo para não poluir o terminal.
   *
   * Para forçar recarga imediata (ex: após updateWeights), use invalidateCache().
   */
  public static async getCardWeights(): Promise<Record<string, number>> {
    const now = Date.now();

    // Retorna cache se ainda válido
    if (_weightCache !== null && (now - _weightCacheTimestamp) < WEIGHT_CACHE_TTL_MS) {
      return _weightCache;
    }

    const database = await getDb();
    if (!database) return {};

    const weights = await database.select().from(cardLearning);
    const weightMap: Record<string, number> = {};
    let highCount = 0;
    let midCount  = 0;
    let baseCount = 0;

    weights.forEach(w => {
      weightMap[w.cardName] = w.weight;
      if (w.weight >= 10.0)      highCount++;
      else if (w.weight >= 2.0)  midCount++;
      else                       baseCount++;
    });

    // Atualiza cache
    _weightCache = weightMap;
    _weightCacheTimestamp = now;

    // Log apenas uma vez por sessão de processo
    if (!_weightCacheLogged && weights.length > 0) {
      _weightCacheLogged = true;
      console.log(`[Brain] Dados de inteligencia carregados: ${weights.length} cartas`);
      console.log(`[Brain] Alta relevancia (>=10): ${highCount} | Media (2-9): ${midCount} | Base (<2): ${baseCount}`);
      console.log(`[Brain] Fontes: forge_reality + self_play + commander_train + user_generation + rl_policy`);
      console.log(`[Brain] Pesos serao aplicados na selecao de cartas do deck.`);
      console.log(`[Brain] Cache ativo: recarrega a cada ${WEIGHT_CACHE_TTL_MS / 1000}s.`);
    }

    return weightMap;
  }

  /**
   * Invalida o cache de pesos, forçando recarga no próximo getCardWeights().
   * Chamado automaticamente após updateWeights() para garantir consistência.
   */
  public static invalidateCache(): void {
    _weightCache = null;
    _weightCacheTimestamp = 0;
    // Não reseta _weightCacheLogged — o log de status já foi emitido
  }

  /**
   * Salva ou atualiza pesos de aprendizado via fila serializada.
   *
   * CORREÇÃO: Usa CardLearningQueue para evitar race condition.
   * CORREÇÃO: Aplica weight capping [0.1, 50.0] via SQL LEAST/GREATEST.
   * CORREÇÃO: Invalida cache após escrita para garantir consistência.
   *
   * @param updates  Mapa de carta → delta de peso
   * @param source   Identificador da fonte de aprendizado (para rastreabilidade)
   */
  public static async updateWeights(
    updates: Record<string, { weightDelta: number; scoreDelta?: number; win?: boolean }>,
    source: LearningSource = "self_play"
  ): Promise<void> {
    const queue = getCardLearningQueue();

    for (const [name, data] of Object.entries(updates)) {
      // Enfileira cada atualização — o worker processa sequencialmente
      queue.enqueue({
        cardName: name,
        weightDelta: data.weightDelta,
        scoreDelta: data.scoreDelta,
        win: data.win,
        source,
      });
    }

    // Aguarda o processamento da fila para garantir persistência antes de retornar
    await queue.flush();

    // Invalida cache após escrita — próxima leitura buscará dados atualizados
    modelLearningService.invalidateCache();
  }

  /**
   * Atualização direta no banco com weight capping — usada internamente pela queue.
   * NÃO chamar diretamente de fora desta classe; use updateWeights().
   */
  public static async _applyWeightUpdate(
    database: Awaited<ReturnType<typeof getDb>>,
    cardName: string,
    weightDelta: number,
    scoreDelta?: number,
    win?: boolean
  ): Promise<void> {
    if (!database) return;

    await database
      .insert(cardLearning)
      .values({
        cardName,
        // Peso inicial clampeado
        weight: Math.min(WEIGHT_MAX, Math.max(WEIGHT_MIN, 1.0 + weightDelta)),
        winCount: win ? 1 : 0,
        lossCount: win === false ? 1 : 0,
        avgScore: scoreDelta ?? 0,
      })
      .onConflictDoUpdate({
        target: cardLearning.cardName,
        set: {
          // GREATEST/LEAST garantem weight capping [0.1, 50.0] no próprio SQL
          weight: sql`GREATEST(${WEIGHT_MIN}, LEAST(${WEIGHT_MAX}, ${cardLearning.weight} + ${weightDelta}))`,
          winCount: win
            ? sql`${cardLearning.winCount} + 1`
            : sql`${cardLearning.winCount}`,
          lossCount:
            win === false
              ? sql`${cardLearning.lossCount} + 1`
              : sql`${cardLearning.lossCount}`,
          avgScore: scoreDelta
            ? sql`(${cardLearning.avgScore} + ${scoreDelta}) / 2`
            : cardLearning.avgScore,
          updatedAt: new Date(),
        },
      });
  }

  /**
   * GENETIC ENGINE: Mutação de um deck (10% das cartas substituídas aleatoriamente)
   */
  public static mutate(deck: any[], cardPool: any[]): any[] {
    const mutated = [...deck];
    const mutations = Math.max(1, Math.floor(mutated.length * 0.1));

    for (let i = 0; i < mutations; i++) {
      const idx = Math.floor(Math.random() * mutated.length);
      const randomCard = cardPool[Math.floor(Math.random() * cardPool.length)];
      if (randomCard) {
        mutated[idx] = { ...randomCard, quantity: mutated[idx].quantity || 1 };
      }
    }
    return mutated;
  }

  /**
   * GENETIC ENGINE: Crossover entre dois decks (metade de cada)
   */
  public static crossover(deckA: any[], deckB: any[]): any[] {
    const split = Math.floor(deckA.length / 2);
    const child = [...deckA.slice(0, split), ...deckB.slice(split)];
    return child.slice(0, deckA.length);
  }

  /**
   * SELF-PLAY: Simula partidas entre a população e atualiza pesos via fila.
   *
   * Deltas aplicados:
   *   Vencedor: +0.05 por carta
   *   Perdedor: -0.02 por carta
   */
  public static async runSelfPlaySession(population: any[][]): Promise<void> {
    const weightUpdates: Record<string, { weightDelta: number; win?: boolean }> = {};

    for (let i = 0; i < population.length; i++) {
      for (let j = i + 1; j < Math.min(i + 5, population.length); j++) {
        const result = ModelEvaluator.simulateMatch(population[i], population[j]);
        const winner = result.winner === "A" ? population[i] : population[j];
        const loser  = result.winner === "A" ? population[j] : population[i];

        winner.forEach(card => {
          if (!weightUpdates[card.name]) weightUpdates[card.name] = { weightDelta: 0 };
          weightUpdates[card.name].weightDelta += 0.05;
          weightUpdates[card.name].win = true;
        });

        loser.forEach(card => {
          if (!weightUpdates[card.name]) weightUpdates[card.name] = { weightDelta: 0 };
          weightUpdates[card.name].weightDelta -= 0.02;
          weightUpdates[card.name].win = false;
        });
      }
    }

    // Passa pela fila — sem race condition, com weight capping
    await this.updateWeights(weightUpdates, "self_play");
  }
}
