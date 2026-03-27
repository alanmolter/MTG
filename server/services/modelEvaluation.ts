import { extractCardFeatures, CardFeatures, simulateTurns, calculateDeckMetrics } from "./gameFeatureEngine";
import { evaluateDeckWithBrain } from "./deckEvaluationBrain";
import { META_DECKS } from "./metaDecks";
import { MetaAnalytics } from "./metaAnalytics";

/**
 * Model Evaluation & Regression Testing Service
 * 
 * Este serviço implementa a infraestrutura de "Startup Real" para medir o progresso do modelo.
 */

export interface MatchResult {
  winner: "A" | "B";
  turns: number;
  finalLifeA: number;
  finalLifeB: number;
}

export class ModelEvaluator {
  /**
   * Simula uma partida entre dois decks.
   * Não é uma simulação perfeita, mas mede a eficiência e interação.
   */
  public static simulateMatch(deckA: any[], deckB: any[]): MatchResult {
    const featuresA = deckA.map(c => extractCardFeatures(c));
    const featuresB = deckB.map(c => extractCardFeatures(c));

    let lifeA = 20;
    let lifeB = 20;
    let turn = 1;
    
    // Simplificação: Cada deck joga sua curva e causa dano baseado no Impact Score + Ameaças
    // Decks com remoção podem "atrasar" o impacto do outro
    while (lifeA > 0 && lifeB > 0 && turn <= 20) {
      // Turno A
      const powerA = this.calculateTurnPower(featuresA, turn);
      const interactB = this.calculateInteraction(featuresB, turn);
      lifeB -= Math.max(0, powerA - interactB);

      if (lifeB <= 0) break;

      // Turno B
      const powerB = this.calculateTurnPower(featuresB, turn);
      const interactA = this.calculateInteraction(featuresA, turn);
      lifeA -= Math.max(0, powerB - interactA);

      turn++;
    }

    return {
      winner: lifeB <= 0 ? "A" : "B",
      turns: turn,
      finalLifeA: lifeA,
      finalLifeB: lifeB
    };
  }

  private static calculateTurnPower(features: CardFeatures[], turn: number): number {
    // Ameaças jogadas no turno baseado na média de curva
    const playable = features.filter(f => f.cmc <= turn && f.roles.includes("threat"));
    const avgImpact = playable.length > 0 ? playable.reduce((s, f) => s + f.impactScore, 0) / 10 : 0;
    return avgImpact * (turn * 0.5); // escala com o jogo
  }

  private static calculateInteraction(features: CardFeatures[], turn: number): number {
    // Remoções/Counterspells disponíveis
    const interaction = features.filter(f => f.cmc <= turn && (f.roles.includes("removal") || f.roles.includes("counterspell")));
    return interaction.length * 0.3;
  }

  /**
   * Calcula o Winrate de um deck contra um conjunto de oponentes (Meta)
   */
  public static async evaluateWinrate(deck: any[], archetype: string, iterations: number = 20): Promise<number> {
    const opponentsRaw = META_DECKS[archetype as keyof typeof META_DECKS] || META_DECKS.aggro;
    const opponents = await Promise.all(opponentsRaw.map(dl => MetaAnalytics.parseDecklist(dl)));
    
    let wins = 0;
    for (const opponent of opponents) {
      for (let i = 0; i < iterations; i++) {
        const result = this.simulateMatch(deck, opponent);
        if (result.winner === "A") wins++;
      }
    }

    return wins / (opponents.length * iterations);
  }

  /**
   * Executa Testes de Regressão Automatizados
   */
  public static async runRegressionTests(currentGenerator: (arch: string) => Promise<any[]>): Promise<any> {
    const testArchetypes = ["aggro", "control", "midrange"];
    const results: any[] = [];

    for (const arch of testArchetypes) {
      const deck = await currentGenerator(arch);
      const metrics = calculateDeckMetrics(deck, arch);
      const winrate = await this.evaluateWinrate(deck, arch);
      const brain = await evaluateDeckWithBrain(deck, arch);

      results.push({
        archetype: arch,
        totalScore: metrics.totalScore,
        normalizedScore: brain.normalizedScore,
        winrate,
        tier: brain.tier,
        consistency: metrics.consistencyScore
      });
    }

    return results;
  }
}

/**
 * Interface de Tracking (MLflow Lite)
 */
export class ExperimentTracker {
  private static logs: any[] = [];

  public static logExperiment(name: string, metrics: any) {
    const entry = {
      timestamp: new Date().toISOString(),
      name,
      metrics
    };
    this.logs.push(entry);
    console.log(`[TRACKER] ${name}:`, metrics);
    // TODO: persistir em disco/banco
  }

  public static getHistory() {
    return this.logs;
  }
}
