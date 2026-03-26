import { describe, it, expect, vi, beforeEach } from "vitest";
import { validateDeck, generateDeck, evaluateDeckWithEngine } from "./deckGenerator";
import type { Card } from "../../drizzle/schema";

const mockCard = (id: number, name: string, type: string, cmc: number = 2): Card & { quantity: number } => ({
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

// Mock database for generator tests
vi.mock("../db", () => ({
  getDb: vi.fn(() => ({
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(() => Promise.resolve([])),
        })),
      })),
    })),
    insert: vi.fn(() => ({
      values: vi.fn(() => ({
        returning: vi.fn(() => Promise.resolve([{ id: 1 }])),
      })),
    })),
  })),
}));

describe("generateDeck", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should generate a basic deck structure", async () => {
    const result = await generateDeck({
      format: "standard",
      colors: ["U", "R"],
      archetype: "control",
      size: 60,
    });

    expect(result).toBeDefined();
    expect(result.deck).toBeDefined();
    expect(result.deck.name).toContain("Control");
    expect(result.deck.format).toBe("standard");
    expect(result.cards).toBeDefined();
    expect(result.cards.length).toBeGreaterThan(0);
  });

  it("should generate decks with correct color distribution", async () => {
    const result = await generateDeck({
      format: "standard",
      colors: ["W", "B"],
      archetype: "aggro",
      size: 60,
    });

    const whiteCards = result.cards.filter(card =>
      card.colors?.includes("W") || card.colors?.includes("WB") || card.colors?.includes("WUB")
    );
    const blackCards = result.cards.filter(card =>
      card.colors?.includes("B") || card.colors?.includes("WB") || card.colors?.includes("WUB")
    );

    expect(whiteCards.length).toBeGreaterThan(0);
    expect(blackCards.length).toBeGreaterThan(0);
  });

  it("should respect format-specific rules", async () => {
    const commanderResult = await generateDeck({
      format: "commander",
      colors: ["U"],
      archetype: "control",
      size: 100,
    });

    expect(commanderResult.deck.format).toBe("commander");
    expect(commanderResult.cards.length).toBe(100);
  });

  it("should include basic lands in generated decks", async () => {
    const result = await generateDeck({
      format: "standard",
      colors: ["U"],
      archetype: "control",
      size: 60,
    });

    const lands = result.cards.filter(card => card.type?.toLowerCase().includes("land"));
    expect(lands.length).toBeGreaterThan(0);

    const basicLands = lands.filter(card =>
      card.name?.toLowerCase().includes("island") ||
      card.name?.toLowerCase().includes("plains") ||
      card.name?.toLowerCase().includes("swamp") ||
      card.name?.toLowerCase().includes("mountain") ||
      card.name?.toLowerCase().includes("forest")
    );
    expect(basicLands.length).toBeGreaterThan(0);
  });
});

describe("evaluateDeckWithEngine", () => {
  it("should evaluate a deck and return metrics", async () => {
    const mockDeck = {
      id: 1,
      name: "Test Deck",
      format: "standard",
      colors: "UR",
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const mockCards = [
      { ...mockCard(1, "Lightning Bolt", "Instant"), quantity: 4 },
      { ...mockCard(2, "Brainstorm", "Instant"), quantity: 4 },
      { ...mockCard(3, "Island", "Basic Land"), quantity: 24 },
      { ...mockCard(4, "Mountain", "Basic Land"), quantity: 24 },
    ];

    const result = await evaluateDeckWithEngine(mockDeck, mockCards);

    expect(result).toBeDefined();
    expect(result.score).toBeDefined();
    expect(typeof result.score).toBe("number");
    expect(result.breakdown).toBeDefined();
    expect(result.breakdown.curve).toBeDefined();
    expect(result.breakdown.land).toBeDefined();
    expect(result.breakdown.synergy).toBeDefined();
  });

  it("should handle empty decks gracefully", async () => {
    const mockDeck = {
      id: 1,
      name: "Empty Deck",
      format: "standard",
      colors: "",
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const result = await evaluateDeckWithEngine(mockDeck, []);

    expect(result).toBeDefined();
    expect(result.score).toBeDefined();
    expect(result.score).toBeLessThan(0); // Should have negative score for empty deck
  });

  it("should evaluate different archetypes appropriately", async () => {
    const aggroCards = [
      { ...mockCard(1, "Monastery Swiftspear", "Creature"), quantity: 4 },
      { ...mockCard(2, "Lightning Bolt", "Instant"), quantity: 4 },
      { ...mockCard(3, "Mountain", "Basic Land"), quantity: 24 },
    ];

    const controlCards = [
      { ...mockCard(1, "Counterspell", "Instant"), quantity: 4 },
      { ...mockCard(2, "Brainstorm", "Instant"), quantity: 4 },
      { ...mockCard(3, "Island", "Basic Land"), quantity: 24 },
    ];

    const mockDeck = {
      id: 1,
      name: "Test Deck",
      format: "standard",
      colors: "R",
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const aggroResult = await evaluateDeckWithEngine(mockDeck, aggroCards);
    const controlResult = await evaluateDeckWithEngine(mockDeck, controlCards);

    // Both should have valid scores
    expect(aggroResult.score).toBeDefined();
    expect(controlResult.score).toBeDefined();
  });
});
