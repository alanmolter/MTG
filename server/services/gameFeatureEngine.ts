/**
 * Game Feature Engine
 *
 * Transforma cartas em features jogáveis para scoring e RL.
 * Abordagem: modelar padrões que fazem decks vencerem, não simular o jogo completo.
 */

// ─── Tipos ────────────────────────────────────────────────────────────────────

export interface CardFeatures {
  name: string;
  cmc: number;
  isCreature: boolean;
  isLand: boolean;
  isInstant: boolean;
  isSorcery: boolean;
  isEnchantment: boolean;
  isArtifact: boolean;
  isPlaneswalker: boolean;
  // Roles funcionais (nova abordagem)
  roles: string[];
  // Flags individuais (mantido para compatibilidade)
  isRemoval: boolean;
  isDraw: boolean;
  isRamp: boolean;
  isToken: boolean;
  isCounter: boolean;
  isSacrifice: boolean;
  isLifegain: boolean;
  isHaste: boolean;
  isFlying: boolean;
  isProtection: boolean;
  isCounterspell: boolean;
  isTutor: boolean;
  isDiscard: boolean;
  isGraveyard: boolean;
  // Tags mecânicas para sinergia
  mechanicTags: string[];
  // Peso de impacto estimado (0-10)
  impactScore: number;
}

export interface DeckMetrics {
  // Curva de mana
  manaCurve: Record<number, number>;
  manaCurveScore: number;
  // Composição
  landCount: number;
  landRatioScore: number;
  creatureCount: number;
  spellCount: number;
  // Roles funcionais
  removalCount: number;
  drawCount: number;
  rampCount: number;
  // Roles breakdown (nova métrica)
  roleCounts: Record<string, number>;
  // Estrutura do deck
  structureScore: number;
  structureWarnings: string[];
  // Sinergia por mecânica
  mechanicTagCounts: Record<string, number>;
  synergyScore: number;
  // Simulação de turnos
  simulationScore: number;
  simulationStats: SimulationStats | null;
  // Novas métricas
  consistencyScore: number;
  avgWinTurn: number;
  comboComplexity: number;
  // Score total composto
  totalScore: number;
  // Breakdown para UI
  breakdown: {
    curve: number;
    lands: number;
    synergy: number;
    simulation: number;
    consistency: number;
    speed: number;
    complexity: number;
    structure: number;
  };
}

// ─── Curva de mana ideal calibrada por arquétipo ──────────────────────────────

const IDEAL_CURVES: Record<string, Record<number, number>> = {
  aggro: { 1: 12, 2: 14, 3: 8, 4: 2, 5: 0 },
  burn: { 1: 16, 2: 12, 3: 6, 4: 2, 5: 0 },
  tempo: { 1: 8, 2: 14, 3: 10, 4: 4, 5: 0 },
  midrange: { 1: 4, 2: 10, 3: 12, 4: 8, 5: 4 },
  control: { 1: 2, 2: 8, 3: 10, 4: 8, 5: 6 },
  ramp: { 1: 2, 2: 8, 3: 8, 4: 4, 5: 8 },
  combo: { 1: 4, 2: 12, 3: 10, 4: 6, 5: 4 },
  default: { 1: 8, 2: 12, 3: 10, 4: 6, 5: 4 },
};

const IDEAL_LAND_COUNTS: Record<string, number> = {
  aggro: 20,
  burn: 20,
  tempo: 20,
  midrange: 24,
  control: 26,
  ramp: 22,
  combo: 22,
  default: 24,
};

// ─── Target de Roles por Arquétipo ──────────────────────────────────────────────

/**
 * Target de roles por arquétipo.
 * Define a estrutura ideal de um deck para cada arquétipo.
 */
const ARCHETYPE_ROLE_TARGETS: Record<string, Record<string, number>> = {
  aggro: {
    land: 20,
    threat: 24,
    removal: 4,
    card_draw: 2,
    tempo: 4,
    wincon: 0,
  },
  burn: {
    land: 20,
    threat: 6,
    removal: 8,
    card_draw: 4,
    tempo: 6,
    wincon: 0,
  },
  tempo: {
    land: 20,
    threat: 14,
    removal: 6,
    card_draw: 6,
    tempo: 8,
    wincon: 0,
  },
  midrange: {
    land: 24,
    threat: 18,
    removal: 8,
    card_draw: 4,
    engine: 4,
    wincon: 2,
  },
  control: {
    land: 26,
    threat: 4,
    removal: 10,
    card_draw: 8,
    tempo: 6,
    wincon: 4,
  },
  ramp: {
    land: 22,
    threat: 12,
    removal: 4,
    card_draw: 6,
    ramp: 8,
    engine: 4,
    wincon: 4,
  },
  combo: {
    land: 22,
    threat: 8,
    card_draw: 8,
    engine: 10,
    tutor: 4,
    wincon: 4,
  },
  default: {
    land: 24,
    threat: 14,
    removal: 6,
    card_draw: 4,
    engine: 2,
    wincon: 2,
  },
};

/**
 * Calcula o score estrutural do deck comparando com o target do arquétipo.
 * Retorna pontuação e warnings sobre problemas estruturais.
 */
function calculateStructureScore(
  features: CardFeatures[],
  archetype: string
): { score: number; warnings: string[] } {
  const target =
    ARCHETYPE_ROLE_TARGETS[archetype] || ARCHETYPE_ROLE_TARGETS.default;

  // Contar roles no deck
  const actualCounts: Record<string, number> = {};
  for (const f of features) {
    for (const role of f.roles) {
      actualCounts[role] = (actualCounts[role] || 0) + 1;
    }
  }

  let score = 0;
  const warnings: string[] = [];

  for (const [role, ideal] of Object.entries(target)) {
    const actual = actualCounts[role] || 0;
    const diff = actual - ideal;

    // Penalização por desvio
    score -= Math.abs(diff) * 0.5;

    // Warnings para problemas sérios
    if (role === "removal" && actual < ideal - 3) {
      warnings.push("Deck sem remoção suficiente");
    }
    if (
      role === "wincon" &&
      actual < 1 &&
      archetype !== "aggro" &&
      archetype !== "burn"
    ) {
      warnings.push("Deck sem condição de vitória clara");
    }
    if (role === "card_draw" && actual < 2) {
      warnings.push("Deck com poucas fontes de card draw");
    }
    if (role === "threat" && actual < 4 && archetype !== "control") {
      warnings.push("Deck com poucas ameaças");
    }
  }

  return { score: Math.max(-20, score), warnings };
}

// ─── Feature Extraction ───────────────────────────────────────────────────────

/**
 * Extrai roles funcionais de uma carta.
 * Cada carta pode ter múltiplos papéis que definem sua contribuição ao deck.
 */
export function getCardRoles(card: {
  name: string;
  type?: string | null;
  text?: string | null;
}): string[] {
  const text = (card.text || "").toLowerCase();
  const type = (card.type || "").toLowerCase();
  const roles: string[] = [];

  // Base type
  if (type.includes("land")) roles.push("land");
  if (type.includes("creature")) roles.push("threat");
  if (type.includes("planeswalker")) roles.push("wincon");
  if (type.includes("enchantment")) roles.push("enchantment");
  if (type.includes("artifact")) roles.push("artifact");

  // Removal
  if (
    text.includes("destroy") ||
    text.includes("exile") ||
    (text.includes("damage") && text.includes("target creature"))
  ) {
    roles.push("removal");
  }

  // Card Draw
  if (
    text.includes("draw a card") ||
    text.includes("draw cards") ||
    text.includes("draw two") ||
    text.includes("draw three")
  ) {
    roles.push("card_draw");
  }

  // Ramp
  if (
    text.includes("add {") ||
    text.includes("search your library for a") ||
    text.includes("put a land") ||
    text.includes("mana of any")
  ) {
    roles.push("ramp");
  }

  // Tempo (bounce, tap, tax)
  if (
    text.includes("return target") ||
    text.includes("tap target") ||
    text.includes("untap") ||
    text.includes("prevent")
  ) {
    roles.push("tempo");
  }

  // Win Condition
  if (
    text.includes("you win the game") ||
    text.includes("win the game") ||
    text.includes(" opponents lose the game")
  ) {
    roles.push("wincon");
  }

  // Engine / Combo Piece (triggers)
  if (
    text.includes("whenever") ||
    text.includes("at the beginning") ||
    text.includes("if you control")
  ) {
    roles.push("engine");
  }

  // Protection
  if (
    text.includes("protection from") ||
    text.includes("hexproof") ||
    text.includes("shroud")
  ) {
    roles.push("protection");
  }

  // Discard
  if (
    text.includes("discard") &&
    (text.includes("opponent") || text.includes("target player"))
  ) {
    roles.push("discard");
  }

  // Tutor
  if (text.includes("search your library") && !text.includes("basic land")) {
    roles.push("tutor");
  }

  // Fix para duplicatas e ordem consistente
  const uniqueRoles = new Set(roles);
  return Array.from(uniqueRoles);
}

/**
 * Extrai features jogáveis de uma carta a partir de seu texto e tipo.
 */
export function extractCardFeatures(card: {
  name: string;
  type?: string | null;
  text?: string | null;
  cmc?: number | null;
}): CardFeatures {
  const text = (card.text || "").toLowerCase();
  const type = (card.type || "").toLowerCase();
  const cmc = card.cmc ?? 0;

  // Roles funcionais (novo campo)
  const roles = getCardRoles(card);

  const isCreature = type.includes("creature");
  const isLand = type.includes("land");
  const isInstant = type.includes("instant");
  const isSorcery = type.includes("sorcery");
  const isEnchantment = type.includes("enchantment");
  const isArtifact = type.includes("artifact");
  const isPlaneswalker = type.includes("planeswalker");

  // Roles funcionais
  const isRemoval =
    text.includes("destroy") ||
    text.includes("exile") ||
    text.includes("deals") ||
    (text.includes("damage") && (isInstant || isSorcery));

  const isDraw =
    text.includes("draw a card") ||
    text.includes("draw cards") ||
    text.includes("draw two") ||
    text.includes("draw three");

  const isRamp =
    text.includes("add {") ||
    text.includes("search your library for a") ||
    text.includes("put a land") ||
    text.includes("basic land") ||
    text.includes("mana of any");

  const isToken =
    (text.includes("create") && text.includes("token")) ||
    text.includes("put a 1/1") ||
    text.includes("put a 2/2");

  const isCounter =
    text.includes("+1/+1 counter") ||
    text.includes("proliferate") ||
    text.includes("put a counter");

  const isSacrifice =
    text.includes("sacrifice a") ||
    text.includes("sacrifice another") ||
    text.includes("sacrifice target");

  const isLifegain =
    (text.includes("gain") && text.includes("life")) ||
    text.includes("lifelink");

  const isHaste = text.includes("haste");
  const isFlying = text.includes("flying");
  const isProtection =
    text.includes("protection from") ||
    text.includes("hexproof") ||
    text.includes("shroud");
  const isCounterspell =
    (isInstant || isSorcery) && text.includes("counter target");
  const isTutor = text.includes("search your library") && !isRamp;
  const isDiscard = text.includes("discard") && text.includes("opponent");
  const isGraveyard =
    text.includes("from your graveyard") ||
    text.includes("flashback") ||
    text.includes("escape") ||
    text.includes("delve");

  // Win condition (planeswalker ou texto)
  const isWincon = isPlaneswalker || text.includes("you win the game");

  // Engine (triggers)
  const isEngine =
    text.includes("whenever") ||
    text.includes("at the beginning") ||
    text.includes("if you control");

  // Tags mecânicas para sinergia
  const mechanicTags: string[] = [];
  if (isToken) mechanicTags.push("token");
  if (isSacrifice) mechanicTags.push("sacrifice");
  if (isDraw) mechanicTags.push("draw");
  if (isCounter) mechanicTags.push("counter");
  if (isRamp) mechanicTags.push("ramp");
  if (isRemoval) mechanicTags.push("removal");
  if (isLifegain) mechanicTags.push("lifegain");
  if (isGraveyard) mechanicTags.push("graveyard");
  if (isDiscard) mechanicTags.push("discard");
  if (isCounterspell) mechanicTags.push("counterspell");
  if (isTutor) mechanicTags.push("tutor");
  if (isWincon) mechanicTags.push("wincon");
  if (isEngine) mechanicTags.push("engine");
  if (text.includes("trample")) mechanicTags.push("trample");
  if (text.includes("deathtouch")) mechanicTags.push("deathtouch");
  if (text.includes("vigilance")) mechanicTags.push("vigilance");
  if (text.includes("flash")) mechanicTags.push("flash");

  // Impacto estimado (heurística)
  let impactScore = 0;
  if (isRemoval) impactScore += 2;
  if (isDraw) impactScore += 2;
  if (isRamp) impactScore += 1.5;
  if (isCounterspell) impactScore += 2;
  if (isTutor) impactScore += 2;
  if (isToken) impactScore += 1;
  if (isCounter) impactScore += 1;
  if (isCreature && cmc <= 2) impactScore += 1.5; // early threats
  if (isPlaneswalker) impactScore += 2.5;
  impactScore = Math.min(10, impactScore);

  return {
    name: card.name,
    cmc,
    isCreature,
    isLand,
    isInstant,
    isSorcery,
    isEnchantment,
    isArtifact,
    isPlaneswalker,
    roles,
    isRemoval,
    isDraw,
    isRamp,
    isToken,
    isCounter,
    isSacrifice,
    isLifegain,
    isHaste,
    isFlying,
    isProtection,
    isCounterspell,
    isTutor,
    isDiscard,
    isGraveyard,
    mechanicTags,
    impactScore,
  };
}

// ─── Scoring Functions ────────────────────────────────────────────────────────

/**
 * Score de curva de mana com pesos baseados em roles e tipo de carta.
 * Criaturas early game têm peso maior, spells de late game têm peso menor.
 */
export function manaCurveScore(
  features: CardFeatures[],
  archetype: string = "default"
): { score: number; curve: Record<number, number> } {
  // Curva ponderada por papel da carta
  const weightedCurve: Record<number, number> = {};
  const rawCurve: Record<number, number> = {};

  for (const f of features) {
    if (f.isLand) continue;
    const cmc = Math.min(f.cmc, 7); // agrupar 7+

    // Raw count
    rawCurve[cmc] = (rawCurve[cmc] || 0) + 1;

    // Peso baseado no papel
    let weight = 1.0;

    // Criaturas/ameaças contam mais no early game (CMC 1-3)
    if (f.roles.includes("threat") && cmc <= 3) {
      weight = 1.5;
    }

    // Cards de late game (CMC >= 5) têm peso reduzido
    if (cmc >= 5) {
      weight = 0.7;
    }

    // Engines e tutors são valiosos em todos os pontos
    if (f.roles.includes("engine") || f.roles.includes("tutor")) {
      weight = 1.2;
    }

    // Wincons de custo alto são importantes
    if (f.roles.includes("wincon") && cmc >= 4) {
      weight = 1.3;
    }

    weightedCurve[cmc] = (weightedCurve[cmc] || 0) + weight;
  }

  // Curva ideal com pesos também
  const idealCurveRaw =
    IDEAL_CURVES[archetype.toLowerCase()] || IDEAL_CURVES.default;

  // Converter ideal curve para pesos similares
  const idealCurve: Record<number, number> = {};
  for (const [cost, count] of Object.entries(idealCurveRaw)) {
    const cmc = parseInt(cost);
    let weight = 1.0;
    if (cmc <= 3) weight = 1.3;
    if (cmc >= 5) weight = 0.7;
    idealCurve[cmc] = count * weight;
  }

  let score = 0;

  // Comparar curva ponderada com ideal
  for (const [cost, ideal] of Object.entries(idealCurve)) {
    const actual = weightedCurve[parseInt(cost)] || 0;
    score -= Math.abs(actual - ideal) * 2;
  }

  // Bônus por ter cartas em todos os CMCs 1-3 (early game coverage)
  if (rawCurve[1] && rawCurve[2] && rawCurve[3]) score += 5;

  // Bônus extra para curve bem distribuída (não muito weight em um único CMC)
  const maxWeight = Math.max(...Object.values(weightedCurve), 1);
  const totalWeight = Object.values(weightedCurve).reduce((a, b) => a + b, 0);
  const distributionRatio = maxWeight / totalWeight;
  if (distributionRatio < 0.4) score += 3; // bem distribuída

  return { score, curve: rawCurve };
}

/**
 * Score de proporção de terrenos — penaliza decks com terrenos demais ou de menos.
 */
export function landRatioScore(
  features: CardFeatures[],
  archetype: string = "default"
): number {
  const lands = features.filter(f => f.isLand).length;
  const idealLands =
    IDEAL_LAND_COUNTS[archetype.toLowerCase()] || IDEAL_LAND_COUNTS.default;
  return -Math.abs(lands - idealLands) * 2;
}

/**
 * Regras específicas de sinergia entre tags.
 * Define combinações poderosas de mecânicas.
 */
const SYNERGY_RULES: Record<string, number> = {
  "token-sacrifice": 5,
  "sacrifice-token": 5,
  "graveyard-graveyard": 3,
  "counters-proliferate": 6,
  "proliferate-counters": 6,
  "draw-card_draw": 2,
  "card_draw-draw": 2,
  "removal-threat": 3,
  "threat-removal": 3,
  "ramp-ramp": 2,
  "engine-engine": 2,
  "tutor-engine": 4,
  "engine-tutor": 4,
  "lifegain-lifegain": 3,
  "wincon-threat": 2,
  "threat-wincon": 2,
};

/**
 * Score de sinergia profissional com análise de pares e regras específicas.
 */
export function mechanicSynergyScore(features: CardFeatures[]): {
  score: number;
  tagCounts: Record<string, number>;
  synergyPairs: string[];
} {
  const tagCounts: Record<string, number> = {};
  const cardTags: string[][] = [];

  // Extrair tags por carta
  for (const f of features) {
    const tags = [...f.mechanicTags];
    cardTags.push(tags);
    for (const tag of tags) {
      tagCounts[tag] = (tagCounts[tag] || 0) + 1;
    }
  }

  let score = 0;
  const foundSynergies: string[] = [];

  // Análise de pares: verificar todas as combinações de cartas
  for (let i = 0; i < cardTags.length; i++) {
    for (let j = i + 1; j < cardTags.length; j++) {
      const tags1 = new Set(cardTags[i]);
      const tags2 = new Set(cardTags[j]);

      // Overlap básico (mesma tag em ambas)
      const overlap = Array.from(tags1).filter(t => tags2.has(t));
      score += overlap.length * 1.5;

      // Verificar regras específicas de sinergia
      for (const t1 of Array.from(tags1)) {
        for (const t2 of Array.from(tags2)) {
          const key = `${t1}-${t2}`;
          if (SYNERGY_RULES[key]) {
            score += SYNERGY_RULES[key];
            foundSynergies.push(`${t1} + ${t2}`);
          }
        }
      }
    }
  }

  // Bônus por quantidade de tags (stacking)
  for (const [tag, count] of Object.entries(tagCounts)) {
    if (count >= 3) {
      score += Math.pow(count, 1.2); // reward stacking
    }
  }

  // Bônus por ter remoção + criaturas (deck funcional)
  if (tagCounts.removal && tagCounts.removal >= 4) score += 10;
  if (tagCounts.draw && tagCounts.draw >= 2) score += 8;

  // Bônus por ter engine + tutor (combo)
  if ((tagCounts.engine || 0) >= 2 && (tagCounts.tutor || 0) >= 1) score += 15;

  // Bônus por token + sacrifice (go-wide)
  if ((tagCounts.token || 0) >= 2 && (tagCounts.sacrifice || 0) >= 1)
    score += 12;

  return {
    score,
    tagCounts,
    synergyPairs: Array.from(new Set(foundSynergies)),
  };
}

/**
 * Simulação de turnos 1-7 com análise avançada.
 * Detecta: flood, screw, curva ruim, mãos travadas, win condition alcançada.
 */
export function simulateTurns(
  features: CardFeatures[],
  iterations: number = 30
): { score: number; stats: SimulationStats } {
  let totalScore = 0;
  let screwCount = 0;
  let floodCount = 0;
  let winsDetected = 0;
  let avgManaUsed = 0;

  const nonLands = features.filter(f => !f.isLand);
  const lands = features.filter(f => f.isLand);

  for (let iter = 0; iter < iterations; iter++) {
    // Embaralhar deck
    const deck = shuffle([...nonLands, ...lands]);
    const hand = deck.splice(0, 7);

    let mana = 0;
    let score = 0;
    let landsPlayed = 0;
    let manaWasted = 0;
    let cardsPlayed = 0;

    for (let turn = 1; turn <= 7; turn++) {
      // Comprar carta
      if (deck.length > 0) hand.push(deck.splice(0, 1)[0]);

      // Adicionar mana (1 por turno + land plays)
      mana += 1;

      // Jogar terreno se tiver na mão e precisar
      const landInHand = hand.findIndex(c => c.isLand);
      if (landInHand >= 0 && landsPlayed < turn + 1) {
        hand.splice(landInHand, 1);
        landsPlayed++;
      }

      // Detectar land screw (sem land play em turnos anteriores)
      if (turn > 2 && landsPlayed < turn - 1) {
        screwCount++;
        score -= 3;
      }

      // Jogar a melhor carta possível (preferir lowest CMC = mais eficiente)
      const playable = hand.filter(c => !c.isLand && c.cmc <= mana);

      if (playable.length > 0) {
        // Ordenar por: impact score primeiro, depois lowest CMC
        playable.sort((a, b) => {
          if (b.impactScore !== a.impactScore)
            return b.impactScore - a.impactScore;
          return a.cmc - b.cmc;
        });

        const best = playable[0];
        const baseScore = best.cmc <= 2 ? 3 : best.cmc <= 4 ? 2 : 1;
        score += baseScore + best.impactScore * 0.5;
        hand.splice(hand.indexOf(best), 1);
        cardsPlayed++;

        // Detectar win condition jogada
        if (best.roles.includes("wincon")) {
          winsDetected++;
          score += 10;
        }
      } else if (mana > 0 && hand.filter(c => !c.isLand).length > 0) {
        // Travou (tem mana mas não consegue jogar)
        score -= 2;
        manaWasted += mana;
      }

      // Penalidade por flood (muitos terrenos na mão)
      const landsInHand = hand.filter(c => c.isLand).length;
      if (landsInHand >= 4) {
        floodCount++;
        score -= 2;
      }
    }

    totalScore += score;
    avgManaUsed += manaWasted;
  }

  return {
    score: totalScore / iterations,
    stats: {
      screwRate: screwCount / iterations,
      floodRate: floodCount / iterations,
      winRate: winsDetected / iterations,
      avgWastedMana: avgManaUsed / iterations,
    },
  };
}

interface SimulationStats {
  screwRate: number;
  floodRate: number;
  winRate: number;
  avgWastedMana: number;
}

/**
 * Calcula score de consistência do deck.
 * Fatores: proporção de baixa curva, terraration adequada, quantidade de draw.
 */
function calculateConsistencyScore(features: CardFeatures[]): number {
  const totalCards = features.length;
  if (totalCards === 0) return 0;

  // LowCMC ratio (cartas com CMC <= 2)
  const lowCmcCount = features.filter(f => f.cmc <= 2).length;
  const lowCmcRatio = lowCmcCount / totalCards;

  // Land ratio ideal
  const landCount = features.filter(f => f.isLand).length;
  const landRatio = landCount / totalCards;
  const landScore = landRatio >= 0.2 && landRatio <= 0.3 ? 10 : 5;

  // Draw count
  const drawCount = features.filter(f => f.isDraw).length;
  const drawScore = Math.min(drawCount, 6) * 1.5;

  // Consistência: boa se tem muitos lowCMC, lands adequadas e draw
  const consistencyScore = lowCmcRatio * 15 + landScore + drawScore;

  return Math.max(0, Math.min(30, consistencyScore));
}

/**
 * Estima turno médio de vitória baseado na curva do deck.
 */
function calculateAvgWinTurn(
  features: CardFeatures[],
  archetype: string
): number {
  const nonLands = features.filter(f => !f.isLand);
  if (nonLands.length === 0) return 6;

  // Turno médio de vitória baseado no CMC médio
  const avgCmc = nonLands.reduce((sum, f) => sum + f.cmc, 0) / nonLands.length;

  // Turno base por arquétipo
  const baseTurnByArchetype: Record<string, number> = {
    aggro: 4,
    burn: 5,
    tempo: 5,
    midrange: 6,
    control: 8,
    ramp: 6,
    combo: 4,
    default: 5,
  };

  const baseTurn = baseTurnByArchetype[archetype] || 5;

  // Ajustar pelo CMC médio
  const cmcAdjustment = avgCmc - 2; // média base
  const winTurn = Math.max(3, Math.min(10, baseTurn + cmcAdjustment));

  return Math.round(winTurn * 10) / 10;
}

/**
 * Calcula complexidade do deck (combo potential + mecânicas interagindo).
 */
function calculateComboComplexity(features: CardFeatures[]): number {
  const totalCards = features.length;
  if (totalCards === 0) return 0;

  // Count de mecânicas únicas
  const allTags = features.flatMap(f => f.mechanicTags);
  const uniqueTags = new Set(allTags);
  const tagDiversity = uniqueTags.size;

  // Count de cards com múltiplas funcionalidades
  const multiRoleCount = features.filter(f => {
    let roles = 0;
    if (f.isRemoval) roles++;
    if (f.isDraw) roles++;
    if (f.isRamp) roles++;
    if (f.isToken) roles++;
    return roles >= 2;
  }).length;

  // Count de tutors
  const tutorCount = features.filter(f => f.isTutor).length;

  // Complexity: mais tags + mais multi-role + tutors = mais complexo
  const complexityScore =
    tagDiversity * 0.8 + multiRoleCount * 0.5 + tutorCount * 2;

  return Math.max(0, Math.min(20, complexityScore));
}

/**
 * Função principal de avaliação de deck — combina todos os scores.
 */
export function evaluateDeck(
  cards: {
    name: string;
    type?: string | null;
    text?: string | null;
    cmc?: number | null;
  }[],
  archetype: string = "default"
): DeckMetrics {
  const features = cards.map(extractCardFeatures);

  const { score: curveScore, curve } = manaCurveScore(features, archetype);
  const landScore = landRatioScore(features, archetype);
  const { score: synergyScore, tagCounts } = mechanicSynergyScore(features);
  const { score: simScore, stats: simStats } = simulateTurns(features);

  // Novas métricas
  const consistencyScore = calculateConsistencyScore(features);
  const avgWinTurn = calculateAvgWinTurn(features, archetype);
  const comboComplexity = calculateComboComplexity(features);
  const { score: structureScore, warnings: structureWarnings } =
    calculateStructureScore(features, archetype);

  const totalScore =
    curveScore +
    landScore +
    synergyScore +
    simScore +
    consistencyScore +
    comboComplexity * 0.5 +
    structureScore;

  // Role counts
  const roleCounts: Record<string, number> = {};
  for (const f of features) {
    for (const role of f.roles) {
      roleCounts[role] = (roleCounts[role] || 0) + 1;
    }
  }

  return {
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
    structureScore,
    structureWarnings,
    mechanicTagCounts: tagCounts,
    synergyScore,
    simulationScore: simScore,
    simulationStats: simStats,
    consistencyScore,
    avgWinTurn,
    comboComplexity,
    totalScore,
    breakdown: {
      curve: curveScore,
      lands: landScore,
      synergy: synergyScore,
      simulation: simScore,
      consistency: consistencyScore,
      speed: Math.max(0, 30 - avgWinTurn * 3),
      complexity: comboComplexity * 2,
      structure: structureScore + 10, // normalizar para 0-20
    },
  };
}

/**
 * RL melhorado: hill-climbing com mutações guiadas por features.
 * Substitui cartas de baixo impacto por cartas do pool com melhor sinergia.
 */
export function optimizeDeckRL(
  initialDeck: {
    name: string;
    type?: string | null;
    text?: string | null;
    cmc?: number | null;
    quantity?: number;
  }[],
  cardPool: {
    name: string;
    type?: string | null;
    text?: string | null;
    cmc?: number | null;
  }[],
  archetype: string = "default",
  iterations: number = 200
): {
  deck: typeof initialDeck;
  initialScore: number;
  finalScore: number;
  improvements: number;
} {
  // Expandir deck com quantidades
  let bestDeck = expandDeck(initialDeck);
  let bestScore = evaluateDeck(bestDeck, archetype).totalScore;
  const initialScore = bestScore;
  let improvements = 0;

  const nonLandPool = cardPool.filter(
    c => !(c.type || "").toLowerCase().includes("land")
  );

  for (let i = 0; i < iterations; i++) {
    const candidate = mutateDeck(bestDeck, nonLandPool, archetype);
    const score = evaluateDeck(candidate, archetype).totalScore;

    if (score > bestScore) {
      bestDeck = candidate;
      bestScore = score;
      improvements++;
    }
  }

  // Recolapsar deck expandido de volta para lista com quantidades
  return {
    deck: collapseDeck(bestDeck, initialDeck),
    initialScore,
    finalScore: bestScore,
    improvements,
  };
}

// ─── Helpers internos ─────────────────────────────────────────────────────────

function expandDeck(
  deck: {
    name: string;
    type?: string | null;
    text?: string | null;
    cmc?: number | null;
    quantity?: number;
  }[]
) {
  const expanded: {
    name: string;
    type?: string | null;
    text?: string | null;
    cmc?: number | null;
  }[] = [];
  for (const card of deck) {
    const qty = card.quantity || 1;
    for (let i = 0; i < qty; i++) {
      expanded.push({
        name: card.name,
        type: card.type,
        text: card.text,
        cmc: card.cmc,
      });
    }
  }
  return expanded;
}

function collapseDeck(
  expanded: {
    name: string;
    type?: string | null;
    text?: string | null;
    cmc?: number | null;
  }[],
  original: {
    name: string;
    type?: string | null;
    text?: string | null;
    cmc?: number | null;
    quantity?: number;
  }[]
) {
  const counts: Record<string, number> = {};
  for (const c of expanded) counts[c.name] = (counts[c.name] || 0) + 1;

  return Object.entries(counts).map(([name, quantity]) => {
    const orig = original.find(o => o.name === name);
    return {
      name,
      quantity,
      type: orig?.type,
      text: orig?.text,
      cmc: orig?.cmc,
    };
  });
}

function mutateDeck(
  deck: {
    name: string;
    type?: string | null;
    text?: string | null;
    cmc?: number | null;
  }[],
  pool: {
    name: string;
    type?: string | null;
    text?: string | null;
    cmc?: number | null;
  }[],
  archetype: string
) {
  if (pool.length === 0) return deck;

  const candidate = [...deck];
  const features = candidate.map(extractCardFeatures);

  // Encontrar a carta de menor impacto (não-terra)
  const nonLandIndices = features
    .map((f, i) => ({ f, i }))
    .filter(({ f }) => !f.isLand)
    .sort((a, b) => a.f.impactScore - b.f.impactScore);

  if (nonLandIndices.length === 0) return candidate;

  // Remover a carta de menor impacto
  const removeIdx = nonLandIndices[0].i;
  candidate.splice(removeIdx, 1);

  // Adicionar uma carta aleatória do pool com preferência por sinergia
  const poolCard = selectFromPool(pool, features, archetype);
  candidate.push(poolCard);

  return candidate;
}

function selectFromPool(
  pool: {
    name: string;
    type?: string | null;
    text?: string | null;
    cmc?: number | null;
  }[],
  currentFeatures: CardFeatures[],
  archetype: string
) {
  // Calcular tags dominantes no deck atual
  const tagCounts: Record<string, number> = {};
  for (const f of currentFeatures) {
    for (const tag of f.mechanicTags) {
      tagCounts[tag] = (tagCounts[tag] || 0) + 1;
    }
  }

  const dominantTags = Object.entries(tagCounts)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 3)
    .map(([tag]) => tag);

  // Pontuar cartas do pool por compatibilidade
  const scored = pool.map(card => {
    const f = extractCardFeatures(card);
    let score = f.impactScore;

    // Bônus por tags compatíveis com o deck
    for (const tag of f.mechanicTags) {
      if (dominantTags.includes(tag)) score += 3;
    }

    // Bônus por CMC adequado ao arquétipo
    const idealCurve =
      IDEAL_CURVES[archetype.toLowerCase()] || IDEAL_CURVES.default;
    const cmcKey = Math.min(f.cmc, 5);
    if (idealCurve[cmcKey] && idealCurve[cmcKey] > 0) score += 1;

    return { card, score };
  });

  // Selecionar com probabilidade proporcional ao score (softmax simplificado)
  const totalScore = scored.reduce((s, { score }) => s + Math.max(0, score), 0);
  if (totalScore === 0) return pool[Math.floor(Math.random() * pool.length)];

  let rand = Math.random() * totalScore;
  for (const { card, score } of scored) {
    rand -= Math.max(0, score);
    if (rand <= 0) return card;
  }

  return pool[pool.length - 1];
}

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * Calibra curvas ideais com base nas médias reais dos decks importados.
 */
export function calibrateFromRealDecks(
  deckCards: { cmc: number; type: string; quantity: number }[][]
): { avgCurve: Record<number, number>; avgLands: number } {
  if (deckCards.length === 0) return { avgCurve: {}, avgLands: 24 };

  const curveSums: Record<number, number> = {};
  let totalLands = 0;

  for (const deck of deckCards) {
    let deckLands = 0;
    for (const card of deck) {
      if (card.type.toLowerCase().includes("land")) {
        deckLands += card.quantity;
      } else {
        const cmc = Math.min(card.cmc, 7);
        curveSums[cmc] = (curveSums[cmc] || 0) + card.quantity;
      }
    }
    totalLands += deckLands;
  }

  const n = deckCards.length;
  const avgCurve: Record<number, number> = {};
  for (const [cmc, total] of Object.entries(curveSums)) {
    avgCurve[parseInt(cmc)] = Math.round(total / n);
  }

  return { avgCurve, avgLands: Math.round(totalLands / n) };
}
