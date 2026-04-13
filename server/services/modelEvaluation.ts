import { extractCardFeatures, CardFeatures, simulateTurns, calculateDeckMetrics } from "./gameFeatureEngine";
import { evaluateDeckWithBrain } from "./deckEvaluationBrain";
import { getMetaDecksForArchetype } from "./metaDecks";
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

    // Detectar combos antes do loop (determina se existe win condition acelerada)
    const comboA = this.detectCombo(featuresA);
    const comboB = this.detectCombo(featuresB);

    // Board state acumulado: criaturas permanecem em jogo entre turnos
    let boardPowerA = 0;
    let boardPowerB = 0;

    while (lifeA > 0 && lifeB > 0 && turn <= 20) {
      const handFactorA = 0.5 + Math.random();
      const handFactorB = 0.5 + Math.random();

      // ── Turno A ──────────────────────────────────────────────────
      // Combo win: se A tem combo pronto e B não tem counterspell suficiente
      if (comboA.hasCombo && turn >= comboA.comboTurn) {
        const countersB = this.calculateCounterspellCount(featuresB, turn);
        if (countersB === 0) {
          lifeB = 0;
          break;
        }
      }

      // Ameaças novas neste turno (ordenadas por CMC asc — sequência real de jogo)
      const newThreatsA = this.calculateTurnPower(featuresA, turn) * handFactorA;
      // Board acumula 85% das criaturas anteriores (remoções tiram ~15%)
      boardPowerA = boardPowerA * 0.85 + newThreatsA;
      const interactB = this.calculateInteraction(featuresB, turn) * (0.7 + Math.random() * 0.6);
      lifeB -= Math.max(0, boardPowerA - interactB);

      if (lifeB <= 0) break;

      // ── Turno B ──────────────────────────────────────────────────
      if (comboB.hasCombo && turn >= comboB.comboTurn) {
        const countersA = this.calculateCounterspellCount(featuresA, turn);
        if (countersA === 0) {
          lifeA = 0;
          break;
        }
      }

      const newThreatsB = this.calculateTurnPower(featuresB, turn) * handFactorB;
      boardPowerB = boardPowerB * 0.85 + newThreatsB;
      const interactA = this.calculateInteraction(featuresA, turn) * (0.7 + Math.random() * 0.6);
      lifeA -= Math.max(0, boardPowerB - interactA);

      turn++;
    }

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

  /**
   * Detecta se um deck tem combo win condition e estima o turno de execução.
   * Critério: engine recorrente (whenever/untap) + tutor OU (sacrifice + token).
   */
  private static detectCombo(features: CardFeatures[]): { hasCombo: boolean; comboTurn: number } {
    const hasEngine = features.some(f => f.roles.includes("engine"));
    const hasTutor  = features.some(f => f.roles.includes("tutor"));
    const hasSacrifice = features.some(f => f.mechanicTags.includes("sacrifice"));
    const hasToken     = features.some(f => f.mechanicTags.includes("token"));
    const hasCombo = hasEngine && (hasTutor || (hasSacrifice && hasToken));

    // Turno do combo ≈ CMC do enabler mais barato + 2 turnos de setup
    const enablerCmc = features
      .filter(f => f.roles.includes("engine") || f.roles.includes("tutor"))
      .reduce((min, f) => Math.min(min, f.cmc), 10);

    return { hasCombo, comboTurn: enablerCmc + 2 };
  }

  /**
   * Conta counterspells disponíveis na mão simulada para intercepção de combo.
   */
  private static calculateCounterspellCount(features: CardFeatures[], turn: number): number {
    return features.filter(f => f.cmc <= turn && f.roles.includes("counterspell")).length;
  }

  private static calculateTurnPower(features: CardFeatures[], turn: number): number {
    const playable = features.filter(f => f.cmc <= turn && f.roles.includes("threat"));
    if (playable.length === 0) return 0;

    const handSize = Math.min(playable.length, 6 + turn);
    // Ordenar por CMC asc: jogadores reais jogam ameaças baratas primeiro
    const sampled = [...playable].sort((a, b) => a.cmc - b.cmc).slice(0, handSize);
    const avgImpact = sampled.reduce((s, f) => s + f.impactScore, 0) / sampled.length;
    return avgImpact * (turn * 0.4);
  }

  private static calculateInteraction(features: CardFeatures[], turn: number): number {
    const interaction = features.filter(
      f => f.cmc <= turn && (f.roles.includes("removal") || f.roles.includes("counterspell") || f.roles.includes("board_wipe"))
    );
    const available = Math.min(interaction.length, 3 + Math.floor(turn / 2));
    return available * 0.3;
  }

  /**
   * Calcula o Winrate de um deck contra um conjunto de oponentes (Meta)
   */
  public static async evaluateWinrate(deck: any[], archetype: string, iterations: number = 20): Promise<number> {
    const opponentsRaw = await getMetaDecksForArchetype(archetype);
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
