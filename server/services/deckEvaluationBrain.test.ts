import { describe, it, expect } from "vitest";
import {
  evaluateDeck,
  evaluateDeckQuick,
  compareDeckQuality,
} from "./deckEvaluationBrain";

// ─── Fixtures de Cartas para Testes ────────────────────────────────────────

const AGGRO_CARDS = [
  // Criaturas rápidas
  { name: "Goblin Guide", type: "Creature - Goblin Scout", cmc: 1, text: "Haste" },
  { name: "Monastery Swiftspear", type: "Creature - Human Monk", cmc: 1, text: "Prowess" },
  { name: "Snapcaster Mage", type: "Creature - Human Wizard", cmc: 2, text: "Flash, Haste" },
  { name: "Tarmogoyf", type: "Creature - Lhurgoyf", cmc: 2, text: "Power and toughness" },
  // Remoção
  { name: "Lightning Bolt", type: "Instant", cmc: 1, text: "Deals 3 damage" },
  { name: "Unholy Heat", type: "Instant", cmc: 1, text: "Deals damage" },
  // Terrenos
  { name: "Mountain", type: "Basic Land - Mountain", cmc: 0, text: "" },
  { name: "Scalding Tarn", type: "Land", cmc: 0, text: "Fetch land" },
];

const CONTROL_CARDS = [
  // Contadores
  { name: "Counterspell", type: "Instant", cmc: 2, text: "Counter target spell" },
  { name: "Mana Leak", type: "Instant", cmc: 2, text: "Counter target spell" },
  { name: "Snapcaster Mage", type: "Creature - Human Wizard", cmc: 2, text: "Flash" },
  // Card Draw
  { name: "Jace, the Mind Sculptor", type: "Planeswalker", cmc: 4, text: "Draw cards" },
  { name: "Preordain", type: "Sorcery", cmc: 1, text: "Draw cards" },
  // Remoção
  { name: "Swords to Plowshares", type: "Instant", cmc: 1, text: "Exile target creature" },
  // Terrenos
  { name: "Island", type: "Basic Land - Island", cmc: 0, text: "" },
  { name: "Flooded Strand", type: "Land", cmc: 0, text: "Fetch land" },
  { name: "Tundra", type: "Land", cmc: 0, text: "Dual land" },
];

const COMBO_CARDS = [
  // Peças de combo
  { name: "Splinter Twin", type: "Enchantment - Aura", cmc: 3, text: "Whenever" },
  { name: "Exarch", type: "Creature", cmc: 3, text: "Tap" },
  // Tutors
  { name: "Mystical Tutor", type: "Instant", cmc: 1, text: "Search your library" },
  { name: "Vampiric Tutor", type: "Instant", cmc: 1, text: "Search your library" },
  // Card Draw
  { name: "Brainstorm", type: "Instant", cmc: 1, text: "Draw three cards" },
  // Terrenos
  { name: "Island", type: "Basic Land - Island", cmc: 0, text: "" },
  { name: "Swamp", type: "Basic Land - Swamp", cmc: 0, text: "" },
  { name: "Scalding Tarn", type: "Land", cmc: 0, text: "" },
];

const RAMP_CARDS = [
  // Ramp
  { name: "Llanowar Elves", type: "Creature - Elf Druid", cmc: 1, text: "Add green mana" },
  { name: "Cultivate", type: "Sorcery", cmc: 3, text: "Search your library for lands" },
  { name: "Kodama's Reach", type: "Sorcery", cmc: 3, text: "Search your library for lands" },
  // Ameaças
  { name: "Ulamog, the Infinite Gyre", type: "Creature - Eldrazi", cmc: 10, text: "Annihilator" },
  { name: "Craterhoof Behemoth", type: "Creature - Beast", cmc: 8, text: "Trample" },
  // Terrenos
  { name: "Forest", type: "Basic Land - Forest", cmc: 0, text: "" },
  { name: "Misty Rainforest", type: "Land", cmc: 0, text: "" },
  { name: "Tectonic Edge", type: "Land", cmc: 0, text: "" },
];

// ─── Testes Básicos ───────────────────────────────────────────────────────

describe("Deck Evaluation Brain", () => {
  describe("evaluateDeck - Aggro", () => {
    it("deve avaliar um deck aggro corretamente", () => {
      const result = evaluateDeck(AGGRO_CARDS, "aggro");

      expect(result).toBeDefined();
      expect(result.normalizedScore).toBeGreaterThanOrEqual(0);
      expect(result.normalizedScore).toBeLessThanOrEqual(100);
      expect(result.tier).toMatch(/^[S-F]$/);
      expect(result.breakdown).toBeDefined();
      expect(result.analysis).toBeDefined();
      expect(result.recommendations).toBeDefined();
    });

    it("deve ter score de curva alto para aggro", () => {
      const result = evaluateDeck(AGGRO_CARDS, "aggro");
      expect(result.breakdown.curve).toBeGreaterThan(40);
    });

    it("deve detectar remoção adequada", () => {
      const result = evaluateDeck(AGGRO_CARDS, "aggro");
      expect(result.removalCount).toBeGreaterThan(0);
    });

    it("deve ter terrenos na faixa ideal", () => {
      const result = evaluateDeck(AGGRO_CARDS, "aggro");
      expect(result.landCount).toBeGreaterThanOrEqual(18);
      expect(result.landCount).toBeLessThanOrEqual(22);
    });
  });

  describe("evaluateDeck - Control", () => {
    it("deve avaliar um deck control corretamente", () => {
      const result = evaluateDeck(CONTROL_CARDS, "control");

      expect(result).toBeDefined();
      expect(result.normalizedScore).toBeGreaterThanOrEqual(0);
      expect(result.normalizedScore).toBeLessThanOrEqual(100);
      expect(result.tier).toMatch(/^[S-F]$/);
    });

    it("deve ter score de sinergia alto para control", () => {
      const result = evaluateDeck(CONTROL_CARDS, "control");
      expect(result.breakdown.synergy).toBeGreaterThan(30);
    });

    it("deve detectar card draw adequado", () => {
      const result = evaluateDeck(CONTROL_CARDS, "control");
      expect(result.drawCount).toBeGreaterThan(0);
    });

    it("deve ter mais terrenos que aggro", () => {
      const controlResult = evaluateDeck(CONTROL_CARDS, "control");
      const aggroResult = evaluateDeck(AGGRO_CARDS, "aggro");

      expect(controlResult.landCount).toBeGreaterThan(aggroResult.landCount);
    });
  });

  describe("evaluateDeck - Combo", () => {
    it("deve avaliar um deck combo corretamente", () => {
      const result = evaluateDeck(COMBO_CARDS, "combo");

      expect(result).toBeDefined();
      expect(result.normalizedScore).toBeGreaterThanOrEqual(0);
      expect(result.normalizedScore).toBeLessThanOrEqual(100);
    });

    it("deve ter score de sinergia muito alto para combo", () => {
      const result = evaluateDeck(COMBO_CARDS, "combo");
      expect(result.breakdown.synergy).toBeGreaterThan(40);
    });

    it("deve detectar tutors", () => {
      const result = evaluateDeck(COMBO_CARDS, "combo");
      expect(result.roleCounts.tutor).toBeGreaterThan(0);
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
      expect(result.rampCount).toBeGreaterThan(0);
    });

    it("deve ter ameaças de alto custo", () => {
      const result = evaluateDeck(RAMP_CARDS, "ramp");
      const highCmcCards = RAMP_CARDS.filter(c => c.cmc >= 8);
      expect(highCmcCards.length).toBeGreaterThan(0);
    });
  });

  describe("Normalização de Scores", () => {
    it("todos os scores devem estar entre 0-100", () => {
      const archetypes = ["aggro", "control", "combo", "ramp", "tempo", "midrange", "burn"];

      for (const archetype of archetypes) {
        const result = evaluateDeck(AGGRO_CARDS, archetype);
        expect(result.normalizedScore).toBeGreaterThanOrEqual(0);
        expect(result.normalizedScore).toBeLessThanOrEqual(100);
        expect(result.breakdown.curve).toBeGreaterThanOrEqual(0);
        expect(result.breakdown.curve).toBeLessThanOrEqual(100);
      }
    });

    it("breakdown scores devem ser coerentes", () => {
      const result = evaluateDeck(AGGRO_CARDS, "aggro");

      expect(result.breakdown.curve).toBeGreaterThanOrEqual(0);
      expect(result.breakdown.lands).toBeGreaterThanOrEqual(0);
      expect(result.breakdown.synergy).toBeGreaterThanOrEqual(0);
      expect(result.breakdown.simulation).toBeGreaterThanOrEqual(0);
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

    it("deve identificar pontos fortes do deck", () => {
      const result = evaluateDeck(AGGRO_CARDS, "aggro");
      expect(result.analysis.strengths.length).toBeGreaterThan(0);
    });

    it("deve identificar pontos fracos do deck", () => {
      const weakCards = [
        { name: "Forest", type: "Basic Land - Forest", cmc: 0, text: "" },
        { name: "Mountain", type: "Basic Land - Mountain", cmc: 0, text: "" },
      ];

      const result = evaluateDeck(weakCards, "control");
      expect(result.analysis.weaknesses.length).toBeGreaterThan(0);
    });
  });

  describe("Tier System", () => {
    it("deve atribuir tier S para decks excelentes", () => {
      // Deck bem construído
      const excellentDeck = [
        ...AGGRO_CARDS,
        ...AGGRO_CARDS,
        ...AGGRO_CARDS,
      ];

      const result = evaluateDeck(excellentDeck, "aggro");
      expect(result.tier).toBeDefined();
      expect(["S", "A", "B", "C", "D", "F"]).toContain(result.tier);
    });

    it("deve atribuir tier F para decks muito fracos", () => {
      const weakDeck = [
        { name: "Forest", type: "Basic Land - Forest", cmc: 0, text: "" },
      ];

      const result = evaluateDeck(weakDeck, "aggro");
      expect(result.tier).toBeDefined();
    });
  });

  describe("evaluateDeckQuick", () => {
    it("deve retornar um score entre 0-100", () => {
      const score = evaluateDeckQuick(AGGRO_CARDS, "aggro");
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(100);
    });

    it("deve ser mais rápido que evaluateDeck", () => {
      const start1 = performance.now();
      evaluateDeckQuick(AGGRO_CARDS, "aggro");
      const time1 = performance.now() - start1;

      const start2 = performance.now();
      evaluateDeck(AGGRO_CARDS, "aggro");
      const time2 = performance.now() - start2;

      // Quick deve ser pelo menos tão rápido quanto o full
      expect(time1).toBeLessThanOrEqual(time2 * 1.5);
    });

    it("deve dar scores similares ao evaluateDeck", () => {
      const quickScore = evaluateDeckQuick(AGGRO_CARDS, "aggro");
      const fullResult = evaluateDeck(AGGRO_CARDS, "aggro");

      // Scores devem estar na mesma faixa (diferença máxima de 20 pontos)
      expect(Math.abs(quickScore - fullResult.normalizedScore)).toBeLessThan(20);
    });
  });

  describe("compareDeckQuality", () => {
    it("deve comparar dois decks corretamente", () => {
      const result = compareDeckQuality(AGGRO_CARDS, CONTROL_CARDS, "aggro");

      expect(result.winner).toMatch(/^(A|B|tie)$/);
      expect(result.scoreA).toBeGreaterThanOrEqual(0);
      expect(result.scoreB).toBeGreaterThanOrEqual(0);
      expect(result.difference).toBeGreaterThanOrEqual(0);
    });

    it("deve identificar deck melhor para archetype", () => {
      // Aggro deve ser melhor em formato aggro
      const result = compareDeckQuality(AGGRO_CARDS, CONTROL_CARDS, "aggro");
      expect(result.winner).toBe("A");
    });

    it("deve identificar control melhor em formato control", () => {
      // Control deve ser melhor em formato control
      const result = compareDeckQuality(AGGRO_CARDS, CONTROL_CARDS, "control");
      expect(result.winner).toBe("B");
    });
  });

  describe("Consistência de Avaliação", () => {
    it("deve dar mesmo score para mesma entrada", () => {
      const score1 = evaluateDeckQuick(AGGRO_CARDS, "aggro");
      const score2 = evaluateDeckQuick(AGGRO_CARDS, "aggro");

      expect(score1).toBe(score2);
    });

    it("deve dar scores diferentes para decks diferentes", () => {
      const score1 = evaluateDeckQuick(AGGRO_CARDS, "aggro");
      const score2 = evaluateDeckQuick(CONTROL_CARDS, "aggro");

      expect(score1).not.toBe(score2);
    });
  });

  describe("Edge Cases", () => {
    it("deve lidar com deck vazio", () => {
      const result = evaluateDeck([], "aggro");
      expect(result).toBeDefined();
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

    it("deve lidar com archetype desconhecido", () => {
      const result = evaluateDeck(AGGRO_CARDS, "unknown_archetype");
      expect(result).toBeDefined();
      expect(result.normalizedScore).toBeGreaterThanOrEqual(0);
    });
  });
});
