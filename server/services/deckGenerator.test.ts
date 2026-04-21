import { describe, it, expect } from "vitest";
import { validateDeck, evaluateDeckWithEngine } from "./deckGenerator";
import type { Card } from "../../drizzle/schema";

const mockCard = (
  id: number,
  name: string,
  type: string,
  cmc: number = 2,
): Card & { quantity: number } => ({
  id,
  scryfallId: `mock-${id}`,
  name,
  type,
  colors: "U",
  cmc,
  rarity: "common",
  imageUrl: null,
  power: null,
  toughness: null,
  text: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  quantity: 1,
});

describe("validateDeck", () => {
  it("should validate a valid Standard deck with 60 cards", () => {
    const cards = Array.from({ length: 60 }, (_, i) => ({
      ...mockCard(i, `Card ${i}`, "Creature"),
      quantity: 1,
    }));

    const result = validateDeck(cards, "standard");

    expect(result.isValid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("should reject a Standard deck with less than 60 cards", () => {
    const cards = Array.from({ length: 30 }, (_, i) => ({
      ...mockCard(i, `Card ${i}`, "Creature"),
      quantity: 1,
    }));

    const result = validateDeck(cards, "standard");

    expect(result.isValid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toContain("60 cartas");
  });

  it("should reject cards with more than 4 copies in Standard", () => {
    const cards = [
      {
        ...mockCard(1, "Lightning Bolt", "Instant"),
        quantity: 5,
      },
    ];

    const result = validateDeck(cards, "standard");

    expect(result.isValid).toBe(false);
    expect(result.errors.some((e) => e.includes("máximo 4"))).toBe(true);
  });

  it("should validate a valid Commander deck with 100 cards", () => {
    const cards = Array.from({ length: 100 }, (_, i) => ({
      ...mockCard(i, `Card ${i}`, i === 0 ? "Creature" : "Instant"),
      quantity: 1,
    }));

    const result = validateDeck(cards, "commander");

    expect(result.isValid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("should reject a Commander deck with less than 100 cards", () => {
    const cards = Array.from({ length: 50 }, (_, i) => ({
      ...mockCard(i, `Card ${i}`, "Creature"),
      quantity: 1,
    }));

    const result = validateDeck(cards, "commander");

    expect(result.isValid).toBe(false);
    expect(result.errors[0]).toContain("100 cartas");
  });

  it("should reject non-basic cards with more than 1 copy in Commander", () => {
    const cards = [
      {
        ...mockCard(1, "Lightning Bolt", "Instant"),
        quantity: 2,
      },
    ];

    const result = validateDeck(cards, "commander");

    expect(result.isValid).toBe(false);
    expect(result.errors.some((e) => e.includes("máximo 1"))).toBe(true);
  });

  it("should warn about unbalanced color distribution", () => {
    const cards = Array.from({ length: 60 }, (_, i) => ({
      ...mockCard(i, `Card ${i}`, "Creature", 2),
      colors: i < 50 ? "U" : "W", // 50 blue, 10 white
      quantity: 1,
    }));

    const result = validateDeck(cards, "standard");

    expect(result.warnings.some((w) => w.includes("desbalanceada"))).toBe(true);
  });

  it("should allow basic lands with more than 4 copies", () => {
    const cards = [
      {
        ...mockCard(1, "Island", "Basic Land"),
        quantity: 10,
      },
    ];

    const result = validateDeck(cards, "standard");

    // Should not error on basic lands
    expect(result.errors.some((e) => e.includes("Island"))).toBe(false);
  });
});

// NOTE: the original test file imported a `generateDeck` symbol that does not
// exist in deckGenerator.ts. The real API exposes `generateInitialDeck` which
// has a completely different signature and pulls on many downstream services
// (embeddings, synergy, modelLearning, DB-level getCardsByIds). End-to-end
// testing of that path belongs in an integration test, not a unit test, so we
// drop the misdesigned block and focus unit coverage here on the pure functions.

describe("evaluateDeckWithEngine", () => {
  it("should evaluate a deck and return metrics with a totalScore + breakdown", () => {
    const mockCards = [
      { ...mockCard(1, "Lightning Bolt", "Instant", 1), quantity: 4 },
      { ...mockCard(2, "Brainstorm", "Instant", 1), quantity: 4 },
      { ...mockCard(3, "Island", "Basic Land", 0), quantity: 24 },
      { ...mockCard(4, "Mountain", "Basic Land", 0), quantity: 24 },
    ];

    // Real signature: (deck, archetype) → DeckMetrics (sync)
    const result = evaluateDeckWithEngine(mockCards, "control");

    expect(result).toBeDefined();
    expect(typeof result.totalScore).toBe("number");
    expect(result.breakdown).toBeDefined();
    // DeckMetrics.breakdown shape is {curve, lands, synergy, simulation, ...}
    expect(typeof result.breakdown.curve).toBe("number");
    expect(typeof result.breakdown.lands).toBe("number");
    expect(typeof result.breakdown.synergy).toBe("number");
  });

  it("should handle empty decks gracefully", () => {
    const result = evaluateDeckWithEngine([], "control");

    expect(result).toBeDefined();
    expect(typeof result.totalScore).toBe("number");
    // Empty deck has no lands, no curve, no synergy → should produce a
    // very poor score. Don't over-constrain the exact number; just assert
    // it's far below a healthy (~50+) deck.
    expect(result.totalScore).toBeLessThan(30);
  });

  it("should evaluate different archetypes and return comparable shapes", () => {
    const aggroCards = [
      { ...mockCard(1, "Monastery Swiftspear", "Creature", 1), quantity: 4 },
      { ...mockCard(2, "Lightning Bolt", "Instant", 1), quantity: 4 },
      { ...mockCard(3, "Mountain", "Basic Land", 0), quantity: 24 },
    ];

    const controlCards = [
      { ...mockCard(1, "Counterspell", "Instant", 2), quantity: 4 },
      { ...mockCard(2, "Brainstorm", "Instant", 1), quantity: 4 },
      { ...mockCard(3, "Island", "Basic Land", 0), quantity: 24 },
    ];

    const aggroResult = evaluateDeckWithEngine(aggroCards, "aggro");
    const controlResult = evaluateDeckWithEngine(controlCards, "control");

    // Both should produce a valid DeckMetrics with the same shape
    expect(typeof aggroResult.totalScore).toBe("number");
    expect(typeof controlResult.totalScore).toBe("number");
    expect(aggroResult.breakdown).toBeDefined();
    expect(controlResult.breakdown).toBeDefined();
  });
});
