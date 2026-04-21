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

  // Functional role → mechanic-tag bridge. The scoring layer operates on
  // mechanicTags, so roles like card_draw/ramp/counterspell/removal need
  // to surface there too or a deck full of removal spells scores 0.
  if (roles.includes("card_draw") && !mechanicTags.includes("draw")) mechanicTags.push("draw");
  if (roles.includes("ramp") && !mechanicTags.includes("ramp")) mechanicTags.push("ramp");
  if (roles.includes("counterspell") && !mechanicTags.includes("counterspell")) mechanicTags.push("counterspell");
  if ((roles.includes("removal") || roles.includes("targeted_removal") || roles.includes("board_wipe"))
      && !mechanicTags.includes("removal")) {
    mechanicTags.push("removal");
  }

  const isCreature = type.includes("creature");
  const isLand = type.includes("land");
  const isInstant = type.includes("instant");
  const isSorcery = type.includes("sorcery");
  const isEnchantment = type.includes("enchantment");
  const isArtifact = type.includes("artifact");
  const isPlaneswalker = type.includes("planeswalker");

  // 3. Impact Score (0-10)
  // Base: 1 para qualquer carta
  // Bônus por função:
  //   board_wipe (+4), finisher (+3), heavy_draw (+2), tutor (+2)
  //   removal/targeted_removal (+1), discard de mão (+1)
  // Bônus por CMC (criaturas com CMC alto são naturalmente mais poderosas):
  //   CMC 3-4: +1, CMC 5+: +2
  // Bônus por raridade:
  //   mythic: +1, rare: +0.5 (arredondado para baixo)
  let impactScore = 1;
  if (roles.includes("board_wipe")) impactScore += 4;
  if (roles.includes("finisher")) impactScore += 3;
  if (roles.includes("heavy_draw")) impactScore += 2;
  if (roles.includes("tutor")) impactScore += 2;
  if (roles.includes("removal") || roles.includes("targeted_removal")) impactScore += 1;
  if (text.includes("discard") && (isInstant || isSorcery)) impactScore += 1; // Thoughtseize, Inquisition
  if (isCreature && cmc >= 3 && cmc <= 4) impactScore += 1;
  if (isCreature && cmc >= 5) impactScore += 2;
  if (card.rarity?.toLowerCase() === "mythic") impactScore += 1;
  // rare: +0.5 (arredondado para baixo, mas acumula com outros bônus)
  if (card.rarity?.toLowerCase() === "rare") impactScore += 0.5;
  impactScore = Math.min(10, Math.floor(impactScore * 10) / 10); // 1 casa decimal

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

  // Super-linear stacking: a deck with 12× the same tag is dramatically more
  // synergistic than 4 groups of 3, so we use count^1.5 once the group
  // crosses the critical-mass threshold of 3.
  let score = 0;
  for (const count of Object.values(tagCounts)) {
    if (count >= 3) score += Math.pow(count, 1.5);
  }

  // Removal-density bonus: having enough interaction is a separate
  // correctness property from generic mechanical stacking.
  if (tagCounts.removal && tagCounts.removal >= 4) {
    score += tagCounts.removal * 3;
  }

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

/**
 * Calibra as constantes do motor (IDEAL_LAND_COUNTS, IDEAL_CURVES) a partir
 * de decks reais. Uso típico: importar competitive_decks/MTGGoldfish e
 * calcular o "normal" real em vez de chutar.
 *
 * Entrada: lista de decks, onde cada deck é uma lista de cartas com
 * { cmc, type, quantity }. "type" é case-insensitive e qualquer string
 * que contenha "land" conta como terreno.
 *
 * Saída: médias por deck. Array vazio → fallback 24 lands / sem curva.
 */
export function calibrateFromRealDecks(
  decks: Array<Array<{ cmc: number; type: string; quantity: number }>>
): { avgLands: number; avgCurve: Record<number, number> } {
  if (decks.length === 0) {
    return { avgLands: 24, avgCurve: {} };
  }

  let totalLands = 0;
  const curveSum: Record<number, number> = {};

  for (const deck of decks) {
    let landsThisDeck = 0;
    const deckCurve: Record<number, number> = {};
    for (const card of deck) {
      if (typeof card.type === "string" && card.type.toLowerCase().includes("land")) {
        landsThisDeck += card.quantity;
      } else {
        deckCurve[card.cmc] = (deckCurve[card.cmc] || 0) + card.quantity;
      }
    }
    totalLands += landsThisDeck;
    for (const [cmcStr, count] of Object.entries(deckCurve)) {
      const cmc = parseInt(cmcStr, 10);
      curveSum[cmc] = (curveSum[cmc] || 0) + count;
    }
  }

  const avgLands = totalLands / decks.length;
  const avgCurve: Record<number, number> = {};
  for (const [cmcStr, sum] of Object.entries(curveSum)) {
    const cmc = parseInt(cmcStr, 10);
    avgCurve[cmc] = sum / decks.length;
  }

  return { avgLands, avgCurve };
}

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

// ─── Win Condition Validator ───────────────────────────────────────────────────

export interface WinConditionResult {
  hasWinCondition: boolean;
  types: string[];
  confidence: number; // 0-100
  details: string[];
  warnings: string[];
}

interface WinCard {
  name: string;
  type?: string | null;
  text?: string | null;
  power?: string | null;
}

const ALT_WIN_PATTERNS: { pattern: RegExp; label: string }[] = [
  { pattern: /you win the game/i, label: "alternate_win" },
  { pattern: /that player loses the game/i, label: "alternate_win" },
  { pattern: /opponents? lose/i, label: "alternate_win" },
  { pattern: /poison counter/i, label: "poison_win" },
  { pattern: /infect/i, label: "poison_win" },
  { pattern: /mill/i, label: "mill_win" },
  { pattern: /library.*empty|empty.*library/i, label: "mill_win" },
  { pattern: /exile.*library/i, label: "mill_win" },
];

const COMBO_KEYWORDS = ["infinite", "whenever.*untap", "tap.*add.*mana.*tap.*add", "loop"];

/**
 * Named MTG combo pairs/trios. Each entry: at least 2 cards that together form
 * an infinite loop or instant-win when assembled.
 * Key = combo name, value = required card names (lowercase, partial match ok).
 */
const KNOWN_COMBOS: { name: string; label: string; pieces: string[] }[] = [
  // Creature copy loops (infinite combat/damage)
  { name: "Kiki-Jiki + Pestermite", label: "combo_engine", pieces: ["kiki-jiki", "pestermite"] },
  { name: "Kiki-Jiki + Deceiver Exarch", label: "combo_engine", pieces: ["kiki-jiki", "deceiver exarch"] },
  { name: "Kiki-Jiki + Restoration Angel", label: "combo_engine", pieces: ["kiki-jiki", "restoration angel"] },
  { name: "Splinter Twin + Pestermite", label: "combo_engine", pieces: ["splinter twin", "pestermite"] },
  { name: "Splinter Twin + Deceiver Exarch", label: "combo_engine", pieces: ["splinter twin", "deceiver exarch"] },
  // Library win combos
  { name: "Thassa's Oracle + Demonic Consultation", label: "combo_engine", pieces: ["thassa's oracle", "demonic consultation"] },
  { name: "Thassa's Oracle + Tainted Pact", label: "combo_engine", pieces: ["thassa's oracle", "tainted pact"] },
  { name: "Laboratory Maniac + Demonic Consultation", label: "combo_engine", pieces: ["laboratory maniac", "demonic consultation"] },
  // Infinite damage/counters
  { name: "Heliod + Walking Ballista", label: "combo_engine", pieces: ["heliod, sun-crowned", "walking ballista"] },
  { name: "Mikaeus + Triskelion", label: "combo_engine", pieces: ["mikaeus, the unhallowed", "triskelion"] },
  { name: "Mikaeus + Walking Ballista", label: "combo_engine", pieces: ["mikaeus, the unhallowed", "walking ballista"] },
  // Infinite mana combos
  { name: "Urza + Dramatic Reversal + Isochron Scepter", label: "combo_engine", pieces: ["dramatic reversal", "isochron scepter"] },
  { name: "Selvala + Freed from the Real", label: "combo_engine", pieces: ["selvala", "freed from the real"] },
  { name: "Basalt Monolith + Rings of Brighthearth", label: "combo_engine", pieces: ["basalt monolith", "rings of brighthearth"] },
  // Infinite tokens/creatures
  { name: "Nim Deathmantle + Ashnod's Altar + Creature", label: "combo_engine", pieces: ["nim deathmantle", "ashnod's altar"] },
  { name: "Painter's Servant + Grindstone", label: "combo_engine", pieces: ["painter's servant", "grindstone"] },
  // Alternate win with combo
  { name: "Approach of the Second Sun", label: "alternate_win", pieces: ["approach of the second sun"] },
  { name: "Thassa's Oracle empty library", label: "alternate_win", pieces: ["thassa's oracle"] },
  // Poison / Infect combos
  { name: "Infect + Pump", label: "poison_win", pieces: ["glistener elf"] },
  { name: "Phyresis + Target", label: "poison_win", pieces: ["phyresis"] },
  // Mill combos
  { name: "Traumatize + Fraying Sanity", label: "mill_win", pieces: ["traumatize", "fraying sanity"] },
  { name: "Maddening Cacophony + Bruvac", label: "mill_win", pieces: ["maddening cacophony", "bruvac"] },
];

/**
 * Detecta win conditions em um deck baseado no texto das cartas.
 * Identifica: dano direto, combos, win alternativas, mill e planeswalkers.
 */
export function detectWinConditions(cards: WinCard[]): WinConditionResult {
  const types: Set<string> = new Set();
  const details: string[] = [];
  const warnings: string[] = [];

  let tutorCount = 0;
  let hasteCreatureCount = 0;
  let evasionCreatureCount = 0;
  let directDamageCount = 0;
  let planeswalkerCount = 0;
  let comboEngineCount = 0;

  for (const card of cards) {
    const text = (card.text || "").toLowerCase();
    const type = (card.type || "").toLowerCase();
    const name = (card.name || "").toLowerCase();

    // Planeswalker win condition
    if (type.includes("planeswalker")) {
      planeswalkerCount++;
      if (planeswalkerCount >= 2) types.add("planeswalker_pressure");
    }

    // Alternate win conditions (text patterns)
    for (const { pattern, label } of ALT_WIN_PATTERNS) {
      if (pattern.test(text) || pattern.test(name)) {
        types.add(label);
        details.push(`${card.name} — ${label.replace("_", " ")}`);
      }
    }

    // Direct damage win (burn/aggro)
    if (
      text.includes("deals") && text.includes("damage") &&
      (text.includes("target player") || text.includes("any target") || text.includes("each opponent"))
    ) {
      directDamageCount++;
    }

    // Creatures with evasion or haste (aggro clock)
    if (type.includes("creature")) {
      if (text.includes("haste")) hasteCreatureCount++;
      if (
        text.includes("flying") || text.includes("trample") ||
        text.includes("unblockable") || text.includes("menace") ||
        text.includes("can't be blocked")
      ) evasionCreatureCount++;
    }

    // Tutors (combo enablers)
    if (text.includes("search your library") && !text.includes("basic land")) {
      tutorCount++;
    }

    // Combo engine indicators
    if (
      text.includes("whenever") && (text.includes("untap") || text.includes("add {")) ||
      (text.includes("return") && text.includes("from your graveyard")) ||
      COMBO_KEYWORDS.some(k => new RegExp(k).test(text))
    ) {
      comboEngineCount++;
    }
  }

  // Classify aggro win condition
  if (directDamageCount >= 4 || (hasteCreatureCount + evasionCreatureCount) >= 8) {
    types.add("aggro_damage");
    details.push(
      `${hasteCreatureCount} haste + ${evasionCreatureCount} evasion creatures, ${directDamageCount} direct damage spells`
    );
  }

  // Classify combo win condition (heuristic)
  if (tutorCount >= 3 && comboEngineCount >= 2) {
    types.add("combo_engine");
    details.push(`${tutorCount} tutors + ${comboEngineCount} combo engine pieces`);
  }

  // Named combo detection — check if the deck contains known MTG combo pieces
  const deckNames = cards.map(c => (c.name || "").toLowerCase());
  for (const combo of KNOWN_COMBOS) {
    const matchCount = combo.pieces.filter(piece =>
      deckNames.some(name => name.includes(piece))
    ).length;
    if (matchCount >= Math.min(2, combo.pieces.length)) {
      types.add(combo.label);
      details.push(`Named combo: ${combo.name}`);
    }
  }

  // Warnings for weak/missing win conditions
  if (types.size === 0 && planeswalkerCount < 2) {
    warnings.push("No clear win condition detected — add direct damage, evasion creatures, or explicit win cards");
  }
  if (tutorCount === 0 && types.has("combo_engine")) {
    warnings.push("Combo detected but no tutors — combo pieces may be hard to assemble consistently");
  }

  const hasWinCondition = types.size > 0;

  // Confidence: more evidence = higher confidence
  const evidenceScore = types.size * 25 + details.length * 10 + (planeswalkerCount >= 2 ? 15 : 0);
  const confidence = Math.min(100, evidenceScore);

  return { hasWinCondition, types: Array.from(types), confidence, details, warnings };
}
