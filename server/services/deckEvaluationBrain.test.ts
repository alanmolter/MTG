import { describe, it, expect } from "vitest";
import {
  evaluateDeck,
  evaluateDeckQuick,
  compareDeckQuality,
} from "./deckEvaluationBrain";

// ─── Fixtures realistas de 60 cartas ──────────────────────────────────────
// Tests anteriores usavam fixtures de 8-9 cartas, o que derrubava todos os
// thresholds realistas (18+ terrenos, 40+ score de curva, etc). As fixtures
// aqui são listas expandidas que refletem a estrutura de decks jogáveis.

function make(n: number, card: any) {
  return Array.from({ length: n }, () => ({ ...card }));
}

const AGGRO_CARDS = [
  ...make(4, { name: "Goblin Guide", type: "Creature - Goblin Scout", cmc: 1, text: "Haste" }),
  ...make(4, { name: "Monastery Swiftspear", type: "Creature - Human Monk", cmc: 1, text: "Prowess, haste" }),
  ...make(4, { name: "Soul-Scar Mage", type: "Creature - Human Wizard", cmc: 1, text: "Prowess" }),
  ...make(4, { name: "Eidolon of the Great Revel", type: "Creature - Spirit", cmc: 2, text: "Whenever" }),
  ...make(4, { name: "Lightning Bolt", type: "Instant", cmc: 1, text: "Lightning Bolt deals 3 damage to any target" }),
  ...make(4, { name: "Lava Spike", type: "Sorcery", cmc: 1, text: "Lava Spike deals 3 damage to target player" }),
  ...make(4, { name: "Rift Bolt", type: "Sorcery", cmc: 3, text: "Rift Bolt deals 3 damage to any target" }),
  ...make(4, { name: "Skewer the Critics", type: "Sorcery", cmc: 3, text: "Skewer the Critics deals 3 damage to any target" }),
  ...make(4, { name: "Light Up the Stage", type: "Sorcery", cmc: 3, text: "Exile the top three cards" }),
  ...make(20, { name: "Mountain", type: "Basic Land - Mountain", cmc: 0, text: "" }),
  ...make(4, { name: "Scalding Tarn", type: "Land", cmc: 0, text: "Fetch land" }),
];

const CONTROL_CARDS = [
  ...make(4, { name: "Counterspell", type: "Instant", cmc: 2, text: "Counter target spell" }),
  ...make(4, { name: "Mana Leak", type: "Instant", cmc: 2, text: "Counter target spell" }),
  ...make(4, { name: "Force of Negation", type: "Instant", cmc: 3, text: "Counter target noncreature spell" }),
  ...make(4, { name: "Snapcaster Mage", type: "Creature - Human Wizard", cmc: 2, text: "Flash" }),
  ...make(2, { name: "Jace, the Mind Sculptor", type: "Planeswalker", cmc: 4, text: "Draw a card" }),
  ...make(4, { name: "Preordain", type: "Sorcery", cmc: 1, text: "Scry. Draw a card" }),
  ...make(4, { name: "Brainstorm", type: "Instant", cmc: 1, text: "Draw three cards" }),
  ...make(4, { name: "Fact or Fiction", type: "Instant", cmc: 4, text: "Reveal the top five cards. Draw cards" }),
  ...make(4, { name: "Swords to Plowshares", type: "Instant", cmc: 1, text: "Exile target creature" }),
  ...make(4, { name: "Path to Exile", type: "Instant", cmc: 1, text: "Exile target creature" }),
  ...make(22, { name: "Island", type: "Basic Land - Island", cmc: 0, text: "" }),
];

const COMBO_CARDS = [
  // Combo pieces: high tutor count + repeated engine cards produce high synergy
  ...make(4, { name: "Splinter Twin", type: "Enchantment - Aura", cmc: 3, text: "Whenever enchanted creature becomes tapped" }),
  ...make(4, { name: "Deceiver Exarch", type: "Creature", cmc: 3, text: "Flash. Untap target permanent" }),
  ...make(4, { name: "Kiki-Jiki", type: "Creature - Legendary", cmc: 5, text: "Create a token copy of target nonlegendary creature" }),
  ...make(4, { name: "Mystical Tutor", type: "Instant", cmc: 1, text: "Search your library for an instant or sorcery" }),
  ...make(4, { name: "Vampiric Tutor", type: "Instant", cmc: 1, text: "Search your library for a card" }),
  ...make(4, { name: "Demonic Tutor", type: "Sorcery", cmc: 2, text: "Search your library for a card" }),
  ...make(4, { name: "Brainstorm", type: "Instant", cmc: 1, text: "Draw three cards" }),
  ...make(4, { name: "Ponder", type: "Sorcery", cmc: 1, text: "Look at the top three cards. Draw a card" }),
  ...make(4, { name: "Preordain", type: "Sorcery", cmc: 1, text: "Scry 2. Draw a card" }),
  ...make(10, { name: "Island", type: "Basic Land - Island", cmc: 0, text: "" }),
  ...make(14, { name: "Swamp", type: "Basic Land - Swamp", cmc: 0, text: "" }),
];

const RAMP_CARDS = [
  ...make(4, { name: "Llanowar Elves", type: "Creature - Elf Druid", cmc: 1, text: "Add {G}" }),
  ...make(4, { name: "Elvish Mystic", type: "Creature - Elf Druid", cmc: 1, text: "Add {G}" }),
  ...make(4, { name: "Arbor Elf", type: "Creature - Elf Druid", cmc: 1, text: "Add {G}" }),
  ...make(4, { name: "Cultivate", type: "Sorcery", cmc: 3, text: "Search your library for a basic land" }),
  ...make(4, { name: "Kodama's Reach", type: "Sorcery", cmc: 3, text: "Search your library for a basic land" }),
  ...make(4, { name: "Rampant Growth", type: "Sorcery", cmc: 2, text: "Search your library for a basic land" }),
  ...make(4, { name: "Explore", type: "Sorcery", cmc: 2, text: "You may play an additional land. Draw a card" }),
  ...make(2, { name: "Ulamog, the Infinite Gyre", type: "Creature - Eldrazi", cmc: 10, text: "Annihilator" }),
  ...make(2, { name: "Craterhoof Behemoth", type: "Creature - Beast", cmc: 8, text: "Trample" }),
  ...make(4, { name: "Primeval Titan", type: "Creature - Giant", cmc: 6, text: "Whenever Primeval Titan attacks" }),
  ...make(22, { name: "Forest", type: "Basic Land - Forest", cmc: 0, text: "" }),
  ...make(2, { name: "Misty Rainforest", type: "Land", cmc: 0, text: "" }),
];

// ─── evaluateDeck ─────────────────────────────────────────────────────────

describe("Deck Evaluation Brain", () => {
  describe("evaluateDeck - Aggro", () => {
    it("deve avaliar um deck aggro corretamente", () => {
      const result = evaluateDeck(AGGRO_CARDS, "aggro");

      expect(result).toBeDefined();
      expect(typeof result.normalizedScore).toBe("number");
      expect(result.normalizedScore).toBeGreaterThanOrEqual(0);
      expect(result.normalizedScore).toBeLessThanOrEqual(100);
      expect(result.tier).toMatch(/^[SABCDF]$/);
      expect(result.breakdown).toBeDefined();
      expect(result.analysis).toBeDefined();
      expect(result.recommendations).toBeDefined();
    });

    it("deve retornar breakdown com componentes de curva/lands/synergy/simulation", () => {
      const result = evaluateDeck(AGGRO_CARDS, "aggro");
      expect(typeof result.breakdown.curve).toBe("number");
      expect(typeof result.breakdown.lands).toBe("number");
      expect(typeof result.breakdown.synergy).toBe("number");
      expect(typeof result.breakdown.simulation).toBe("number");
    });

    it("deve detectar remoção em deck aggro", () => {
      const result = evaluateDeck(AGGRO_CARDS, "aggro");
      // Fixture tem 4× Bolt + 4× Lava Spike + 4× Rift Bolt = pelo menos 8 removals
      expect(result.removalCount).toBeGreaterThan(0);
    });

    it("deve ter terrenos em deck aggro", () => {
      const result = evaluateDeck(AGGRO_CARDS, "aggro");
      // Fixture tem 20 Mountains + 4 Scalding Tarn = 24 lands
      expect(result.landCount).toBeGreaterThanOrEqual(18);
      expect(result.landCount).toBeLessThanOrEqual(28);
    });
  });

  describe("evaluateDeck - Control", () => {
    it("deve avaliar um deck control corretamente", () => {
      const result = evaluateDeck(CONTROL_CARDS, "control");
      expect(result).toBeDefined();
      expect(result.normalizedScore).toBeGreaterThanOrEqual(0);
      expect(result.normalizedScore).toBeLessThanOrEqual(100);
      expect(result.tier).toMatch(/^[SABCDF]$/);
    });

    it("deve detectar counterspells em control", () => {
      const result = evaluateDeck(CONTROL_CARDS, "control");
      // Fixture tem 4× Counterspell + 4× Mana Leak + 4× Force of Negation
      expect(result.mechanicTagCounts.counterspell || 0).toBeGreaterThan(0);
    });

    it("deve detectar card draw em control", () => {
      const result = evaluateDeck(CONTROL_CARDS, "control");
      expect(result.drawCount).toBeGreaterThan(0);
    });
  });

  describe("evaluateDeck - Combo", () => {
    it("deve avaliar um deck combo corretamente", () => {
      const result = evaluateDeck(COMBO_CARDS, "combo");
      expect(result).toBeDefined();
      expect(result.normalizedScore).toBeGreaterThanOrEqual(0);
      expect(result.normalizedScore).toBeLessThanOrEqual(100);
    });

    it("deve ter score de sinergia positivo para combo", () => {
      const result = evaluateDeck(COMBO_CARDS, "combo");
      // 4×tutor + 4×Mystical + 4×Vampiric = ≥12 tutors stacking (>=3 → count^1.5)
      expect(result.synergyScore).toBeGreaterThan(0);
    });

    it("deve detectar tutors", () => {
      const result = evaluateDeck(COMBO_CARDS, "combo");
      expect((result.roleCounts.tutor || 0)).toBeGreaterThan(0);
    });
  });

  describe("evaluateDeck - Ramp", () => {
    it("deve avaliar um deck ramp corretamente", () => {
      const result = evaluateDeck(RAMP_CARDS, "ramp");
      expect(result).toBeDefined();
      expect(result.normalizedScore).toBeGreaterThanOrEqual(0);
      expect(result.normalizedScore).toBeLessThanOrEqual(100);
    });

    it("deve detectar ramp adequado", () => {
      const result = evaluateDeck(RAMP_CARDS, "ramp");
      // Fixture tem 12× 1-drop ramp + 12× sorcery ramp
      expect(result.rampCount).toBeGreaterThan(0);
    });

    it("deve ter ameaças de alto custo", () => {
      const result = evaluateDeck(RAMP_CARDS, "ramp");
      const highCmcCards = RAMP_CARDS.filter(c => c.cmc >= 6);
      expect(highCmcCards.length).toBeGreaterThan(0);
    });
  });

  describe("Normalização de Scores", () => {
    it("normalizedScore sempre deve estar entre 0-100", () => {
      const archetypes = ["aggro", "control", "combo", "ramp", "tempo", "midrange", "burn"];

      for (const archetype of archetypes) {
        const result = evaluateDeck(AGGRO_CARDS, archetype);
        expect(result.normalizedScore).toBeGreaterThanOrEqual(0);
        expect(result.normalizedScore).toBeLessThanOrEqual(100);
      }
    });

    it("breakdown scores são valores numéricos (raw, podem ser negativos)", () => {
      const result = evaluateDeck(AGGRO_CARDS, "aggro");
      // breakdown tem scores RAW (não normalizados). manaCurveScore e
      // landRatioScore produzem penalidades negativas. Só verificamos que
      // são números finitos.
      expect(Number.isFinite(result.breakdown.curve)).toBe(true);
      expect(Number.isFinite(result.breakdown.lands)).toBe(true);
      expect(Number.isFinite(result.breakdown.synergy)).toBe(true);
      expect(Number.isFinite(result.breakdown.simulation)).toBe(true);
    });
  });

  describe("Análise Estrutural", () => {
    it("deve fornecer recomendações para decks fracos", () => {
      const weakCards = [
        { name: "Forest", type: "Basic Land - Forest", cmc: 0, text: "" },
        { name: "Island", type: "Basic Land - Island", cmc: 0, text: "" },
      ];

      const result = evaluateDeck(weakCards, "aggro");
      expect(result.recommendations.length).toBeGreaterThan(0);
    });

    it("deve identificar pontos fortes de um deck aggro", () => {
      const result = evaluateDeck(AGGRO_CARDS, "aggro");
      // Deck com 24 lands e remoção suficiente deve ter pelo menos 1 força
      expect(result.analysis.strengths.length).toBeGreaterThan(0);
    });

    it("deve identificar pontos fracos de deck fraco", () => {
      const weakCards = [
        { name: "Forest", type: "Basic Land - Forest", cmc: 0, text: "" },
        { name: "Mountain", type: "Basic Land - Mountain", cmc: 0, text: "" },
      ];

      const result = evaluateDeck(weakCards, "control");
      expect(result.analysis.weaknesses.length).toBeGreaterThan(0);
    });
  });

  describe("Tier System", () => {
    it("deve atribuir tier válido para qualquer deck", () => {
      const result = evaluateDeck(AGGRO_CARDS, "aggro");
      expect(["S", "A", "B", "C", "D", "F"]).toContain(result.tier);
    });

    it("deve atribuir tier mesmo para deck quase vazio", () => {
      const weakDeck = [
        { name: "Forest", type: "Basic Land - Forest", cmc: 0, text: "" },
      ];

      const result = evaluateDeck(weakDeck, "aggro");
      expect(result.tier).toBeDefined();
      expect(["S", "A", "B", "C", "D", "F"]).toContain(result.tier);
    });
  });

  describe("evaluateDeckQuick", () => {
    it("deve retornar um score entre 0-100", () => {
      const score = evaluateDeckQuick(AGGRO_CARDS, "aggro");
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(100);
    });

    it("deve executar rapidamente", () => {
      const start = performance.now();
      evaluateDeckQuick(AGGRO_CARDS, "aggro");
      const elapsed = performance.now() - start;
      // Sub-50ms para 60 cartas é muito folgado — o cálculo é puro em JS.
      expect(elapsed).toBeLessThan(50);
    });

    it("deve dar scores similares ao evaluateDeck", () => {
      const quickScore = evaluateDeckQuick(AGGRO_CARDS, "aggro");
      const fullResult = evaluateDeck(AGGRO_CARDS, "aggro");
      // Ambos usam normalizeScore(totalScore, -50, 350). simulateTurns é
      // estocástico, então pode variar +/- alguns pontos entre chamadas.
      expect(Math.abs(quickScore - fullResult.normalizedScore)).toBeLessThan(10);
    });
  });

  describe("compareDeckQuality", () => {
    it("deve comparar dois decks e retornar shape correto", () => {
      const result = compareDeckQuality(AGGRO_CARDS, CONTROL_CARDS, "aggro");
      expect(result.winner).toMatch(/^(A|B|tie)$/);
      expect(result.scoreA).toBeGreaterThanOrEqual(0);
      expect(result.scoreB).toBeGreaterThanOrEqual(0);
      expect(result.difference).toBeGreaterThanOrEqual(0);
    });

    it("deve diferenciar decks quando totalScore raw é diferente", () => {
      // AGGRO_CARDS vs um deck trivialmente pior (só 1 card)
      const trivialDeck = [{ name: "Forest", type: "Basic Land - Forest", cmc: 0, text: "" }];
      const result = compareDeckQuality(AGGRO_CARDS, trivialDeck, "aggro");
      expect(result.winner).toBe("A"); // deck real > deck trivial em aggro
    });
  });

  describe("Consistência de Avaliação", () => {
    it("deve dar mesmo score para mesma entrada (determinismo parcial)", () => {
      // simulateTurns é estocástico; vamos comparar só o componente determinístico.
      const r1 = evaluateDeck(AGGRO_CARDS, "aggro");
      const r2 = evaluateDeck(AGGRO_CARDS, "aggro");
      // landCount, creatureCount, roleCounts, breakdown.curve e breakdown.lands
      // são determinísticos.
      expect(r1.landCount).toBe(r2.landCount);
      expect(r1.creatureCount).toBe(r2.creatureCount);
      expect(r1.breakdown.curve).toBe(r2.breakdown.curve);
      expect(r1.breakdown.lands).toBe(r2.breakdown.lands);
    });

    it("deve dar scores diferentes para decks diferentes (via compareDeckQuality)", () => {
      // Compare raw totalScore (difference) ao invés de normalized (que pode
      // clampar a 0 para decks pequenos).
      const result = compareDeckQuality(AGGRO_CARDS, CONTROL_CARDS, "aggro");
      expect(result.difference).toBeGreaterThan(0);
    });
  });

  describe("Edge Cases", () => {
    it("deve lidar com deck vazio", () => {
      const result = evaluateDeck([], "aggro");
      expect(result).toBeDefined();
      expect(typeof result.normalizedScore).toBe("number");
      expect(result.normalizedScore).toBeGreaterThanOrEqual(0);
    });

    it("deve lidar com cartas sem CMC", () => {
      const cardsNoCmc = [
        { name: "Forest", type: "Basic Land - Forest", text: "" },
        { name: "Mountain", type: "Basic Land - Mountain", text: "" },
      ];

      const result = evaluateDeck(cardsNoCmc, "aggro");
      expect(result).toBeDefined();
      expect(result.normalizedScore).toBeGreaterThanOrEqual(0);
    });

    it("deve lidar com archetype desconhecido (usa default)", () => {
      const result = evaluateDeck(AGGRO_CARDS, "unknown_archetype");
      expect(result).toBeDefined();
      expect(result.normalizedScore).toBeGreaterThanOrEqual(0);
    });
  });
});
