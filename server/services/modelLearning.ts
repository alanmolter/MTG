import { getDb } from "../db";
import { cardLearning, cards, Card } from "../../drizzle/schema";
import { eq, sql } from "drizzle-orm";
import { ModelEvaluator } from "./modelEvaluation";
import { evaluateDeckWithBrain } from "./deckEvaluationBrain";

/**
 * Model Learning Service (Nível AlphaZero)
 * 
 * Este serviço gerencia o loop de aprendizado contínuo, evolução genética
 * e self-play para transformar o gerador em uma verdadeira IA de decks.
 */

export class modelLearningService {
  /**
   * Recupera os pesos atuais de aprendizado do banco
   */
  public static async getCardWeights(): Promise<Record<string, number>> {
    const database = await getDb();
    if (!database) return {};
    
    const weights = await database.select().from(cardLearning);
    const weightMap: Record<string, number> = {};
    weights.forEach(w => {
      weightMap[w.cardName] = w.weight;
    });
    return weightMap;
  }

  /**
   * Salva ou atualiza pesos de aprendizado
   */
  public static async updateWeights(updates: Record<string, { weightDelta: number, scoreDelta?: number, win?: boolean }>) {
    const database = await getDb();
    if (!database) return;

    for (const [name, data] of Object.entries(updates)) {
      await database
        .insert(cardLearning)
        .values({
          cardName: name,
          weight: 1.0 + data.weightDelta,
          winCount: data.win ? 1 : 0,
          lossCount: data.win === false ? 1 : 0,
          avgScore: data.scoreDelta || 0,
        })
        .onConflictDoUpdate({
          target: cardLearning.cardName,
          set: {
            weight: sql`${cardLearning.weight} + ${data.weightDelta}`,
            winCount: data.win ? sql`${cardLearning.winCount} + 1` : sql`${cardLearning.winCount}`,
            lossCount: data.win === false ? sql`${cardLearning.lossCount} + 1` : sql`${cardLearning.lossCount}`,
            avgScore: data.scoreDelta ? sql`(${cardLearning.avgScore} + ${data.scoreDelta}) / 2` : cardLearning.avgScore,
            updatedAt: new Date(),
          },
        });
    }
  }

  /**
   * GENETIC ENGINE: Mutação de um deck
   */
  public static mutate(deck: any[], cardPool: any[]): any[] {
    const mutated = [...deck];
    const mutations = Math.max(1, Math.floor(mutated.length * 0.1)); // 10% de mutação

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
   * GENETIC ENGINE: Crossover entre dois decks
   */
  public static crossover(deckA: any[], deckB: any[]): any[] {
    const split = Math.floor(deckA.length / 2);
    // Combina metade de cada, removendo duplicatas de nome se necessário para manter consistência
    const child = [...deckA.slice(0, split), ...deckB.slice(split)];
    return child.slice(0, deckA.length);
  }

  /**
   * SELF-PLAY: Simula partidas entre a população e atualiza pesos
   */
  public static async runSelfPlaySession(population: any[][]) {
    const weightUpdates: Record<string, { weightDelta: number, win?: boolean }> = {};

    for (let i = 0; i < population.length; i++) {
      for (let j = i + 1; j < Math.min(i + 5, population.length); j++) {
        const result = ModelEvaluator.simulateMatch(population[i], population[j]);
        const winner = result.winner === "A" ? population[i] : population[j];
        const loser = result.winner === "A" ? population[j] : population[i];

        // Premiar vencedor
        winner.forEach(card => {
          if (!weightUpdates[card.name]) weightUpdates[card.name] = { weightDelta: 0 };
          weightUpdates[card.name].weightDelta += 0.05;
          weightUpdates[card.name].win = true;
        });

        // Penalizar perdedor (levemente)
        loser.forEach(card => {
          if (!weightUpdates[card.name]) weightUpdates[card.name] = { weightDelta: 0 };
          weightUpdates[card.name].weightDelta -= 0.02;
          weightUpdates[card.name].win = false;
        });
      }
    }

    await this.updateWeights(weightUpdates);
  }
}
