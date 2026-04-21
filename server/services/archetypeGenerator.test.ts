import { describe, it, expect } from "vitest";
import {
  classifyCard,
  filterCards,
  scoreCardForArchetype,
  generateDeckByArchetype,
  exportToArena,
  exportToText,
  ARCHETYPES,
  FORMAT_RULES,
  type CardData,
} from "./archetypeGenerator";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const makeCard = (overrides: Partial<CardData> = {}): CardData => ({
  id: Math.floor(Math.random() * 10000),
  name: "Test Card",
  type: "Creature — Human",
  text: "",
  cmc: 2,
  colors: "W",
  rarity: "common",
  imageUrl: null,
  ...overrides,
});

const lightningBolt = makeCard({ name: "Lightning Bolt", type: "Instant", text: "Lightning Bolt deals 3 damage to any target.", cmc: 1, colors: "R", rarity: "common" });
const counterspell = makeCard({ name: "Counterspell", type: "Instant", text: "Counter target spell.", cmc: 2, colors: "U", rarity: "uncommon" });
const llanowarElves = makeCard({ name: "Llanowar Elves", type: "Creature — Elf Druid", text: "Add {G}.", cmc: 1, colors: "G", rarity: "common" });
const brainstorm = makeCard({ name: "Brainstorm", type: "Instant", text: "Draw three cards, then put two cards from your hand on top of your library.", cmc: 1, colors: "U", rarity: "common" });
const mountain = makeCard({ name: "Mountain", type: "Basic Land — Mountain", text: "", cmc: 0, colors: "", rarity: "common" });
const island = makeCard({ name: "Island", type: "Basic Land — Island", text: "", cmc: 0, colors: "", rarity: "common" });
const forest = makeCard({ name: "Forest", type: "Basic Land — Forest", text: "", cmc: 0, colors: "", rarity: "common" });
const goblinGuide = makeCard({ name: "Goblin Guide", type: "Creature — Goblin Scout", text: "Haste.", cmc: 1, colors: "R", rarity: "rare" });
const snapcaster = makeCard({ name: "Snapcaster Mage", type: "Creature — Human Wizard", text: "Flash. When Snapcaster Mage enters the battlefield, target instant or sorcery card in your graveyard gains flashback.", cmc: 2, colors: "U", rarity: "rare" });
const gravedigger = makeCard({ name: "Gravedigger", type: "Creature — Zombie", text: "When Gravedigger enters the battlefield, you may return target creature card from your graveyard to your hand.", cmc: 4, colors: "B", rarity: "common" });
const solemn = makeCard({ name: "Solemn Simulacrum", type: "Artifact Creature — Golem", text: "When Solemn Simulacrum enters the battlefield, you may search your library for a basic land card.", cmc: 4, colors: "", rarity: "rare" });
const vindicate = makeCard({ name: "Vindicate", type: "Sorcery", text: "Destroy target permanent.", cmc: 3, colors: "WB", rarity: "rare" });
const explore = makeCard({ name: "Explore", type: "Sorcery", text: "You may play an additional land this turn. Draw a card.", cmc: 2, colors: "G", rarity: "common" });
const demonic = makeCard({ name: "Demonic Tutor", type: "Sorcery", text: "Search your library for a card, put that card into your hand.", cmc: 2, colors: "B", rarity: "rare" });
const goblinToken = makeCard({ name: "Krenko, Mob Boss", type: "Creature — Goblin Warrior", text: "Create a number of 1/1 red Goblin creature tokens.", cmc: 4, colors: "R", rarity: "rare" });
const sacrifice = makeCard({ name: "Ashnod's Altar", type: "Artifact", text: "Sacrifice a creature: Add {C}{C}.", cmc: 3, colors: "", rarity: "uncommon" });

// ─── classifyCard ─────────────────────────────────────────────────────────────

describe("classifyCard", () => {
  it("deve identificar instant com dano como removal e direct_damage", () => {
    const tags = classifyCard(lightningBolt);
    expect(tags).toContain("instant");
    expect(tags).toContain("removal");
    expect(tags).toContain("direct_damage");
    expect(tags).toContain("low_cmc");
  });

  it("deve identificar counterspell", () => {
    const tags = classifyCard(counterspell);
    expect(tags).toContain("counter");
    expect(tags).toContain("instant");
    expect(tags).toContain("low_cmc");
  });

  it("deve identificar ramp", () => {
    const tags = classifyCard(llanowarElves);
    expect(tags).toContain("creature");
    expect(tags).toContain("ramp");
    expect(tags).toContain("low_cmc");
  });

  it("deve identificar draw", () => {
    const tags = classifyCard(brainstorm);
    expect(tags).toContain("draw");
    expect(tags).toContain("instant");
  });

  it("deve identificar terreno", () => {
    const tags = classifyCard(mountain);
    expect(tags).toContain("land");
    expect(tags).not.toContain("creature");
    expect(tags).not.toContain("instant");
  });

  it("deve identificar haste", () => {
    const tags = classifyCard(goblinGuide);
    expect(tags).toContain("haste");
    expect(tags).toContain("creature");
  });

  it("deve identificar flash", () => {
    const tags = classifyCard(snapcaster);
    expect(tags).toContain("flash");
    expect(tags).toContain("graveyard");
  });

  it("deve identificar graveyard recursion", () => {
    const tags = classifyCard(gravedigger);
    expect(tags).toContain("graveyard");
  });

  it("deve identificar tutor", () => {
    const tags = classifyCard(demonic);
    expect(tags).toContain("tutor");
  });

  it("deve identificar token", () => {
    const tags = classifyCard(goblinToken);
    expect(tags).toContain("token");
  });

  it("deve identificar sacrifice", () => {
    const tags = classifyCard(sacrifice);
    expect(tags).toContain("sacrifice");
  });

  it("deve marcar CMC alto como high_cmc", () => {
    const heavyCard = makeCard({ cmc: 7 });
    const tags = classifyCard(heavyCard);
    expect(tags).toContain("high_cmc");
    expect(tags).toContain("big_threat");
    expect(tags).not.toContain("low_cmc");
  });
});

// ─── filterCards ──────────────────────────────────────────────────────────────

describe("filterCards", () => {
  const pool = [lightningBolt, counterspell, llanowarElves, mountain, island, forest, goblinGuide, gravedigger];

  it("deve filtrar por cor", () => {
    const result = filterCards(pool, { colors: ["R"] });
    const names = result.map((c) => c.name);
    expect(names).toContain("Lightning Bolt");
    expect(names).toContain("Goblin Guide");
    expect(names).not.toContain("Counterspell");
    expect(names).not.toContain("Llanowar Elves");
    // Terrenos são sempre incluídos
    expect(names).toContain("Mountain");
  });

  it("deve filtrar por múltiplas cores (OR)", () => {
    const result = filterCards(pool, { colors: ["R", "U"] });
    const names = result.map((c) => c.name);
    expect(names).toContain("Lightning Bolt");
    expect(names).toContain("Counterspell");
    expect(names).not.toContain("Llanowar Elves");
    expect(names).not.toContain("Gravedigger");
  });

  it("deve filtrar por tribo", () => {
    const result = filterCards(pool, { tribes: ["Goblin"] });
    const names = result.map((c) => c.name);
    expect(names).toContain("Goblin Guide");
    expect(names).not.toContain("Lightning Bolt");
  });

  it("deve filtrar por tipo de carta", () => {
    const result = filterCards(pool, { cardTypes: ["instant"] });
    const names = result.map((c) => c.name);
    expect(names).toContain("Lightning Bolt");
    expect(names).toContain("Counterspell");
    expect(names).not.toContain("Llanowar Elves");
    expect(names).not.toContain("Goblin Guide");
  });

  it("deve excluir terrenos quando excludeLands=true", () => {
    const result = filterCards(pool, { excludeLands: true });
    const names = result.map((c) => c.name);
    expect(names).not.toContain("Mountain");
    expect(names).not.toContain("Island");
    expect(names).not.toContain("Forest");
  });

  it("deve retornar pool completo sem filtros", () => {
    const result = filterCards(pool, {});
    expect(result.length).toBe(pool.length);
  });

  it("deve retornar vazio quando nenhuma carta corresponde", () => {
    const result = filterCards(pool, { tribes: ["Dragon"] });
    expect(result.length).toBe(0);
  });
});

// ─── scoreCardForArchetype ────────────────────────────────────────────────────

describe("scoreCardForArchetype", () => {
  it("deve dar score maior para cartas de baixo CMC em aggro", () => {
    const aggroTemplate = ARCHETYPES.aggro;
    const bolt = scoreCardForArchetype(lightningBolt, aggroTemplate);
    const heavy = scoreCardForArchetype(makeCard({ cmc: 6, type: "Creature", text: "" }), aggroTemplate);
    expect(bolt).toBeGreaterThan(heavy);
  });

  it("deve dar score maior para counterspell em control", () => {
    const controlTemplate = ARCHETYPES.control;
    const counter = scoreCardForArchetype(counterspell, controlTemplate);
    const goblin = scoreCardForArchetype(goblinGuide, controlTemplate);
    expect(counter).toBeGreaterThan(goblin);
  });

  it("deve dar score maior para ramp em ramp archetype", () => {
    const rampTemplate = ARCHETYPES.ramp;
    const elves = scoreCardForArchetype(llanowarElves, rampTemplate);
    const bolt = scoreCardForArchetype(lightningBolt, rampTemplate);
    expect(elves).toBeGreaterThan(bolt);
  });

  it("deve dar score maior para draw em combo", () => {
    const comboTemplate = ARCHETYPES.combo;
    const draw = scoreCardForArchetype(brainstorm, comboTemplate);
    const creature = scoreCardForArchetype(goblinGuide, comboTemplate);
    expect(draw).toBeGreaterThan(creature);
  });

  it("deve dar bônus por raridade mythic", () => {
    const template = ARCHETYPES.midrange;
    const mythic = scoreCardForArchetype(makeCard({ rarity: "mythic", cmc: 3, type: "Creature", text: "destroy" }), template);
    const common = scoreCardForArchetype(makeCard({ rarity: "common", cmc: 3, type: "Creature", text: "destroy" }), template);
    expect(mythic).toBeGreaterThan(common);
  });

  it("deve retornar score >= 0 para qualquer carta", () => {
    const cards = [lightningBolt, counterspell, llanowarElves, mountain, goblinGuide, gravedigger];
    for (const card of cards) {
      for (const archetype of Object.values(ARCHETYPES)) {
        expect(scoreCardForArchetype(card, archetype)).toBeGreaterThanOrEqual(0);
      }
    }
  });
});

// ─── generateDeckByArchetype ──────────────────────────────────────────────────

describe("generateDeckByArchetype", () => {
  // Pool de 100 cartas para testes
  const buildPool = (n: number): CardData[] => {
    const pool: CardData[] = [];
    // 20 terrenos
    for (let i = 0; i < 10; i++) pool.push({ ...mountain, id: i + 1000 });
    for (let i = 0; i < 10; i++) pool.push({ ...forest, id: i + 2000 });
    // 40 criaturas variadas
    for (let i = 0; i < 10; i++) pool.push({ ...goblinGuide, id: i + 3000, name: `Goblin ${i}` });
    for (let i = 0; i < 10; i++) pool.push({ ...llanowarElves, id: i + 4000, name: `Elf ${i}` });
    for (let i = 0; i < 10; i++) pool.push({ ...gravedigger, id: i + 5000, name: `Zombie ${i}` });
    for (let i = 0; i < 10; i++) pool.push({ ...snapcaster, id: i + 6000, name: `Wizard ${i}` });
    // 40 spells
    for (let i = 0; i < 10; i++) pool.push({ ...lightningBolt, id: i + 7000, name: `Bolt ${i}` });
    for (let i = 0; i < 10; i++) pool.push({ ...counterspell, id: i + 8000, name: `Counter ${i}` });
    for (let i = 0; i < 10; i++) pool.push({ ...brainstorm, id: i + 9000, name: `Draw ${i}` });
    for (let i = 0; i < 10; i++) pool.push({ ...demonic, id: i + 10000, name: `Tutor ${i}` });
    return pool.slice(0, n);
  };

  it("deve gerar deck de 60 cartas para standard", () => {
    const pool = buildPool(100);
    const result = generateDeckByArchetype(pool, { archetype: "aggro", format: "standard" });
    expect(result.deckSize).toBe(60);
  });

  it("deve gerar deck de 100 cartas para commander", () => {
    const pool = buildPool(100);
    const result = generateDeckByArchetype(pool, { archetype: "control", format: "commander" });
    expect(result.deckSize).toBe(100);
  });

  it("deve respeitar max 4 cópias em standard", () => {
    const pool = buildPool(100);
    const result = generateDeckByArchetype(pool, { archetype: "aggro", format: "standard" });
    for (const card of result.cards) {
      if (!card.type?.includes("Basic")) {
        expect(card.quantity).toBeLessThanOrEqual(4);
      }
    }
  });

  it("deve respeitar max 1 cópia em commander (não-básicas)", () => {
    const pool = buildPool(100);
    const result = generateDeckByArchetype(pool, { archetype: "combo", format: "commander" });
    for (const card of result.cards) {
      if (!card.type?.includes("Basic")) {
        expect(card.quantity).toBeLessThanOrEqual(1);
      }
    }
  });

  it("deve incluir terrenos no deck", () => {
    const pool = buildPool(100);
    const result = generateDeckByArchetype(pool, { archetype: "aggro", format: "standard" });
    const lands = result.cards.filter((c) => c.role === "land");
    expect(lands.length).toBeGreaterThan(0);
    const totalLands = lands.reduce((s, c) => s + c.quantity, 0);
    expect(totalLands).toBeGreaterThan(15);
  });

  it("deve retornar template correto do arquétipo", () => {
    const pool = buildPool(100);
    const result = generateDeckByArchetype(pool, { archetype: "control", format: "standard" });
    expect(result.template).toEqual(ARCHETYPES.control);
  });

  it("deve retornar poolSize correto (pool de estratégia, lands excluídos)", () => {
    // buildPool(80) → 20 lands + 40 creatures + 20 spells = 80 cards.
    // poolSize na source é filteredPool.length (spells+creatures; lands vão
    // para manaPool separado), então esperamos 60.
    const pool = buildPool(80);
    const result = generateDeckByArchetype(pool, { archetype: "midrange", format: "standard" });
    expect(result.poolSize).toBe(60); // 80 total - 20 lands = 60 strategic cards
  });

  it("deve filtrar por cor quando especificado", () => {
    const pool = buildPool(100);
    const result = generateDeckByArchetype(pool, {
      archetype: "aggro",
      format: "standard",
      colors: ["R"],
    });
    // Cartas não-terreno devem ser vermelhas ou incolores
    for (const card of result.cards) {
      if (!card.type?.includes("Land") && card.colors && card.colors.length > 0) {
        expect(card.colors).toMatch(/R/);
      }
    }
  });

  it("deve filtrar por tribo quando especificado", () => {
    const pool = buildPool(100);
    const result = generateDeckByArchetype(pool, {
      archetype: "aggro",
      format: "standard",
      tribes: ["Goblin"],
    });
    // Criaturas devem ser Goblins
    const creatures = result.cards.filter((c) => c.role === "creature");
    for (const c of creatures) {
      expect((c.type || "").toLowerCase()).toContain("goblin");
    }
  });

  it("deve emitir aviso quando pool é pequeno", () => {
    const tinyPool = buildPool(10);
    const result = generateDeckByArchetype(tinyPool, { archetype: "aggro", format: "standard" });
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it("deve gerar deck mesmo com pool vazio (usando terrenos básicos)", () => {
    const result = generateDeckByArchetype([], { archetype: "burn", format: "standard", colors: ["R"] });
    expect(result.deckSize).toBe(60);
    expect(result.warnings.length).toBeGreaterThan(0);
  });
});

// ─── FORMAT_RULES ─────────────────────────────────────────────────────────────

describe("FORMAT_RULES", () => {
  it("deve ter deckSize=60 para formatos não-commander", () => {
    const formats: (keyof typeof FORMAT_RULES)[] = ["standard", "historic", "modern", "legacy", "pioneer"];
    for (const f of formats) {
      expect(FORMAT_RULES[f].deckSize).toBe(60);
      expect(FORMAT_RULES[f].maxCopies).toBe(4);
    }
  });

  it("deve ter deckSize=100 e maxCopies=1 para commander", () => {
    expect(FORMAT_RULES.commander.deckSize).toBe(100);
    expect(FORMAT_RULES.commander.maxCopies).toBe(1);
  });
});

// ─── exportToArena ────────────────────────────────────────────────────────────

describe("exportToArena", () => {
  it("deve exportar no formato correto (quantidade nome)", () => {
    const cards = [
      { ...lightningBolt, quantity: 4, role: "spell" },
      { ...mountain, quantity: 20, role: "land" },
    ];
    const result = exportToArena(cards);
    expect(result).toContain("4 Lightning Bolt");
    expect(result).toContain("20 Mountain");
  });

  it("deve separar cartas por linha", () => {
    const cards = [
      { ...lightningBolt, quantity: 4, role: "spell" },
      { ...counterspell, quantity: 4, role: "spell" },
    ];
    const lines = exportToArena(cards).split("\n");
    expect(lines.length).toBe(2);
  });
});

// ─── exportToText ─────────────────────────────────────────────────────────────

describe("exportToText", () => {
  it("deve incluir cabeçalho com arquétipo e formato", () => {
    const cards = [{ ...lightningBolt, quantity: 4, role: "spell" }];
    const result = exportToText(cards, { archetype: "burn", format: "modern" });
    expect(result).toContain("BURN");
    expect(result).toContain("MODERN");
  });

  it("deve agrupar cartas por seção", () => {
    const cards = [
      { ...goblinGuide, quantity: 4, role: "creature" },
      { ...lightningBolt, quantity: 4, role: "spell" },
      { ...mountain, quantity: 20, role: "land" },
    ];
    const result = exportToText(cards, { archetype: "aggro", format: "standard" });
    expect(result).toContain("// Creatures");
    expect(result).toContain("// Spells");
    expect(result).toContain("// Lands");
  });
});
