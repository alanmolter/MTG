/**
 * Archetype Generator
 *
 * Gerador de decks baseado em templates de arquétipo.
 * Integra filtros avançados (cor, tribo, tipo), scoring por prioridades
 * e suporte a múltiplos formatos MTG.
 */

import { extractCardFeatures } from "./gameFeatureEngine";

// ─── Tipos ────────────────────────────────────────────────────────────────────

export type ArchetypeName =
  | "aggro"
  | "burn"
  | "control"
  | "combo"
  | "midrange"
  | "ramp"
  | "tempo";

export type FormatName =
  | "standard"
  | "historic"
  | "modern"
  | "legacy"
  | "commander"
  | "pioneer";

export type Playstyle =
  | "go_wide"
  | "go_tall"
  | "burn_hybrid"
  | "draw_go"
  | "tap_out"
  | "hard_control";

export type ColorMode = "strict" | "splash" | "flex";
export type PowerLevel = "casual" | "ranked" | "meta";
export type Consistency = "high" | "medium" | "greedy";

export type ManaColor = "W" | "U" | "B" | "R" | "G";

export interface CardData {
  id: number;
  name: string;
  type: string | null;
  text: string | null;
  cmc: number | null;
  colors: string | null; // ex: "WU", "R", "BG"
  rarity: string | null;
  imageUrl: string | null;
  isArena?: number | null;
}

export interface ArchetypeTemplate {
  curve: Record<number, number>;
  lands: number;
  creatures: number;
  spells: number;
  priorities: string[];
  description: string;
  keyMechanics: string[];
}

export interface GenerateByArchetypeOptions {
  archetype: ArchetypeName;
  format: FormatName;
  colors?: ManaColor[];
  tribes?: string[];
  cardTypes?: string[];
  useScoring?: boolean;
  onlyArena?: boolean;
  playstyle?: Playstyle;
  colorMode?: ColorMode;
  powerLevel?: PowerLevel;
  consistency?: Consistency;
  learnedWeights?: Record<string, number>;
}

export interface GeneratedDeckResult {
  archetype: ArchetypeName;
  format: FormatName;
  deckSize: number;
  cards: (CardData & { quantity: number; role: string })[];
  template: ArchetypeTemplate;
  poolSize: number;
  warnings: string[];
}

// ─── Templates de Arquétipo ───────────────────────────────────────────────────

export const ARCHETYPES: Record<ArchetypeName, ArchetypeTemplate> = {
  aggro: {
    curve: { 1: 12, 2: 14, 3: 8, 4: 4 },
    lands: 22,
    creatures: 28,
    spells: 10,
    priorities: ["haste", "direct_damage", "low_cmc"],
    description:
      "Fast aggressive strategy focused on early pressure and direct damage.",
    keyMechanics: ["haste", "first strike", "trample", "direct damage"],
  },
  burn: {
    curve: { 1: 16, 2: 12, 3: 6, 4: 2 },
    lands: 20,
    creatures: 8,
    spells: 32,
    priorities: ["direct_damage", "low_cmc", "haste"],
    description:
      "Pure damage strategy using instants and sorceries to burn opponents.",
    keyMechanics: ["direct damage", "instant speed", "haste"],
  },
  control: {
    curve: { 2: 6, 3: 10, 4: 10, 5: 6 },
    lands: 26,
    creatures: 6,
    spells: 28,
    priorities: ["removal", "draw", "counter"],
    description:
      "Reactive strategy that answers threats and wins in the late game.",
    keyMechanics: ["counterspell", "removal", "card draw", "board wipe"],
  },
  combo: {
    curve: { 1: 6, 2: 10, 3: 12, 4: 8 },
    lands: 24,
    creatures: 12,
    spells: 24,
    priorities: ["draw", "tutor", "synergy"],
    description:
      "Assembles a powerful combination of cards to win in a single turn.",
    keyMechanics: ["tutor", "card draw", "sacrifice", "token", "counter"],
  },
  midrange: {
    curve: { 2: 8, 3: 12, 4: 10, 5: 6 },
    lands: 24,
    creatures: 22,
    spells: 14,
    priorities: ["removal", "value", "resilience"],
    description:
      "Flexible strategy with efficient threats and answers for any situation.",
    keyMechanics: ["removal", "card advantage", "enters the battlefield"],
  },
  ramp: {
    curve: { 1: 4, 2: 8, 3: 8, 4: 4, 5: 8, 6: 4 },
    lands: 22,
    creatures: 16,
    spells: 22,
    priorities: ["ramp", "draw", "big_threat"],
    description:
      "Accelerates mana production to deploy oversized threats ahead of schedule.",
    keyMechanics: ["ramp", "land search", "mana dork", "big creatures"],
  },
  tempo: {
    curve: { 1: 8, 2: 14, 3: 10, 4: 4 },
    lands: 20,
    creatures: 16,
    spells: 24,
    priorities: ["counter", "draw", "low_cmc"],
    description:
      "Efficient threats backed by cheap interaction to stay ahead on tempo.",
    keyMechanics: ["flash", "counterspell", "bounce", "draw"],
  },
};

// ─── Playstyle Modifiers ─────────────────────────────────────────────────────

interface PlaystyleModifier {
  curve: Record<number, number>;
  priorities: string[];
  keyMechanics: string[];
  description: string;
}

export const PLAYSTYLES: Record<Playstyle, PlaystyleModifier> = {
  go_wide: {
    curve: { 1: 16, 2: 16, 3: 10, 4: 4 },
    priorities: ["token", "creature", "sacrifice", "draw"],
    keyMechanics: ["token", "sacrifice", "go wide", "mass anthem"],
    description: "Generate many small creatures to overwhelm opponents.",
  },
  go_tall: {
    curve: { 1: 6, 2: 10, 3: 12, 4: 12 },
    priorities: ["counter_synergy", "pump", "big_threat"],
    keyMechanics: ["+1/+1 counters", "pump", "go tall", "double strike"],
    description: "Build a few powerful creatures with counters and buffs.",
  },
  burn_hybrid: {
    curve: { 1: 14, 2: 14, 3: 8, 4: 2 },
    priorities: ["direct_damage", "low_cmc", "haste", "creature"],
    keyMechanics: ["direct damage", "burn", "aggro-creature", "heroic"],
    description:
      "Mix direct damage with aggressive creatures for maximum pressure.",
  },
  draw_go: {
    curve: { 1: 2, 2: 8, 3: 12, 4: 10, 5: 6 },
    priorities: ["draw", "counter", "removal", "flash"],
    keyMechanics: ["card draw", "counterspell", "flash", "instant speed"],
    description:
      "Pass the turn with counters and card advantage, react to everything.",
  },
  tap_out: {
    curve: { 2: 4, 3: 10, 4: 14, 5: 10, 6: 4 },
    priorities: ["removal", "draw", "big_threat", "board_wipe"],
    keyMechanics: ["board wipe", "removal", "fat creatures", "tap-out control"],
    description: "Play powerful cards at sorcery speed, tap out every turn.",
  },
  hard_control: {
    curve: { 1: 2, 2: 6, 3: 8, 4: 12, 5: 10, 6: 6 },
    priorities: ["counter", "removal", "draw", "board_wipe", "wincon"],
    keyMechanics: [
      "counterspell",
      "removal",
      "board wipe",
      "planeswalker",
      "lock",
    ],
    description: "Total control with counters, removal, and inevitability.",
  },
};

// ─── Regras de Formato ────────────────────────────────────────────────────────

export const FORMAT_RULES: Record<
  FormatName,
  { deckSize: number; maxCopies: number; sideboardSize: number }
> = {
  standard: { deckSize: 60, maxCopies: 4, sideboardSize: 15 },
  historic: { deckSize: 60, maxCopies: 4, sideboardSize: 15 },
  modern: { deckSize: 60, maxCopies: 4, sideboardSize: 15 },
  legacy: { deckSize: 60, maxCopies: 4, sideboardSize: 15 },
  pioneer: { deckSize: 60, maxCopies: 4, sideboardSize: 15 },
  commander: { deckSize: 100, maxCopies: 1, sideboardSize: 0 },
};

// ─── Classificador de Cartas ──────────────────────────────────────────────────

/**
 * Classifica uma carta por função/tags para uso no scoring por arquétipo.
 */
export function classifyCard(card: CardData): string[] {
  const text = (card.text || "").toLowerCase();
  const type = (card.type || "").toLowerCase();
  const tags: string[] = [];

  // Tipo base
  if (type.includes("creature")) tags.push("creature");
  if (type.includes("land")) tags.push("land");
  if (type.includes("instant")) tags.push("instant");
  if (type.includes("sorcery")) tags.push("sorcery");
  if (type.includes("enchantment")) tags.push("enchantment");
  if (type.includes("artifact")) tags.push("artifact");
  if (type.includes("planeswalker")) tags.push("planeswalker");

  if (
    text.includes("destroy") ||
    text.includes("exile") ||
    (text.includes("deals") && text.includes("damage"))
  )
    tags.push("removal");
  if (
    text.includes("draw a card") ||
    text.includes("draw cards") ||
    text.includes("draw two") ||
    text.includes("draw three")
  )
    tags.push("draw");
  if (text.includes("counter target")) tags.push("counter");
  if (
    text.includes("add {") ||
    text.includes("search your library for a basic land")
  )
    tags.push("ramp");
  if (text.includes("haste")) tags.push("haste");
  if (text.includes("deals") && text.includes("damage"))
    tags.push("direct_damage");
  if (text.includes("search your library") && !text.includes("basic land"))
    tags.push("tutor");
  if (text.includes("create") && text.includes("token")) tags.push("token");
  if (text.includes("+1/+1 counter") || text.includes("proliferate"))
    tags.push("counter_synergy");
  if (text.includes("sacrifice")) tags.push("sacrifice");
  if (
    text.includes("from your graveyard") ||
    text.includes("flashback") ||
    text.includes("escape")
  )
    tags.push("graveyard");
  if (text.includes("flying")) tags.push("flying");
  if (
    text.includes("lifelink") ||
    (text.includes("gain") && text.includes("life"))
  )
    tags.push("lifegain");
  if (text.includes("flash")) tags.push("flash");
  if (text.includes("trample")) tags.push("trample");
  if (text.includes("first strike") || text.includes("double strike"))
    tags.push("first_strike");

  // CMC
  const cmc = card.cmc ?? 0;
  if (cmc <= 2) tags.push("low_cmc");
  if (cmc >= 5) tags.push("high_cmc");
  if (cmc >= 7) tags.push("big_threat");

  return tags;
}

// ─── Filtro de Cor por Modo ───────────────────────────────────────────────────

function matchesColorMode(
  cardColors: string,
  selectedColors: ManaColor[],
  mode: ColorMode,
  isLand: boolean = false
): boolean {
  if (!selectedColors || selectedColors.length === 0) return true;

  const colors = cardColors || "";
  const isColorless = colors === "" || colors === "C";

  // Se for terreno e incolor (ex: Evolving Wilds, Reliquary Tower), é sempre permitido
  if (isLand && (isColorless || colors === "C")) return true;
  if (isColorless) return true;

  const hasPrimary = selectedColors.some(c => colors.includes(c));
  if (!hasPrimary) return false;

  // strict: only selected colors (or colorless)
  if (mode === "strict") {
    const extraColors = colors
      .split("")
      .filter(c => !selectedColors.includes(c as ManaColor));
    return extraColors.length === 0;
  }

  // splash: allows 1 extra color (light splash)
  if (mode === "splash") {
    const extraColors = colors
      .split("")
      .filter(c => !selectedColors.includes(c as ManaColor));
    return extraColors.length <= 1;
  }

  // flex: any combination allowed (engine decides)
  return true;
}

// ─── Filtro Avançado ──────────────────────────────────────────────────────────

/**
 * Filtra o pool de cartas por cor, tribo e tipo.
 */
export function filterCards(
  cards: CardData[],
  options: {
    colors?: ManaColor[];
    tribes?: string[];
    cardTypes?: string[];
    excludeLands?: boolean;
    onlyArena?: boolean;
    colorMode?: ColorMode;
  } = {}
): CardData[] {
  const mode = options.colorMode || "strict";

  return cards.filter(card => {
    if (options.onlyArena && !card.isArena) return false;

    const type = (card.type || "").toLowerCase();
    const cardColors = card.colors || "";
    const isLand = type.includes("land");

    // Filtro de cor por modo (MELHORADO: Terrenos agora respeitam a cor do deck)
    if (options.colors && options.colors.length > 0) {
      const isColorless = cardColors === "" || cardColors === "C";
      // Se não for incolor, verificamos se as cores batem (inclusive para terrenos)
      if (!isColorless) {
        if (!matchesColorMode(cardColors, options.colors, mode, isLand)) {
          return false;
        }
      }
    }

    // Filtro de tribo: a carta deve mencionar a tribo no tipo
    if (options.tribes && options.tribes.length > 0) {
      const hasTribe = options.tribes.some(t => type.includes(t.toLowerCase()));
      if (!hasTribe) return false;
    }

    // Filtro de tipo de carta
    if (options.cardTypes && options.cardTypes.length > 0) {
      const hasType = options.cardTypes.some(t =>
        type.includes(t.toLowerCase())
      );
      if (!hasType) return false;
    }

    // Excluir terrenos do pool de spells/criaturas
    if (options.excludeLands && type.includes("land")) return false;

    return true;
  });
}

// ─── Scoring por Arquétipo ────────────────────────────────────────────────────

/**
 * Pontua uma carta de acordo com o arquétipo alvo.
 * Quanto maior o score, mais adequada a carta é para o arquétipo.
 */
export function scoreCardForArchetype(
  card: CardData,
  archetype: ArchetypeTemplate
): number {
  const tags = classifyCard(card);
  const cmc = card.cmc ?? 0;
  let score = 1; // base

  // Bônus por CMC baixo (curva eficiente)
  if (cmc <= 2) score += 2;
  else if (cmc <= 3) score += 1;

  // Bônus por prioridades do arquétipo
  for (const priority of archetype.priorities) {
    if (tags.includes(priority)) score += 3;
  }

  // Bônus por raridade (cartas mais raras tendem a ser mais poderosas)
  if (card.rarity === "mythic") score += 2;
  else if (card.rarity === "rare") score += 1;

  // Penalidade por CMC muito alto em arquétipos agressivos
  if (archetype.priorities.includes("low_cmc") && cmc >= 4) score -= 2;

  // Bônus por ter imagem (carta real do Scryfall)
  if (card.imageUrl) score += 0.5;

  return Math.max(0, score);
}

/**
 * Pontua especificamente para o posto de Comandante.
 * Foca 100% em sinergia com as mecânicas-chave e tribo do arquétipo.
 */
export function scoreCommanderForArchetype(
  card: CardData,
  template: ArchetypeTemplate,
  options: { tribes?: string[]; learnedWeights?: Record<string, number> } = {}
): number {
  const tags = classifyCard(card);
  const type = (card.type || "").toLowerCase();
  
  // Começamos com o score base da carta para o arquétipo
  let score = scoreCardForArchetype(card, template); 

  // FATOR DE APRENDIZADO (Brain): Se a IA já viu essa carta ganhar, o peso aumenta
  if (options.learnedWeights && options.learnedWeights[card.name]) {
    const learnedBoost = options.learnedWeights[card.name];
    // Dampened boost: log-scaled to prevent "winner takes all" behavior
    // normal scores are 10-50, we want weights to help but not dominate.
    score += Math.sqrt(Math.max(0, learnedBoost)) * 2; 
  }

  // Bônus massivo por prioridades mecânicas do arquétipo (+10 por cada tag coincidente)
  for (const priority of template.priorities) {
    if (tags.includes(priority)) score += 10;
  }

  // Bônus por Sinergia Tribal (+15) - Vital para comandantes tribais
  if (options.tribes && options.tribes.length > 0) {
    const hasTribe = options.tribes.some(t => type.includes(t.toLowerCase()));
    if (hasTribe) score += 15;
  }

  // Comandantes míticos tendem a ter efeitos mais complexos de "build-around"
  if (card.rarity === "mythic") score += 5;

  return score;
}

// ─── Gerador Principal ────────────────────────────────────────────────────────

/**
 * Gera um deck completo baseado em arquétipo, formato e filtros.
 */
export function generateDeckByArchetype(
  cardPool: CardData[],
  options: GenerateByArchetypeOptions
): GeneratedDeckResult {
  const baseTemplate = ARCHETYPES[options.archetype];
  const formatRules = FORMAT_RULES[options.format];
  const warnings: string[] = [];

  // Mesclar com playstyle se especificado
  let template = baseTemplate;
  if (options.playstyle) {
    const playstyleModifier = PLAYSTYLES[options.playstyle];
    template = {
      curve: { ...baseTemplate.curve, ...playstyleModifier.curve },
      lands: Math.round(
        baseTemplate.lands *
          (playstyleModifier.curve[1] > baseTemplate.curve[1] ? 0.9 : 1)
      ),
      creatures: playstyleModifier.priorities.includes("token")
        ? Math.round(baseTemplate.creatures * 1.3)
        : baseTemplate.creatures,
      spells: baseTemplate.spells,
      priorities: Array.from(
        new Set([...baseTemplate.priorities, ...playstyleModifier.priorities])
      ),
      description: `${baseTemplate.description} ${playstyleModifier.description}`,
      keyMechanics: Array.from(
        new Set([
          ...baseTemplate.keyMechanics,
          ...playstyleModifier.keyMechanics,
        ])
      ),
    };
  }

  // ── ESCALONAMENTO DE FORMATO (Commander fix: 100 cartas) ────────────────────
  if (options.format === "commander") {
    template = {
      ...template,
      lands: 37, // Alinhado com LigaMagic/Reddit para decks de 100 cartas
      creatures: Math.round(template.creatures * 1.5),
      spells: Math.round(template.spells * 1.5),
      // No Commander, Ramp e Draw são mandatórios para qualquer arquétipo
      priorities: Array.from(new Set([...template.priorities, "ramp", "draw"]))
    };
  }

  // Ajustar template baseado em powerLevel e consistency
  if (options.powerLevel || options.consistency) {
    const powerLevel = options.powerLevel || "ranked";
    const consistency = options.consistency || "medium";

    // Power level modifica o número de lands e a curva
    const landAdjust =
      powerLevel === "meta" ? -2 : powerLevel === "casual" ? 2 : 0;
    const creaturesAdjust =
      powerLevel === "meta" ? 2 : powerLevel === "casual" ? -2 : 0;

    // Consistency modifica a curva (high = mais consistente = MAIS low cmc)
    // Se high: shift -1. Se greedy: shift +1.
    const curveShift =
      consistency === "high" ? 1 : consistency === "greedy" ? -1 : 0;

    template = {
      ...template,
      lands: Math.max(18, template.lands + landAdjust),
      creatures: Math.max(8, template.creatures + creaturesAdjust),
      curve: Object.fromEntries(
        Object.entries(template.curve).map(([cmc, count]) => [
          cmc,
          // Se curveShift > 0 (high consistency), aumentamos cartas de custo baixo (<= 2)
          Math.max(0, count + curveShift * (parseInt(cmc) <= 2 ? 2 : -1)),
        ])
      ),
    };
  }

  // ── 1. Pool de Terrenos (Apenas cores, ignorando tipos/tribos do usuário) ────
  const manaPool = filterCards(cardPool, {
    colors: options.colors,
    onlyArena: options.onlyArena,
    colorMode: options.colorMode,
  }).filter(c => (c.type || "").toLowerCase().includes("land"));

  // ── 2. Pool de Spells/Creaturas (Respeita TODOS os filtros: tipo, tribo, cores) ──
  const baseFilteredPool = filterCards(cardPool, {
    colors: options.colors,
    tribes: options.tribes,
    cardTypes: options.cardTypes,
    excludeLands: true, // Tiramos terrenos daqui para não inflar o pool de spells
    onlyArena: options.onlyArena,
    colorMode: options.colorMode,
  });

  const filteredPool =
    options.format === "commander"
      ? baseFilteredPool.filter(c => (c.cmc ?? 0) <= 6)
      : baseFilteredPool;

  if (filteredPool.length < 20) {
    warnings.push(
      `Pool de estratégia muito pequeno (${filteredPool.length} cartas). Remova filtros ou sincronize mais cartas.`
    );
  }

  // Separar terrenos, criaturas e spells
  const allLands = manaPool;
  const allCreatures = filteredPool.filter(c =>
      (c.type || "").toLowerCase().includes("creature")
  );
  const allSpells = filteredPool.filter(c =>
      !(c.type || "").toLowerCase().includes("creature")
  );

  // Ordenar por score
  const sortByScore = (cards: CardData[]) =>
    [...cards].sort(
      (a, b) =>
        scoreCardForArchetype(b, template) - scoreCardForArchetype(a, template)
    );

  const scoredCreatures = sortByScore(allCreatures);
  const scoredSpells = sortByScore(allSpells);

  const maxCopies = formatRules.maxCopies;
  const deckSize = formatRules.deckSize;

  const deck: (CardData & { quantity: number; role: string })[] = [];
  let totalCards = 0;

  // ── 0. Commander (for Commander format) ──────────────────────────────────────
  if (options.format === "commander") {
    const legendaryCreatures = scoredCreatures.filter(c => 
      (c.type || "").toLowerCase().includes("legendary") && 
      (c.type || "").toLowerCase().includes("creature")
    );
    
    if (legendaryCreatures.length > 0) {
      const bestCommanders = [...legendaryCreatures].sort((a, b) => 
        scoreCommanderForArchetype(b, template, { tribes: options.tribes, learnedWeights: options.learnedWeights }) - 
        scoreCommanderForArchetype(a, template, { tribes: options.tribes, learnedWeights: options.learnedWeights })
      );

      // EXPLORAÇÃO: Pegamos aleatoriamente entre os top candidatos (weighted selection simplificada)
      const diversity = 5; // Escolher entre as top 5 melhores opções
      const topCount = Math.min(diversity, bestCommanders.length);
      const commander = bestCommanders[Math.floor(Math.random() * topCount)];

      deck.push({ ...commander, quantity: 1, role: "commander" });
      totalCards++;
      
      // Remover do pool para não duplicar se houver outras vagas
      const idx = scoredCreatures.findIndex(c => c.id === commander.id);
      if (idx !== -1) scoredCreatures.splice(idx, 1);
    } else {
      warnings.push("Nenhuma criatura lendária encontrada para ser o Comandante. O deck pode ser inválido.");
    }
  }

  // ── 1. Terrenos ──────────────────────────────────────────────────────────────
  const targetLands = Math.min(template.lands, deckSize);
  const landsToAdd =
    allLands.length > 0
      ? shuffleAndPick(allLands, targetLands)
      : generateBasicLands(options.colors, targetLands);

  for (const land of landsToAdd) {
    const isBasic = (land.type || "").toLowerCase().includes("basic");
    const existing = deck.find(d => d.name === land.name);
    if (existing) {
      if (isBasic || existing.quantity < maxCopies) {
        existing.quantity++;
        totalCards++;
      }
    } else {
      deck.push({ ...land, quantity: 1, role: "land" });
      totalCards++;
    }
  }

  if (landsToAdd.length < targetLands) {
    warnings.push(
      `Apenas ${landsToAdd.length} terrenos encontrados (ideal: ${targetLands}). Adicione mais terrenos ao banco.`
    );
  }

  // ── 2. Criaturas ─────────────────────────────────────────────────────────────
  const targetCreatures = Math.min(template.creatures, deckSize - totalCards);
  let creaturesAdded = 0;

  for (const creature of scoredCreatures) {
    if (creaturesAdded >= targetCreatures) break;
    const existing = deck.find(d => d.name === creature.name);
    if (existing) {
      if (existing.quantity < maxCopies) {
        existing.quantity++;
        creaturesAdded++;
        totalCards++;
      }
    } else {
      const qty = Math.min(maxCopies, targetCreatures - creaturesAdded);
      deck.push({ ...creature, quantity: qty, role: "creature" });
      creaturesAdded += qty;
      totalCards += qty;
    }
  }

  if (creaturesAdded < template.creatures * 0.5) {
    warnings.push(
      `Poucas criaturas encontradas (${creaturesAdded}/${template.creatures}). Ajuste os filtros.`
    );
  }

  // ── 3. Spells ────────────────────────────────────────────────────────────────
  const targetSpells = deckSize - totalCards;

  for (const spell of scoredSpells) {
    if (totalCards >= deckSize) break;
    const existing = deck.find(d => d.name === spell.name);
    if (existing) {
      if (existing.quantity < maxCopies) {
        existing.quantity++;
        totalCards++;
      }
    } else {
      const qty = Math.min(maxCopies, deckSize - totalCards);
      deck.push({ ...spell, quantity: qty, role: "spell" });
      totalCards += qty;
    }
  }

  // Se ainda faltam cartas, preencher com terrenos básicos
  if (totalCards < deckSize) {
    const missing = deckSize - totalCards;
    warnings.push(
      `Deck incompleto: ${missing} cartas faltando. Sincronize mais cartas do Scryfall.`
    );
    const basics = generateBasicLands(options.colors, missing);
    for (const land of basics) {
      const existing = deck.find(d => d.name === land.name);
      if (existing) {
        existing.quantity += 1;
        totalCards++;
      } else {
        deck.push({ ...land, quantity: 1, role: "land" });
        totalCards++;
      }
    }
  }

  return {
    archetype: options.archetype,
    format: options.format,
    deckSize: deck.reduce((s, c) => s + c.quantity, 0),
    cards: deck,
    template,
    poolSize: filteredPool.length,
    warnings,
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function shuffleAndPick<T>(arr: T[], n: number): T[] {
  const shuffled = [...arr].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, n);
}

/**
 * Gera terrenos básicos quando o pool não tem terrenos suficientes.
 */
function generateBasicLands(
  colors: ManaColor[] | undefined,
  count: number
): CardData[] {
  const colorToLand: Record<ManaColor, string> = {
    W: "Plains",
    U: "Island",
    B: "Swamp",
    R: "Mountain",
    G: "Forest",
  };

  const targetColors =
    colors && colors.length > 0 ? colors : (["R"] as ManaColor[]);
  const lands: CardData[] = [];

  const perColor = Math.ceil(count / targetColors.length);
  let added = 0;

  for (const color of targetColors) {
    const landName = colorToLand[color];
    const qty = Math.min(perColor, count - added);
    for (let i = 0; i < qty; i++) {
      lands.push({
        id: -1,
        name: landName,
        type: `Basic Land — ${landName}`,
        text: `({T}: Add {${color}}.)`,
        cmc: 0,
        colors: "",
        rarity: "common",
        imageUrl: null,
      });
      added++;
    }
  }

  return lands;
}

// ─── Exportação de Deck ───────────────────────────────────────────────────────

/**
 * Exporta deck no formato Arena (1 CardName por linha).
 */
export function exportToArena(cards: (CardData & { quantity: number; role?: string })[]) {
  const commander = cards.find(c => c.role === "commander");
  const deck = cards.filter(c => c.role !== "commander");

  if (commander) {
    return `Commander\n1 ${commander.name}\n\nDeck\n${deck
      .map(c => `${c.quantity} ${c.name}`)
      .join("\n")}`;
  }
  return cards.map(c => `${c.quantity} ${c.name}`).join("\n");
}

/**
 * Exporta deck no formato texto padrão.
 */
export function exportToText(
  cards: (CardData & { quantity: number; role?: string })[],
  meta: { archetype: string; format: string }
) {
  const commander = cards.find(c => c.role === "commander");
  const lands = cards.filter(
    c => c.role === "land" || (c.type || "").toLowerCase().includes("land")
  );
  const creatures = cards.filter(
    c =>
      (c.role === "creature" ||
      ((c.type || "").toLowerCase().includes("creature") &&
        !(c.type || "").toLowerCase().includes("land"))) &&
      c.role !== "commander"
  );
  const spells = cards.filter(
    c =>
      (c.role === "spell" ||
      (!(c.type || "").toLowerCase().includes("creature") &&
        !(c.type || "").toLowerCase().includes("land"))) &&
      c.role !== "commander"
  );

  const section = (title: string, list: typeof cards) =>
    list.length > 0
      ? `// ${title} (${list.reduce((s, c) => s + c.quantity, 0)})\n${list
          .map(c => `${c.quantity} ${c.name}`)
          .join("\n")}`
      : "";

  return [
    `// MTG Deck — ${meta.archetype.toUpperCase()} | ${meta.format.toUpperCase()}`,
    `// Generated by MTG Deck Engine`,
    "",
    commander ? `// Commander\n1 ${commander.name}\n` : "",
    section("Creatures", creatures),
    section("Spells", spells),
    section("Lands", lands),
  ]
    .filter(Boolean)
    .join("\n");
}
