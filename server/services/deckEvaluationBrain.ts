/**
 * Deck Evaluation Brain (Cérebro de Avaliação de Decks)
 */

import {
  extractCardFeatures,
  manaCurveScore,
  landRatioScore,
  mechanicSynergyScore,
  simulateTurns,
  CardFeatures,
  DeckMetrics,
  calculateDeckMetrics,
} from "./gameFeatureEngine";
import { metaAnalyzer } from "./metaAnalytics";
import { META_DECKS } from "./metaDecks";

// ─── Inicialização Meta-Learning ──────────────────────────────────────────────

let isMetaInitialized = false;

async function initMetaBenchmarks() {
  if (isMetaInitialized) return;
  
  for (const [archetype, decklists] of Object.entries(META_DECKS)) {
    const decks: any[][] = [];
    for (const dl of decklists) {
      const parsed = await (import("./metaAnalytics")).then(m => m.MetaAnalytics.parseDecklist(dl));
      if (parsed.length > 0) decks.push(parsed);
    }
    
    if (decks.length > 0) {
      metaAnalyzer.generateBenchmark(archetype, decks);
      console.log(`[BRAIN] Meta-Benchmark Gerada: ${archetype} (n=${decks.length})`);
    }
  }
  isMetaInitialized = true;
}

// ─── Tipos Estendidos ─────────────────────────────────────────────────────────

export interface ArchetypeProfile {
  name: string;
  curveWeight: number;
  structureWeight: number;
  synergyWeight: number;
  simulationWeight: number;
  consistencyWeight: number;
  minRemovalCount: number;
  minThreatCount: number;
  minDrawCount: number;
  maxLandCount: number;
  minLandCount: number;
}

export interface EvaluationResult extends DeckMetrics {
  normalizedScore: number;
  recommendations: string[];
  tier: "S" | "A" | "B" | "C" | "D" | "F";
  analysis: {
    strengths: string[];
    weaknesses: string[];
    suggestions: string[];
  };
}

// ─── Perfis de Arquétipos ─────────────────────────────────────────────────────

const ARCHETYPE_PROFILES: Record<string, ArchetypeProfile> = {
  aggro: {
    name: "Aggro",
    curveWeight: 0.35,
    structureWeight: 0.25,
    synergyWeight: 0.15,
    simulationWeight: 0.15,
    consistencyWeight: 0.1,
    minRemovalCount: 2,
    minThreatCount: 18,
    minDrawCount: 0,
    maxLandCount: 22,
    minLandCount: 18,
  },
  burn: {
    name: "Burn",
    curveWeight: 0.4,
    structureWeight: 0.2,
    synergyWeight: 0.15,
    simulationWeight: 0.15,
    consistencyWeight: 0.1,
    minRemovalCount: 6,
    minThreatCount: 4,
    minDrawCount: 0,
    maxLandCount: 22,
    minLandCount: 18,
  },
  tempo: {
    name: "Tempo",
    curveWeight: 0.3,
    structureWeight: 0.25,
    synergyWeight: 0.2,
    simulationWeight: 0.15,
    consistencyWeight: 0.1,
    minRemovalCount: 4,
    minThreatCount: 12,
    minDrawCount: 4,
    maxLandCount: 22,
    minLandCount: 18,
  },
  midrange: {
    name: "Midrange",
    curveWeight: 0.25,
    structureWeight: 0.3,
    synergyWeight: 0.2,
    simulationWeight: 0.15,
    consistencyWeight: 0.1,
    minRemovalCount: 6,
    minThreatCount: 14,
    minDrawCount: 2,
    maxLandCount: 26,
    minLandCount: 22,
  },
  control: {
    name: "Control",
    curveWeight: 0.2,
    structureWeight: 0.3,
    synergyWeight: 0.2,
    simulationWeight: 0.2,
    consistencyWeight: 0.1,
    minRemovalCount: 8,
    minThreatCount: 2,
    minDrawCount: 6,
    maxLandCount: 28,
    minLandCount: 24,
  },
  ramp: {
    name: "Ramp",
    curveWeight: 0.25,
    structureWeight: 0.3,
    synergyWeight: 0.2,
    simulationWeight: 0.15,
    consistencyWeight: 0.1,
    minRemovalCount: 2,
    minThreatCount: 8,
    minDrawCount: 4,
    maxLandCount: 26,
    minLandCount: 20,
  },
  combo: {
    name: "Combo",
    curveWeight: 0.2,
    structureWeight: 0.25,
    synergyWeight: 0.35,
    simulationWeight: 0.1,
    consistencyWeight: 0.1,
    minRemovalCount: 0,
    minThreatCount: 4,
    minDrawCount: 6,
    maxLandCount: 24,
    minLandCount: 20,
  },
  default: {
    name: "Default",
    curveWeight: 0.25,
    structureWeight: 0.25,
    synergyWeight: 0.2,
    simulationWeight: 0.2,
    consistencyWeight: 0.1,
    minRemovalCount: 4,
    minThreatCount: 14,
    minDrawCount: 2,
    maxLandCount: 26,
    minLandCount: 22,
  },
};

// ─── Helpers de Scoring ───────────────────────────────────────────────────────

function normalizeScore(score: number, min: number = -50, max: number = 50): number {
  const clamped = Math.max(min, Math.min(max, score));
  return Math.round(((clamped - min) / (max - min)) * 100);
}

function getTier(score: number): "S" | "A" | "B" | "C" | "D" | "F" {
  if (score >= 90) return "S";
  if (score >= 80) return "A";
  if (score >= 70) return "B";
  if (score >= 60) return "C";
  if (score >= 50) return "D";
  return "F";
}

// ─── Função de Avaliação Completa ─────────────────────────────────────────────

export async function evaluateDeckWithBrain(
  cards: any[],
  archetype: string = "default"
): Promise<EvaluationResult> {
  await initMetaBenchmarks();

  const metrics = calculateDeckMetrics(cards, archetype);
  const profile = ARCHETYPE_PROFILES[archetype] || ARCHETYPE_PROFILES.default;
  const benchmark = metaAnalyzer.getBenchmark(archetype);

  // 1. Meta-Learning Adjustment (O PULO DO GATO)
  let benchmarkBonus = 0;
  if (benchmark) {
    // Curva: Comparar com a média pro
    for (const [cmcStr, avg] of Object.entries(benchmark.avgCurve)) {
      const actual = metrics.manaCurve[parseInt(cmcStr)] || 0;
      if (Math.abs(actual - avg) <= 1.5) benchmarkBonus += 3;
    }
    // Roles: Comparar com a estrutura pro
    for (const [role, avg] of Object.entries(benchmark.avgRoles)) {
      const actual = metrics.roleCounts[role] || 0;
      if (Math.abs(actual - avg) <= 2) benchmarkBonus += 5;
    }
  }

  const finalNormalize = normalizeScore(metrics.totalScore + benchmarkBonus, -50, 100);

  // 2. Análise Estrutural (Refatorada)
  const strengths: string[] = [];
  const weaknesses: string[] = [];
  const suggestions: string[] = [];

  if (metrics.removalCount >= profile.minRemovalCount) strengths.push("Remoção adequada");
  else {
    weaknesses.push("Remoção insuficiente");
    suggestions.push(`Adicione mais respostas (alvo: ${profile.minRemovalCount})`);
  }

  if (metrics.roleCounts.threat >= profile.minThreatCount) strengths.push("Densidade de ameaças sólida");
  else {
    weaknesses.push("Apenas algumas ameaças");
    suggestions.push(`Aumente o número de ameaças para pressionar o oponente`);
  }

  if (benchmarkBonus > 15) strengths.push("Alinhamento excelente com o meta profissional");

  return {
    ...metrics,
    normalizedScore: finalNormalize,
    tier: getTier(finalNormalize),
    recommendations: suggestions,
    analysis: { strengths, weaknesses, suggestions }
  };
}

export function evaluateDeckQuick(cards: any[], archetype: string): number {
  const metrics = calculateDeckMetrics(cards, archetype);
  return normalizeScore(metrics.totalScore);
}
