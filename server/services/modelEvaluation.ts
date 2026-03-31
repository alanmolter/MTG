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

    // Simulação com variância estocástica para evitar winrate trivial de 100%.
    // Cada turno tem um fator de "mão" (0.5–1.5) que simula draws aleatórios.
    // Sem isso, o deck A (gerado pelo modelo) sempre vence por ter mais cartas
    // com impactScore alto, tornando o treinamento ineficaz.
    while (lifeA > 0 && lifeB > 0 && turn <= 20) {
      // Fator de variabilidade por turno (simula draws)
      const handFactorA = 0.5 + Math.random();
      const handFactorB = 0.5 + Math.random();

      // Turno A
      const powerA = this.calculateTurnPower(featuresA, turn) * handFactorA;
      const interactB = this.calculateInteraction(featuresB, turn) * (0.7 + Math.random() * 0.6);
      lifeB -= Math.max(0, powerA - interactB);

      if (lifeB <= 0) break;

      // Turno B
      const powerB = this.calculateTurnPower(featuresB, turn) * handFactorB;
      const interactA = this.calculateInteraction(featuresA, turn) * (0.7 + Math.random() * 0.6);
      lifeA -= Math.max(0, powerB - interactA);

      turn++;
    }

    // Empate (ambos com vida > 0 após 20 turnos): vence quem tem mais vida
    // Se igual, desempate aleatório 50/50
    if (lifeA > 0 && lifeB > 0) {
      if (lifeA === lifeB) {
        return { winner: Math.random() < 0.5 ? "A" : "B", turns: turn, finalLifeA: lifeA, finalLifeB: lifeB };
      }
      return { winner: lifeA > lifeB ? "A" : "B", turns: turn, finalLifeA: lifeA, finalLifeB: lifeB };
    }

    return {
      winner: lifeB <= 0 ? "A" : "B",
      turns: turn,
      finalLifeA: Math.max(0, lifeA),
      finalLifeB: Math.max(0, lifeB)
    };
  }

  private static calculateTurnPower(features: CardFeatures[], turn: number): number {
    // Ameaças jogáveis no turno (CMC <= turno atual)
    const playable = features.filter(f => f.cmc <= turn && f.roles.includes("threat"));
    if (playable.length === 0) return 0;

    // Simular mão de 7 cartas: em cada turno, o jogador tem acesso a ~7 + turno cartas
    // do deck (mão inicial + draws). Limitar as ameaças ativas a esse número
    // evita que decks Commander (100 cartas) dominem decks Standard (60 cartas)
    // por puro volume de cartas jogáveis.
    const handSize = Math.min(playable.length, 6 + turn);
    const sampled = playable.slice(0, handSize);
    const avgImpact = sampled.reduce((s, f) => s + f.impactScore, 0) / sampled.length;
    return avgImpact * (turn * 0.4); // escala com o jogo
  }

  private static calculateInteraction(features: CardFeatures[], turn: number): number {
    // Remoções/Counterspells disponíveis — limitadas pela mão simulada
    const interaction = features.filter(f => f.cmc <= turn && (f.roles.includes("removal") || f.roles.includes("counterspell")));
    const available = Math.min(interaction.length, 3 + Math.floor(turn / 2));
    return available * 0.3;
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
    // Log silencioso: armazena em memória para getHistory().
    // Não imprime no console para evitar spam de JSON multi-linha
    // a cada iteração do self-play (100 iterações = 100 blocos JSON).
    // O feedback visual é feito pela barra de progresso + printForgeSelfPlayStatus.
  }

  public static getHistory() {
    return this.logs;
  }
}
