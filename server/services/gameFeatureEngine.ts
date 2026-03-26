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
  // Roles funcionais
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
  // Sinergia por mecânica
  mechanicTagCounts: Record<string, number>;
  synergyScore: number;
  // Simulação de turnos
  simulationScore: number;
  // Score total composto
  totalScore: number;
  // Breakdown para UI
  breakdown: {
    curve: number;
    lands: number;
    synergy: number;
    simulation: number;
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

// ─── Feature Extraction ───────────────────────────────────────────────────────

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
  const isProtection = text.includes("protection from") || text.includes("hexproof") || text.includes("shroud");
  const isCounterspell = (isInstant || isSorcery) && text.includes("counter target");
  const isTutor = text.includes("search your library") && !isRamp;
  const isDiscard = text.includes("discard") && text.includes("opponent");
  const isGraveyard =
    text.includes("from your graveyard") ||
    text.includes("flashback") ||
    text.includes("escape") ||
    text.includes("delve");

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
 * Score de curva de mana — penaliza desvios da curva ideal para o arquétipo.
 */
export function manaCurveScore(
  features: CardFeatures[],
  archetype: string = "default"
): { score: number; curve: Record<number, number> } {
  const curve: Record<number, number> = {};

  for (const f of features) {
    if (f.isLand) continue;
    const cmc = Math.min(f.cmc, 7); // agrupar 7+
    curve[cmc] = (curve[cmc] || 0) + 1;
  }

  const idealCurve = IDEAL_CURVES[archetype.toLowerCase()] || IDEAL_CURVES.default;
  let score = 0;

  for (const [cost, ideal] of Object.entries(idealCurve)) {
    const actual = curve[parseInt(cost)] || 0;
    score -= Math.abs(actual - ideal) * 2; // penalidade por desvio
  }

  // Bônus por ter cartas em todos os CMCs 1-3
  if (curve[1] && curve[2] && curve[3]) score += 5;

  return { score, curve };
}

/**
 * Score de proporção de terrenos — penaliza decks com terrenos demais ou de menos.
 */
export function landRatioScore(features: CardFeatures[], archetype: string = "default"): number {
  const lands = features.filter((f) => f.isLand).length;
  const idealLands = IDEAL_LAND_COUNTS[archetype.toLowerCase()] || IDEAL_LAND_COUNTS.default;
  return -Math.abs(lands - idealLands) * 2;
}

/**
 * Score de sinergia por mecânica — recompensa stacking de tags compatíveis.
 */
export function mechanicSynergyScore(features: CardFeatures[]): {
  score: number;
  tagCounts: Record<string, number>;
} {
  const tagCounts: Record<string, number> = {};

  for (const f of features) {
    for (const tag of f.mechanicTags) {
      tagCounts[tag] = (tagCounts[tag] || 0) + 1;
    }
  }

  let score = 0;
  for (const count of Object.values(tagCounts)) {
    score += Math.pow(count, 1.5); // recompensa stacks (ex: 4 tokens = 4^1.5 = 8)
  }

  // Bônus por ter remoção + criaturas (deck funcional)
  if (tagCounts.removal && tagCounts.removal >= 4) score += 10;
  if (tagCounts.draw && tagCounts.draw >= 2) score += 8;

  return { score, tagCounts };
}

/**
 * Simulação simplificada de turnos 1-6.
 * Detecta: flood, screw, curva ruim, mão travada.
 */
export function simulateTurns(features: CardFeatures[], iterations: number = 20): number {
  let totalScore = 0;

  const nonLands = features.filter((f) => !f.isLand);
  const lands = features.filter((f) => f.isLand);

  for (let iter = 0; iter < iterations; iter++) {
    // Embaralhar deck
    const deck = shuffle([...nonLands, ...lands]);
    const hand = deck.splice(0, 7);

    let mana = 0;
    let score = 0;
    let landsPlayed = 0;

    for (let turn = 1; turn <= 6; turn++) {
      // Comprar carta
      if (deck.length > 0) hand.push(deck.splice(0, 1)[0]);

      // Jogar terreno se tiver na mão
      const landInHand = hand.findIndex((c) => c.isLand);
      if (landInHand >= 0) {
        hand.splice(landInHand, 1);
        mana++;
        landsPlayed++;
      } else if (landsPlayed < turn) {
        score -= 2; // land screw
      }

      // Jogar a melhor carta possível
      const playable = hand
        .filter((c) => !c.isLand && c.cmc <= mana)
        .sort((a, b) => b.cmc - a.cmc); // preferir cartas de maior custo

      if (playable.length > 0) {
        const best = playable[0];
        score += 2 + best.impactScore * 0.5; // recompensa por jogar + impacto
        hand.splice(hand.indexOf(best), 1);
      } else if (mana > 0 && hand.filter((c) => !c.isLand).length > 0) {
        score -= 1; // travou (tem mana mas não consegue jogar)
      }

      // Penalidade por flood (muitos terrenos na mão)
      const landsInHand = hand.filter((c) => c.isLand).length;
      if (landsInHand >= 4) score -= 2;
    }

    totalScore += score;
  }

  return totalScore / iterations;
}

/**
 * Função principal de avaliação de deck — combina todos os scores.
 */
export function evaluateDeck(
  cards: { name: string; type?: string | null; text?: string | null; cmc?: number | null }[],
  archetype: string = "default"
): DeckMetrics {
  const features = cards.map(extractCardFeatures);

  const { score: curveScore, curve } = manaCurveScore(features, archetype);
  const landScore = landRatioScore(features, archetype);
  const { score: synergyScore, tagCounts } = mechanicSynergyScore(features);
  const simScore = simulateTurns(features);

  const totalScore = curveScore + landScore + synergyScore + simScore;

  return {
    manaCurve: curve,
    manaCurveScore: curveScore,
    landCount: features.filter((f) => f.isLand).length,
    landRatioScore: landScore,
    creatureCount: features.filter((f) => f.isCreature).length,
    spellCount: features.filter((f) => !f.isLand && !f.isCreature).length,
    removalCount: features.filter((f) => f.isRemoval).length,
    drawCount: features.filter((f) => f.isDraw).length,
    rampCount: features.filter((f) => f.isRamp).length,
    mechanicTagCounts: tagCounts,
    synergyScore,
    simulationScore: simScore,
    totalScore,
    breakdown: {
      curve: curveScore,
      lands: landScore,
      synergy: synergyScore,
      simulation: simScore,
    },
  };
}

/**
 * RL melhorado: hill-climbing com mutações guiadas por features.
 * Substitui cartas de baixo impacto por cartas do pool com melhor sinergia.
 */
export function optimizeDeckRL(
  initialDeck: { name: string; type?: string | null; text?: string | null; cmc?: number | null; quantity?: number }[],
  cardPool: { name: string; type?: string | null; text?: string | null; cmc?: number | null }[],
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

  const nonLandPool = cardPool.filter((c) => !(c.type || "").toLowerCase().includes("land"));

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
  deck: { name: string; type?: string | null; text?: string | null; cmc?: number | null; quantity?: number }[]
) {
  const expanded: { name: string; type?: string | null; text?: string | null; cmc?: number | null }[] = [];
  for (const card of deck) {
    const qty = card.quantity || 1;
    for (let i = 0; i < qty; i++) {
      expanded.push({ name: card.name, type: card.type, text: card.text, cmc: card.cmc });
    }
  }
  return expanded;
}

function collapseDeck(
  expanded: { name: string; type?: string | null; text?: string | null; cmc?: number | null }[],
  original: { name: string; type?: string | null; text?: string | null; cmc?: number | null; quantity?: number }[]
) {
  const counts: Record<string, number> = {};
  for (const c of expanded) counts[c.name] = (counts[c.name] || 0) + 1;

  return Object.entries(counts).map(([name, quantity]) => {
    const orig = original.find((o) => o.name === name);
    return { name, quantity, type: orig?.type, text: orig?.text, cmc: orig?.cmc };
  });
}

function mutateDeck(
  deck: { name: string; type?: string | null; text?: string | null; cmc?: number | null }[],
  pool: { name: string; type?: string | null; text?: string | null; cmc?: number | null }[],
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
  pool: { name: string; type?: string | null; text?: string | null; cmc?: number | null }[],
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
  const scored = pool.map((card) => {
    const f = extractCardFeatures(card);
    let score = f.impactScore;

    // Bônus por tags compatíveis com o deck
    for (const tag of f.mechanicTags) {
      if (dominantTags.includes(tag)) score += 3;
    }

    // Bônus por CMC adequado ao arquétipo
    const idealCurve = IDEAL_CURVES[archetype.toLowerCase()] || IDEAL_CURVES.default;
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
