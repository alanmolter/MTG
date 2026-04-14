/**
 * Deck Evaluation Brain (Cérebro de Avaliação de Decks)
 *
 * O "Cérebro" do sistema que orquestra todas as métricas para fornecer uma
 * avaliação holística, tierizada e baseada em dados reais (Meta-Learning).
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
// Promise de inicialização para evitar corrida entre chamadas paralelas
let _initPromise: Promise<void> | null = null;

async function initMetaBenchmarks() {
  // Se já inicializado, retorna imediatamente (sem log)
  if (isMetaInitialized) return;
  // Se já está inicializando em paralelo, aguarda a mesma promise
  if (_initPromise) return _initPromise;
  
  _initPromise = (async () => {
    const initialized: string[] = [];
    for (const [archetype, decklists] of Object.entries(META_DECKS)) {
      const decks: any[][] = [];
      for (const dl of decklists) {
        const parsed = await (import("./metaAnalytics")).then(m => m.MetaAnalytics.parseDecklist(dl));
        if (parsed.length > 0) decks.push(parsed);
      }
      if (decks.length > 0) {
        metaAnalyzer.generateBenchmark(archetype, decks);
        initialized.push(`${archetype}(n=${decks.length})`);
      }
    }
    // Log ÚNICO de resumo — evita spam de centenas de linhas durante self-play
    // (antes: 1 linha por arquétipo × N chamadas paralelas = centenas de linhas)
    if (initialized.length > 0) {
      console.log(`[BRAIN] Meta-Benchmarks: ${initialized.join(", ")}`);
    }
    isMetaInitialized = true;
  })();
  
  return _initPromise;
}

// ─── Tipos ────────────────────────────────────────────────────────────────────

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
  winrate?: number; // Métrica de Winrate Estimado vs Meta
}

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

// ─── Helpers ──────────────────────────────────────────────────────────────────

function normalizeScore(score: number, min: number = -50, max: number = 180): number {
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

// ─── Avaliação ────────────────────────────────────────────────────────────────

export async function evaluateDeckWithBrain(
  cards: any[],
  archetype: string = "default"
): Promise<EvaluationResult> {
  await initMetaBenchmarks();

  const metrics = calculateDeckMetrics(cards, archetype);
  const profile = ARCHETYPE_PROFILES[archetype] || ARCHETYPE_PROFILES.default;
  const benchmark = metaAnalyzer.getBenchmark(archetype);

  // 0. DB Synergy Score — amostra até 10 pares reais da tabela cardSynergies
  // Fecha o loop: a avaliação agora reflete sinergias aprendidas pelo self-play
  let dbSynergyBonus = 0;
  let avgPairSynergy = 0;
  try {
    const { getCardSynergy } = await import("./synergy");
    const nonLandWithIds = cards
      .filter((c: any) => c.id && !c.type?.toLowerCase().includes("land"))
      .slice(0, 10); // máx 10 cartas = máx 45 pares
    const uniqueIds = Array.from(new Set(nonLandWithIds.map((c: any) => Number(c.id))));
    if (uniqueIds.length >= 2) {
      let totalSyn = 0;
      let pairCount = 0;
      for (let i = 0; i < uniqueIds.length; i++) {
        for (let j = i + 1; j < uniqueIds.length; j++) {
          totalSyn += await getCardSynergy(uniqueIds[i], uniqueIds[j]);
          pairCount++;
        }
      }
      if (pairCount > 0) {
        avgPairSynergy = totalSyn / pairCount; // 0–100
        dbSynergyBonus = (avgPairSynergy / 100) * 25; // até +25 pts no score final
      }
    }
  } catch { /* não-crítico */ }

  // 1. Meta-Learning Adjustment (Comparação estatística com decks pro)
  let benchmarkBonus = 0;
  if (benchmark) {
    // Curva: Comparar com a média pro
    for (const [cmcStr, avg] of Object.entries(benchmark.avgCurve)) {
      const actual = metrics.manaCurve[parseInt(cmcStr)] || 0;
      if (Math.abs(actual - avg) <= 1.5) benchmarkBonus += 8;
    }
    // Roles: Comparar com a estrutura pro
    for (const [role, avg] of Object.entries(benchmark.avgRoles)) {
      const actual = metrics.roleCounts[role] || 0;
      if (Math.abs(actual - avg) <= 2) benchmarkBonus += 12;
    }
  }

  // 2. Winrate Estimado (Simulação vs Oponentes Meta)
  const { ModelEvaluator } = await import("./modelEvaluation");
  const winrate = await ModelEvaluator.evaluateWinrate(cards, archetype, 10);

  const finalScore = metrics.totalScore + (benchmarkBonus * 1.5) + (winrate * 30) + dbSynergyBonus;
  const normalizedFinalScore = normalizeScore(finalScore, -50, 250);

  // 3. Análise Detalhada
  const strengths: string[] = [];
  const weaknesses: string[] = [];
  const suggestions: string[] = [];

  const removalCount = metrics.removalCount;
  const threatCount = metrics.roleCounts.threat || 0;

  if (removalCount >= profile.minRemovalCount) strengths.push("Remoção adequada para o meta");
  else {
    weaknesses.push("Remoção insuficiente");
    suggestions.push(`Adicione mais respostas para controlar o board (alvo: ${profile.minRemovalCount})`);
  }

  if (threatCount >= profile.minThreatCount) strengths.push("Densidade de ameaças sólida");
  else {
    weaknesses.push("Poucas ameaças para finalizar o jogo");
    suggestions.push(`Aumente o número de criaturas ou spells de impacto`);
  }

  if (benchmarkBonus > 15) strengths.push("Excelente alinhamento com arquétipos profissionais");
  if (winrate > 0.6) strengths.push(`Winrate simulado excepcional (${(winrate * 100).toFixed(0)}%)`);

  // Feedback de sinergia real (DB)
  if (avgPairSynergy > 40) {
    strengths.push(`Sinergia entre cartas forte — média de ${avgPairSynergy.toFixed(0)}/100 por par`);
  } else if (avgPairSynergy > 0 && avgPairSynergy <= 15) {
    weaknesses.push("Baixa sinergia entre as cartas — considere pares com histórico de co-ocorrência");
    suggestions.push("Adicione cartas que aparecem juntas em decks competitivos para aumentar a sinergia");
  }

  return {
    ...metrics,
    normalizedScore: normalizedFinalScore,
    tier: getTier(normalizedFinalScore),
    recommendations: suggestions,
    analysis: { strengths, weaknesses, suggestions },
    winrate,
  };
}

export function evaluateDeckQuick(cards: any[], archetype: string): number {
  const metrics = calculateDeckMetrics(cards, archetype);
  // Range ampliado [-50, 350]: mechanicSynergyScore pode chegar a 300+
  // para decks com muitas cartas do mesmo tema (ex: 60 cartas haste × 5 = 300).
  // Range estreito [-50, 180] saturava em 100 na iteração 10 do self-play,
  // eliminando pressão de seleção e causando plateau prematuro.
  return normalizeScore(metrics.totalScore, -50, 350);
}
