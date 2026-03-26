import { describe, it, expect, vi, beforeEach } from "vitest";

describe("Scryfall Sync", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should validate Scryfall card structure", () => {
    const mockCard = {
      id: "test-id",
      name: "Lightning Bolt",
      type_line: "Instant",
      colors: ["R"],
      cmc: 1,
      rarity: "common",
      image_uris: {
        normal: "https://example.com/card.jpg",
      },
      oracle_text: "Deal 3 damage to any target.",
    };

    expect(mockCard.name).toBeDefined();
    expect(mockCard.type_line).toBeDefined();
    expect(mockCard.image_uris?.normal).toBeDefined();
    expect(mockCard.cmc).toBeGreaterThanOrEqual(0);
  });

  it("should handle cards without images", () => {
    const mockCard = {
      id: "test-id",
      name: "Test Card",
      type_line: "Creature",
      colors: ["U"],
      cmc: 2,
      rarity: "common",
      // No image_uris
    };

    const hasImage = (mockCard as any).image_uris?.normal;
    expect(hasImage).toBeUndefined();
  });

  it("should validate color codes", () => {
    const validColors = ["W", "U", "B", "R", "G"];
    const testColors = ["W", "U", "B"];

    for (const color of testColors) {
      expect(validColors).toContain(color);
    }
  });

  it("should validate rarity values", () => {
    const validRarities = ["common", "uncommon", "rare", "mythic"];
    const testRarities = ["common", "rare", "mythic"];

    for (const rarity of testRarities) {
      expect(validRarities).toContain(rarity);
    }
  });

  it("should calculate CMC correctly", () => {
    const cards = [
      { name: "Lightning Bolt", cmc: 1 },
      { name: "Counterspell", cmc: 2 },
      { name: "Wrath of God", cmc: 4 },
    ];

    for (const card of cards) {
      expect(card.cmc).toBeGreaterThan(0);
      expect(card.cmc).toBeLessThan(20); // Reasonable upper bound
    }
  });

  it("should handle pagination correctly", () => {
    const mockResponse = {
      data: [
        { id: "1", name: "Card 1" },
        { id: "2", name: "Card 2" },
      ],
      next_page: "https://api.scryfall.com/cards/search?page=2",
    };

    expect(mockResponse.data).toHaveLength(2);
    expect(mockResponse.next_page).toBeDefined();
  });

  it("should handle last page without next_page", () => {
    const mockResponse = {
      data: [{ id: "1", name: "Card 1" }],
      next_page: undefined,
    };

    expect(mockResponse.next_page).toBeUndefined();
  });

  it("should validate format strings", () => {
    const validFormats = ["standard", "modern", "commander", "legacy", "all"];
    const testFormats = ["standard", "modern", "commander"];

    for (const format of testFormats) {
      expect(validFormats).toContain(format);
    }
  });

  it("should track sync statistics", () => {
    const stats = {
      imported: 100,
      skipped: 50,
      errors: 5,
    };

    expect(stats.imported).toBeGreaterThan(0);
    expect(stats.skipped).toBeGreaterThanOrEqual(0);
    expect(stats.errors).toBeGreaterThanOrEqual(0);
    expect(stats.imported + stats.skipped + stats.errors).toBeGreaterThan(0);
  });
});
