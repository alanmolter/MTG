/**
 * Deck Evaluation Brain (Cérebro de Avaliação de Decks)
 *
 * Função FINAL que integra todas as métricas de avaliação de decks.
 * Combina: structure_score, curve_score, synergy_score e simulate
 * para criar uma avaliação holística e inteligente de decks MTG.
 *
 * Esta é a função central que melhora a capacidade de criar decks
 * ao fornecer feedback quantitativo sobre qualidade estrutural.
 */

import {
  extractCardFeatures,
  manaCurveScore,
  landRatioScore,
  mechanicSynergyScore,
  simulateTurns,
  CardFeatures,
  DeckMetrics,
} from "./gameFeatureEngine";

// ─── Tipos Estendidos ─────────────────────────────────────────────────────────

export interface ArchetypeProfile {
  name: string;
  // Pesos de scoring (0-1)
  curveWeight: number;
  structureWeight: number;
  synergyWeight: number;
  simulationWeight: number;
  consistencyWeight: number;
  // Penalidades específicas
  minRemovalCount: number;
  minThreatCount: number;
  minDrawCount: number;
  maxLandCount: number;
  minLandCount: number;
}

export interface EvaluationResult extends DeckMetrics {
  // Scores normalizados (0-100)
  normalizedScore: number;
  // Recomendações de melhoria
  recommendations: string[];
  // Tier de qualidade
  tier: "S" | "A" | "B" | "C" | "D" | "F";
  // Análise detalhada
  analysis: {
    strengths: string[];
    weaknesses: string[];
    suggestions: string[];
  };
}

// ─── Perfis de Arquétipos com Pesos Otimizados ────────────────────────────────

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
    curveWeight: 0.3,
    structureWeight: 0.25,
    synergyWeight: 0.2,
    simulationWeight: 0.15,
    consistencyWeight: 0.1,
    minRemovalCount: 3,
    minThreatCount: 10,
    minDrawCount: 2,
    maxLandCount: 26,
    minLandCount: 20,
  },
};

// ─── Normalização de Scores ───────────────────────────────────────────────────

/**
 * Normaliza um score para escala 0-100.
 * Lida com valores negativos e outliers.
 */
function normalizeScore(score: number, min: number = -50, max: number = 50): number {
  const clamped = Math.max(min, Math.min(max, score));
  const normalized = ((clamped - min) / (max - min)) * 100;
  return Math.round(normalized);
}

/**
 * Determina o tier de qualidade baseado no score normalizado.
 */
function getTier(score: number): "S" | "A" | "B" | "C" | "D" | "F" {
  if (score >= 90) return "S";
  if (score >= 80) return "A";
  if (score >= 70) return "B";
  if (score >= 60) return "C";
  if (score >= 50) return "D";
  return "F";
}

// ─── Análise Estrutural Avançada ──────────────────────────────────────────────

/**
 * Realiza análise detalhada da estrutura do deck.
 */
function analyzeStructure(
  features: CardFeatures[],
  archetype: string
): { strengths: string[]; weaknesses: string[]; suggestions: string[] } {
  const profile = ARCHETYPE_PROFILES[archetype] || ARCHETYPE_PROFILES.default;
  const strengths: string[] = [];
  const weaknesses: string[] = [];
  const suggestions: string[] = [];

  const removalCount = features.filter(f => f.isRemoval).length;
  const threatCount = features.filter(f => f.roles.includes("threat")).length;
  const drawCount = features.filter(f => f.isDraw).length;
  const landCount = features.filter(f => f.isLand).length;
  const creatureCount = features.filter(f => f.isCreature).length;
  const spellCount = features.filter(f => !f.isLand && !f.isCreature).length;

  // Análise de Remoção
  if (removalCount >= profile.minRemovalCount + 2) {
    strengths.push(`Excelente remoção (${removalCount} cartas)`);
  } else if (removalCount >= profile.minRemovalCount) {
    strengths.push(`Remoção adequada (${removalCount} cartas)`);
  } else if (removalCount > 0) {
    weaknesses.push(`Remoção insuficiente (${removalCount} cartas)`);
    suggestions.push(
      `Adicione mais cartas de remoção para melhor controle (alvo: ${profile.minRemovalCount}+)`
    );
  }

  // Análise de Ameaças
  if (threatCount >= profile.minThreatCount + 3) {
    strengths.push(`Muitas ameaças (${threatCount} cartas)`);
  } else if (threatCount >= profile.minThreatCount) {
    strengths.push(`Ameaças adequadas (${threatCount} cartas)`);
  } else if (threatCount > 0) {
    weaknesses.push(`Poucas ameaças (${threatCount} cartas)`);
    suggestions.push(
      `Adicione mais criaturas/ameaças para pressão (alvo: ${profile.minThreatCount}+)`
    );
  }

  // Análise de Draw
  if (drawCount >= 6) {
    strengths.push(`Excelente card draw (${drawCount} fontes)`);
  } else if (drawCount >= profile.minDrawCount + 2) {
    strengths.push(`Bom card draw (${drawCount} fontes)`);
  } else if (drawCount >= profile.minDrawCount) {
    strengths.push(`Card draw adequado (${drawCount} fontes)`);
  } else if (drawCount > 0) {
    weaknesses.push(`Poucas fontes de card draw (${drawCount})`);
    suggestions.push(`Considere adicionar mais card draw para consistência`);
  } else if (archetype !== "aggro" && archetype !== "burn") {
    weaknesses.push("Sem fontes de card draw");
    suggestions.push("Adicione cartas que permitem comprar cartas");
  }

  // Análise de Terrenos
  if (landCount >= profile.minLandCount && landCount <= profile.maxLandCount) {
    strengths.push(`Proporção de terrenos ideal (${landCount})`);
  } else if (landCount < profile.minLandCount) {
    weaknesses.push(`Terrenos insuficientes (${landCount})`);
    suggestions.push(
      `Adicione mais terrenos para consistência de mana (alvo: ${profile.minLandCount}-${profile.maxLandCount})`
    );
  } else {
    weaknesses.push(`Muitos terrenos (${landCount})`);
    suggestions.push(
      `Remova alguns terrenos para mais cartas úteis (alvo: ${profile.minLandCount}-${profile.maxLandCount})`
    );
  }

  // Análise de Proporção Criatura/Spell
  const creatureRatio = creatureCount / (creatureCount + spellCount || 1);
  if (archetype === "aggro" && creatureRatio >= 0.6) {
    strengths.push("Excelente proporção criatura/spell para agressão");
  } else if (archetype === "control" && creatureRatio <= 0.2) {
    strengths.push("Proporção spell-heavy adequada para controle");
  } else if (creatureRatio >= 0.4 && creatureRatio <= 0.6) {
    strengths.push("Proporção criatura/spell equilibrada");
  }

  return { strengths, weaknesses, suggestions };
}

// ─── Função Principal: evaluate_deck (Cérebro) ─────────────────────────────────

/**
 * FUNÇÃO FINAL - O CÉREBRO DO SISTEMA
 *
 * Avalia um deck de forma holística, combinando:
 * - structure_score: Qualidade estrutural (roles, composição)
 * - curve_score: Qualidade da curva de mana
 * - synergy_score: Sinergia entre cartas
 * - simulate: Simulação de gameplay
 *
 * Retorna uma avaliação completa com score normalizado, tier e recomendações.
 */
export function evaluateDeck(
  cards: {
    name: string;
    type?: string | null;
    text?: string | null;
    cmc?: number | null;
  }[],
  archetype: string = "default"
): EvaluationResult {
  // Extrair features das cartas
  const features = cards.map(extractCardFeatures);

  // Obter perfil do arquétipo
  const profile = ARCHETYPE_PROFILES[archetype] || ARCHETYPE_PROFILES.default;

  // ─── Calcular Scores Individuais ──────────────────────────────────────────

  // 1. CURVE SCORE (Qualidade da curva de mana)
  const { score: curveScore, curve } = manaCurveScore(features, archetype);
  const normalizedCurveScore = normalizeScore(curveScore, -30, 30);

  // 2. STRUCTURE SCORE (Qualidade estrutural)
  const landScore = landRatioScore(features, archetype);
  const normalizedLandScore = normalizeScore(landScore, -20, 10);

  // 3. SYNERGY SCORE (Sinergia entre cartas)
  const { score: synergyScore, tagCounts } = mechanicSynergyScore(features);
  const normalizedSynergyScore = normalizeScore(synergyScore, 0, 100);

  // 4. SIMULATION SCORE (Simulação de gameplay)
  const { score: simScore, stats: simStats } = simulateTurns(features);
  const normalizedSimScore = normalizeScore(simScore, -20, 50);

  // ─── Calcular Scores Adicionais ───────────────────────────────────────────

  // Consistência
  const lowCmcRatio = features.filter(f => f.cmc <= 2).length / features.length;
  const consistencyScore = lowCmcRatio * 20 + normalizedLandScore * 0.5;
  const normalizedConsistencyScore = normalizeScore(consistencyScore, 0, 30);

  // Análise Estrutural
  const { strengths, weaknesses, suggestions } = analyzeStructure(
    features,
    archetype
  );

  // ─── Calcular Score Total Ponderado ───────────────────────────────────────

  const weightedScore =
    normalizedCurveScore * profile.curveWeight +
    normalizedLandScore * profile.structureWeight +
    normalizedSynergyScore * profile.synergyWeight +
    normalizedSimScore * profile.simulationWeight +
    normalizedConsistencyScore * profile.consistencyWeight;

  // Aplicar ajustes por qualidade estrutural
  let finalScore = weightedScore;

  // Penalidade por falta de remoção
  const removalCount = features.filter(f => f.isRemoval).length;
  if (removalCount < profile.minRemovalCount && archetype !== "aggro") {
    finalScore -= 10;
  }

  // Penalidade por falta de ameaças
  const threatCount = features.filter(f => f.roles.includes("threat")).length;
  if (threatCount < profile.minThreatCount && archetype !== "control") {
    finalScore -= 8;
  }

  // Bônus por sinergia forte
  if (normalizedSynergyScore >= 80) {
    finalScore += 5;
  }

  // Normalizar score final para 0-100
  const normalizedFinalScore = Math.max(0, Math.min(100, finalScore));

  // ─── Gerar Recomendações ─────────────────────────────────────────────────

  const recommendations: string[] = [];

  if (normalizedCurveScore < 60) {
    recommendations.push("Melhore a curva de mana com mais cartas de baixo custo");
  }

  if (normalizedSynergyScore < 50) {
    recommendations.push(
      "Adicione cartas com melhor sinergia e mecânicas complementares"
    );
  }

  if (simStats && simStats.screwRate > 0.3) {
    recommendations.push(
      "Deck sofre com mana screw; considere adicionar mais terrenos ou ramp"
    );
  }

  if (simStats && simStats.floodRate > 0.3) {
    recommendations.push(
      "Deck sofre com mana flood; considere reduzir terrenos ou adicionar mais spells"
    );
  }

  if (weaknesses.length > 0) {
    recommendations.push(...suggestions);
  }

  // Role counts
  const roleCounts: Record<string, number> = {};
  for (const f of features) {
    for (const role of f.roles) {
      roleCounts[role] = (roleCounts[role] || 0) + 1;
    }
  }

  // ─── Construir Resultado Final ────────────────────────────────────────────

  return {
    // Métricas base
    manaCurve: curve,
    manaCurveScore: curveScore,
    landCount: features.filter(f => f.isLand).length,
    landRatioScore: landScore,
    creatureCount: features.filter(f => f.isCreature).length,
    spellCount: features.filter(f => !f.isLand && !f.isCreature).length,
    removalCount: features.filter(f => f.isRemoval).length,
    drawCount: features.filter(f => f.isDraw).length,
    rampCount: features.filter(f => f.isRamp).length,
    roleCounts,
    structureScore: normalizedLandScore,
    structureWarnings: weaknesses,
    mechanicTagCounts: tagCounts,
    synergyScore,
    simulationScore: simScore,
    simulationStats: simStats,
    consistencyScore: normalizedConsistencyScore,
    avgWinTurn: 5, // placeholder
    comboComplexity: 0, // placeholder
    totalScore: normalizedFinalScore,

    // Breakdown normalizado
    breakdown: {
      curve: normalizedCurveScore,
      lands: normalizedLandScore,
      synergy: normalizedSynergyScore,
      simulation: normalizedSimScore,
      consistency: normalizedConsistencyScore,
      speed: Math.max(0, 100 - simStats?.avgWastedMana * 10),
      complexity: 0, // placeholder
      structure: normalizedLandScore + 10,
    },

    // Novos campos de resultado
    normalizedScore: normalizedFinalScore,
    recommendations,
    tier: getTier(normalizedFinalScore),
    analysis: {
      strengths,
      weaknesses,
      suggestions,
    },
  };
}

/**
 * Versão simplificada para avaliação rápida (sem análise detalhada).
 * Útil para loops de otimização que precisam de velocidade.
 */
export function evaluateDeckQuick(
  cards: {
    name: string;
    type?: string | null;
    text?: string | null;
    cmc?: number | null;
  }[],
  archetype: string = "default"
): number {
  const features = cards.map(extractCardFeatures);

  const { score: curveScore } = manaCurveScore(features, archetype);
  const landScore = landRatioScore(features, archetype);
  const { score: synergyScore } = mechanicSynergyScore(features);
  const { score: simScore } = simulateTurns(features, 10); // menos iterações

  const profile = ARCHETYPE_PROFILES[archetype] || ARCHETYPE_PROFILES.default;

  const normalizedCurve = normalizeScore(curveScore, -30, 30);
  const normalizedLand = normalizeScore(landScore, -20, 10);
  const normalizedSynergy = normalizeScore(synergyScore, 0, 100);
  const normalizedSim = normalizeScore(simScore, -20, 50);

  return (
    normalizedCurve * profile.curveWeight +
    normalizedLand * profile.structureWeight +
    normalizedSynergy * profile.synergyWeight +
    normalizedSim * profile.simulationWeight
  );
}

/**
 * Compara dois decks e retorna qual é melhor.
 */
export function compareDeckQuality(
  deckA: { name: string; type?: string | null; text?: string | null; cmc?: number | null }[],
  deckB: { name: string; type?: string | null; text?: string | null; cmc?: number | null }[],
  archetype: string = "default"
): {
  winner: "A" | "B" | "tie";
  scoreA: number;
  scoreB: number;
  difference: number;
} {
  const scoreA = evaluateDeckQuick(deckA, archetype);
  const scoreB = evaluateDeckQuick(deckB, archetype);
  const difference = Math.abs(scoreA - scoreB);

  return {
    winner: scoreA > scoreB ? "A" : scoreB > scoreA ? "B" : "tie",
    scoreA,
    scoreB,
    difference,
  };
}
