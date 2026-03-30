/**
 * RL to Card Learning Bridge
 *
 * CORREÇÃO CRÍTICA (Problema 3): RL REINFORCE estava desconectado do ciclo de aprendizado.
 *
 * Este bridge:
 * 1. Persiste decisões do RL na tabela rl_decisions (schema.ts)
 * 2. Calcula rewards após partidas simuladas
 * 3. Retroalimenta card_learning via CardLearningQueue (sem race condition)
 * 4. Conecta trainDeckWithRL ao aprendizado tabular via feedbackFromDeckOptimization()
 *
 * Fórmula: delta = reward × 0.1  (escala reduzida para evitar overfitting)
 * Fonte:   "rl_feedback" (rastreável na fila)
 */

import { getDb } from "../db";
import { rlDecisions } from "../../drizzle/schema";
import { eq, and, isNotNull } from "drizzle-orm";
import { getCardLearningQueue } from "./cardLearningQueue";

export interface RLDecision {
  deckId?: number;
  cardName: string;
  policyProbability: number;
  reward?: number;
}

export class RLToCardLearningBridge {
  /**
   * Registra uma decisão do RL quando uma carta é selecionada pela policy.
   * Persiste em rl_decisions para processamento posterior.
   */
  async recordRLDecision(decision: RLDecision): Promise<void> {
    const db = await getDb();
    if (!db) {
      console.warn("[RLBridge] Database not available — decision not recorded");
      return;
    }

    try {
      await db.insert(rlDecisions).values({
        deckId: decision.deckId ?? null,
        cardName: decision.cardName,
        policyProbability: decision.policyProbability,
        reward: decision.reward ?? null,
        processed: false,
      });

      console.log(
        `[RLBridge] Recorded: ${decision.cardName} ` +
        `(prob: ${decision.policyProbability.toFixed(3)})`
      );
    } catch (error) {
      console.error("[RLBridge] Failed to record decision:", error);
    }
  }

  /**
   * Sincroniza rewards do RL para card_learning via fila serializada.
   * Chamado pelo pipeline de treinamento após partidas serem jogadas.
   *
   * @returns { synced, totalReward }
   */
  async syncRLRewardsToCardLearning(): Promise<{ synced: number; totalReward: number }> {
    const db = await getDb();
    if (!db) {
      console.warn("[RLBridge] Database not available");
      return { synced: 0, totalReward: 0 };
    }

    try {
      // 1. Buscar decisões com reward definido e ainda não processadas
      const pending = await db
        .select()
        .from(rlDecisions)
        .where(
          and(
            eq(rlDecisions.processed, false),
            isNotNull(rlDecisions.reward)
          )
        )
        .limit(500);

      if (pending.length === 0) {
        console.log("[RLBridge] No unprocessed RL decisions");
        return { synced: 0, totalReward: 0 };
      }

      const queue = getCardLearningQueue();
      let totalReward = 0;

      // 2. Converter rewards em deltas e enfileirar em card_learning
      for (const decision of pending) {
        if (decision.reward === null || decision.reward === undefined) continue;

        // Delta = reward × 0.1 (escala reduzida para evitar overfitting)
        const delta = decision.reward * 0.1;

        queue.enqueue({
          cardName: decision.cardName,
          delta,
          source: "rl_feedback",
          metadata: {
            rlDecisionId: decision.id,
            policyProbability: decision.policyProbability,
            originalReward: decision.reward,
          },
        });

        totalReward += decision.reward;
      }

      // 3. Marcar como processadas
      for (const d of pending) {
        await db
          .update(rlDecisions)
          .set({ processed: true })
          .where(eq(rlDecisions.id, d.id));
      }

      // 4. Aguardar flush da fila para garantir persistência
      await queue.flush();

      console.log(
        `[RLBridge] ✓ Synced ${pending.length} RL decisions ` +
        `(total reward: ${totalReward.toFixed(2)})`
      );

      return { synced: pending.length, totalReward };
    } catch (error) {
      console.error("[RLBridge] Error syncing RL rewards:", error);
      return { synced: 0, totalReward: 0 };
    }
  }

  /**
   * Calcula reward para uma decisão RL baseado no resultado da partida.
   * Normalizado em [-1, 1] ponderado pela probabilidade da policy.
   */
  calculateReward(
    deckPerformance: { wins: number; losses: number; draws: number },
    policyProbability: number
  ): number {
    const totalGames = deckPerformance.wins + deckPerformance.losses + deckPerformance.draws;
    if (totalGames === 0) return 0;

    const winRate = deckPerformance.wins / totalGames;
    const reward = (winRate - 0.5) * policyProbability;
    return Math.max(-1, Math.min(1, reward));
  }

  /**
   * Retroalimenta card_learning após otimização de deck pelo trainDeckWithRL.
   * Conecta o RL ao ciclo tabular de aprendizado.
   *
   * @param deck    Cartas do deck otimizado
   * @param score   Score final do deck (0–100)
   * @param deckId  ID do deck no banco (opcional)
   */
  async feedbackFromDeckOptimization(
    deck: { name: string }[],
    score: number,
    deckId?: number
  ): Promise<void> {
    // Normaliza score para reward em [-1, 1]
    // Score 50 = reward 0 (neutro), 100 = reward +1, 0 = reward -1
    const reward = (score - 50) / 50;

    const queue = getCardLearningQueue();

    for (const card of deck) {
      // Delta = reward × 0.05 (mais conservador que self-play)
      const delta = reward * 0.05;
      queue.enqueue({
        cardName: card.name,
        delta,
        source: "rl_feedback",
        metadata: { deckScore: score, deckId },
      });
    }

    console.log(
      `[RLBridge] Queued RL feedback for ${deck.length} cards ` +
      `(score: ${score.toFixed(1)}, reward: ${reward.toFixed(3)})`
    );
  }
}

// Singleton
let bridgeInstance: RLToCardLearningBridge | null = null;

export function getRLToCardLearningBridge(): RLToCardLearningBridge {
  if (!bridgeInstance) {
    bridgeInstance = new RLToCardLearningBridge();
  }
  return bridgeInstance;
}
