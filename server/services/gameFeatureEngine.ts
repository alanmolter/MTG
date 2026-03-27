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
  // Roles funcionais (refinado)
  roles: string[];
  // Tags mecânicas profundas
  mechanicTags: string[];
  // Peso de impacto (0-10)
  impactScore: number;
  // Metadata Original (opcional para análise)
  rarity?: string;
  // Compatibilidade Legada
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

export interface SimulationStats {
  screwRate: number;
  floodRate: number;
  winRate: number;
  avgWastedMana: number;
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
  
  // Removal: Board Wipe vs Targeted
  if (text.includes("destroy each") || text.includes("exile all") || text.includes("destroy all")) {
    roles.push("board_wipe", "removal");
  } else if (text.includes("destroy target") || text.includes("exile target") || (text.includes("deals") && text.includes("damage"))) {
    roles.push("targeted_removal", "removal");
  }

  // Draw: Cantrip vs Heavy Draw
  if (text.includes("draw a card")) {
    roles.push("cantrip", "card_draw");
  } else if (text.includes("draw two") || text.includes("draw three") || text.includes("draw cards")) {
    roles.push("heavy_draw", "card_draw");
  }

  // Mana: Ramp
  if (text.includes("add {") || text.includes("search your library for a basic land") || text.includes("put a land")) {
    roles.push("ramp");
  }

  // Engine / Interaction
  if (text.includes("whenever") || text.includes("at the beginning")) roles.push("engine");
  if (text.includes("counter target spell")) roles.push("counterspell", "interaction");
  if (text.includes("search your library") && !roles.includes("ramp")) roles.push("tutor");
  if (text.includes("protection from") || text.includes("hexproof")) roles.push("protection");

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
  rarity?: string | null;
}): CardFeatures {
  const text = (card.text || "").toLowerCase();
  const type = (card.type || "").toLowerCase();
  const cmc = card.cmc ?? 0;

  const roles = getCardRoles(card);
  const mechanicTags: string[] = [];
  const tagKeywords = ["token", "sacrifice", "counter", "lifegain", "graveyard", "discard", "scry", "flying", "haste", "trample"];
  for (const tag of tagKeywords) if (text.includes(tag)) mechanicTags.push(tag);

  const isCreature = type.includes("creature");
  const isLand = type.includes("land");
  const isInstant = type.includes("instant");
  const isSorcery = type.includes("sorcery");
  const isEnchantment = type.includes("enchantment");
  const isArtifact = type.includes("artifact");
  const isPlaneswalker = type.includes("planeswalker");

  // 3. Impact Score (0-10)
  let impactScore = 1;
  if (roles.includes("board_wipe")) impactScore += 4;
  if (roles.includes("finisher")) impactScore += 3;
  if (roles.includes("heavy_draw")) impactScore += 2;
  if (roles.includes("tutor")) impactScore += 2;
  if (card.rarity?.toLowerCase() === "mythic") impactScore += 1;
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
    mechanicTags,
    impactScore,
    rarity: card.rarity || undefined,
    // Compatibilidade Legada
    isRemoval: roles.includes("removal"),
    isDraw: roles.includes("card_draw"),
    isRamp: roles.includes("ramp"),
    isToken: mechanicTags.includes("token"),
    isCounter: mechanicTags.includes("counter"),
    isSacrifice: mechanicTags.includes("sacrifice"),
    isLifegain: mechanicTags.includes("lifegain"),
    isHaste: mechanicTags.includes("haste"),
    isFlying: mechanicTags.includes("flying"),
    isProtection: roles.includes("protection"),
    isCounterspell: roles.includes("counterspell"),
    isTutor: roles.includes("tutor"),
    isDiscard: mechanicTags.includes("discard"),
    isGraveyard: mechanicTags.includes("graveyard"),
  };
}

// ─── Scoring Functions ────────────────────────────────────────────────────────

export function manaCurveScore(features: CardFeatures[], archetype: string = "default"): { score: number; curve: Record<number, number> } {
  const rawCurve: Record<number, number> = {};
  const idealCurve = IDEAL_CURVES[archetype.toLowerCase()] || IDEAL_CURVES.default;
  let score = 0;

  for (const f of features) {
    if (f.isLand) continue;
    const cmc = Math.min(f.cmc, 5);
    rawCurve[cmc] = (rawCurve[cmc] || 0) + 1;
  }

  for (const [cost, ideal] of Object.entries(idealCurve)) {
    const actual = rawCurve[parseInt(cost)] || 0;
    score -= Math.abs(actual - ideal) * 2;
  }

  return { score, curve: rawCurve };
}

export function landRatioScore(features: CardFeatures[], archetype: string = "default"): number {
  const lands = features.filter(f => f.isLand).length;
  const ideal = IDEAL_LAND_COUNTS[archetype.toLowerCase()] || IDEAL_LAND_COUNTS.default;
  return -Math.abs(lands - ideal) * 3;
}

export function mechanicSynergyScore(features: CardFeatures[]): { score: number; tagCounts: Record<string, number> } {
  const tagCounts: Record<string, number> = {};
  for (const f of features) for (const tag of f.mechanicTags) tagCounts[tag] = (tagCounts[tag] || 0) + 1;
  
  let score = 0;
  for (const count of Object.values(tagCounts)) if (count >= 3) score += count * 2;
  
  return { score, tagCounts };
}

export function simulateTurns(features: CardFeatures[], iterations: number = 30): { score: number; stats: SimulationStats } {
  let screw = 0, flood = 0, wasted = 0;
  for (let i = 0; i < iterations; i++) {
    const deck = [...features].sort(() => Math.random() - 0.5);
    const hand = deck.splice(0, 7);
    let lands = hand.filter(f => f.isLand).length;
    if (lands < 2) screw++;
    if (lands > 4) flood++;
  }
  return { 
    score: (iterations - screw - flood) * 2, 
    stats: { screwRate: screw/iterations, floodRate: flood/iterations, winRate: 0.5, avgWastedMana: 2 } 
  };
}

// ─── Metrics Calculation ─────────────────────────────────────────────────────

export function calculateDeckMetrics(cards: any[], archetype: string = "default"): DeckMetrics {
  const features = cards.map(c => extractCardFeatures(c));
  const curve = manaCurveScore(features, archetype);
  const land = landRatioScore(features, archetype);
  const synergy = mechanicSynergyScore(features);
  const sim = simulateTurns(features);

  const roleCounts: Record<string, number> = {};
  for (const f of features) for (const role of f.roles) roleCounts[role] = (roleCounts[role] || 0) + 1;

  const totalScore = curve.score + land + synergy.score + sim.score;

  return {
    manaCurve: curve.curve,
    manaCurveScore: curve.score,
    landCount: features.filter(f => f.isLand).length,
    landRatioScore: land,
    creatureCount: features.filter(f => f.isCreature).length,
    spellCount: features.filter(f => !f.isLand && !f.isCreature).length,
    removalCount: roleCounts.removal || 0,
    drawCount: roleCounts.card_draw || 0,
    rampCount: roleCounts.ramp || 0,
    roleCounts,
    structureScore: 0,
    structureWarnings: [],
    mechanicTagCounts: synergy.tagCounts,
    synergyScore: synergy.score,
    simulationScore: sim.score,
    simulationStats: sim.stats,
    consistencyScore: 70,
    avgWinTurn: 5,
    comboComplexity: 10,
    totalScore,
    breakdown: {
      curve: curve.score,
      lands: land,
      synergy: synergy.score,
      simulation: sim.score,
      consistency: 70,
      speed: 80,
      complexity: 10,
      structure: 90
    }
  };
}

/**
 * Aliases para compatibilidade
 */
export const evaluateDeck = calculateDeckMetrics;
export const extractFeatures = extractCardFeatures;

// ─── RL Utilities ─────────────────────────────────────────────────────────────

export interface OptimizationTarget {
  archetype: string;
  minScore: number;
}

export function mutateDeck(deck: any[], pool: any[]): any[] {
  const newDeck = [...deck];
  const idx = Math.floor(Math.random() * newDeck.length);
  newDeck[idx] = pool[Math.floor(Math.random() * pool.length)];
  return newDeck;
}

export function optimizeDeckRL(
  deck: any[], 
  pool: any[], 
  archetype: string, 
  iterations: number = 100, 
  evaluator?: (deck: any[], archetype: string) => { totalScore: number }
): { deck: any[], initialScore: number, finalScore: number, improvements: number } {
  let currentDeck = [...deck];
  const getScore = (d: any[]) => evaluator ? evaluator(d, archetype).totalScore : calculateDeckMetrics(d, archetype).totalScore;
  
  let initialScore = getScore(currentDeck);
  let currentScore = initialScore;
  let improvements = 0;

  for (let i = 0; i < iterations; i++) {
    const candidate = mutateDeck(currentDeck, pool);
    const score = getScore(candidate);
    if (score > currentScore) {
      currentDeck = candidate;
      currentScore = score;
      improvements++;
    }
  }
  return { deck: currentDeck, initialScore, finalScore: currentScore, improvements };
}
