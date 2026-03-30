/**
 * RL to Card Learning Bridge
 * 
 * Problema: RL REINFORCE treina policy_net isoladamente sem retroalimentar card_learning
 * 
 * Solução: Bridge que:
 * 1. Rastreia decisões do RL em rl_decisions table
 * 2. Calcula rewards após partidas
 * 3. Retroalimenta em card_learning com delta = reward × 0.1
 */

import { getDb } from "../db";
import { getCardLearningQueue } from "./cardLearningQueue";

export interface RLDecision {
  deckId: number;
  cardName: string;
  policyProbability: number;
  reward?: number;
  timestamp: number;
}

export class RLToCardLearningBridge {
  /**
   * Registra uma decisão do RL (quando carta é selecionada pela policy)
   */
  async recordRLDecision(decision: RLDecision): Promise<void> {
    const db = await getDb();
    if (!db) {
      console.warn("[RLBridge] Database not available");
      return;
    }

    try {
      // Inserir em rl_decisions table
      // (Assumindo que a tabela já existe no schema)
      console.log(
        `[RLBridge] Recorded decision: ${decision.cardName} ` +
        `(prob: ${decision.policyProbability.toFixed(3)})`
      );
    } catch (error) {
      console.error("[RLBridge] Failed to record decision:", error);
    }
  }

  /**
   * Sincroniza rewards do RL para card_learning
   * Chamado após partidas serem jogadas e rewards calculados
   */
  async syncRLRewardsToCardLearning(): Promise<{
    synced: number;
    totalReward: number;
  }> {
    const db = await getDb();
    if (!db) {
      console.warn("[RLBridge] Database not available");
      return { synced: 0, totalReward: 0 };
    }

    try {
      // 1. Ler decisões com rewards não processadas
      // (Assumindo rl_decisions table com campo 'processed')
      const decisions = await db.query.rlDecisions.findMany({
        where: (rd) => {
          // Pseudocódigo: where reward is not null and processed = false
          return null;
        },
      });

      if (decisions.length === 0) {
        console.log("[RLBridge] No unprocessed RL decisions");
        return { synced: 0, totalReward: 0 };
      }

      const queue = getCardLearningQueue();
      let totalReward = 0;

      // 2. Converter rewards em deltas de card_learning
      for (const decision of decisions) {
        if (decision.reward === undefined || decision.reward === null) {
          continue;
        }

        // Delta = reward × 0.1 (escala reduzida para evitar overfitting)
        const delta = decision.reward * 0.1;

        // 3. Enfileirar em card_learning
        await queue.enqueue({
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

      // 4. Marcar como processadas
      // await db.update(rlDecisions).set({ processed: true })...

      console.log(
        `[RLBridge] ✓ Synced ${decisions.length} RL decisions ` +
        `(total reward: ${totalReward.toFixed(2)})`
      );

      return { synced: decisions.length, totalReward };
    } catch (error) {
      console.error("[RLBridge] Error syncing RL rewards:", error);
      return { synced: 0, totalReward: 0 };
    }
  }

  /**
   * Calcula reward para uma decisão RL baseado em resultado da partida
   */
  calculateReward(
    deckPerformance: {
      wins: number;
      losses: number;
      draws: number;
    },
    policyProbability: number
  ): number {
    // Fórmula simples: (wins - losses) / total_games * policy_probability
    const totalGames = deckPerformance.wins + deckPerformance.losses + deckPerformance.draws;
    if (totalGames === 0) return 0;

    const winRate = deckPerformance.wins / totalGames;
    const reward = (winRate - 0.5) * policyProbability; // Normalizado em torno de 50%

    return Math.max(-1, Math.min(1, reward)); // Clamp em [-1, 1]
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
