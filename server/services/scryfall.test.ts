import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { searchCards } from "./scryfall";
import { getDb } from "../db";

// Mock the database
vi.mock("../db", () => ({
  getDb: vi.fn(),
}));

const mockCards = [
  {
    id: 1,
    scryfallId: "card1",
    name: "Lightning Bolt",
    type: "Instant",
    colors: "R",
    cmc: 1,
    rarity: "common",
    imageUrl: "https://example.com/bolt.jpg",
    power: null,
    toughness: null,
    text: "Deal 3 damage to any target.",
  },
  {
    id: 2,
    scryfallId: "card2",
    name: "Counterspell",
    type: "Instant",
    colors: "U",
    cmc: 2,
    rarity: "common",
    imageUrl: "https://example.com/counter.jpg",
    power: null,
    toughness: null,
    text: "Counter target spell.",
  },
  {
    id: 3,
    scryfallId: "card3",
    name: "Black Lotus",
    type: "Artifact",
    colors: null,
    cmc: 0,
    rarity: "rare",
    imageUrl: "https://example.com/lotus.jpg",
    power: null,
    toughness: null,
    text: "Add three mana of any one color.",
  },
  {
    id: 4,
    scryfallId: "card4",
    name: "Serra Angel",
    type: "Creature — Angel",
    colors: "W",
    cmc: 5,
    rarity: "uncommon",
    imageUrl: "https://example.com/angel.jpg",
    power: "4",
    toughness: "4",
    text: "Flying, vigilance.",
  },
];

describe("searchCards", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should return all cards when no filters are provided", async () => {
    const mockDb = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue(mockCards),
    };

    (getDb as any).mockResolvedValue(mockDb);

    const result = await searchCards({});

    expect(result).toEqual(mockCards);
    expect(mockDb.select).toHaveBeenCalled();
    expect(mockDb.from).toHaveBeenCalled();
    expect(mockDb.limit).toHaveBeenCalledWith(100);
  });

  it("should filter cards by name", async () => {
    const mockDb = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue(mockCards),
    };

    (getDb as any).mockResolvedValue(mockDb);

    const result = await searchCards({ name: "bolt" });

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("Lightning Bolt");
  });

  it("should filter cards by type", async () => {
    const mockDb = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue(mockCards),
    };

    (getDb as any).mockResolvedValue(mockDb);

    const result = await searchCards({ type: "instant" });

    expect(result).toHaveLength(2);
    expect(result.map(c => c.name)).toEqual(["Lightning Bolt", "Counterspell"]);
  });

  it("should filter cards by colors", async () => {
    const mockDb = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue(mockCards),
    };

    (getDb as any).mockResolvedValue(mockDb);

    const result = await searchCards({ colors: "R" });

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("Lightning Bolt");
  });

  it("should filter cards by multiple colors", async () => {
    const mockDb = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue(mockCards),
    };

    (getDb as any).mockResolvedValue(mockDb);

    const result = await searchCards({ colors: "WU" });

    expect(result).toHaveLength(2);
    expect(result.map(c => c.name).sort()).toEqual(["Counterspell", "Serra Angel"]);
  });

  it("should filter cards by CMC", async () => {
    const mockDb = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue(mockCards),
    };

    (getDb as any).mockResolvedValue(mockDb);

    const result = await searchCards({ cmc: 1 });

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("Lightning Bolt");
  });

  it("should filter cards by rarity", async () => {
    const mockDb = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue(mockCards),
    };

    (getDb as any).mockResolvedValue(mockDb);

    const result = await searchCards({ rarity: "rare" });

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("Black Lotus");
  });

  it("should combine multiple filters", async () => {
    const mockDb = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue(mockCards),
    };

    (getDb as any).mockResolvedValue(mockDb);

    const result = await searchCards({ type: "instant", colors: "U" });

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("Counterspell");
  });

  it("should return empty array when no cards match filters", async () => {
    const mockDb = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue(mockCards),
    };

    (getDb as any).mockResolvedValue(mockDb);

    const result = await searchCards({ name: "nonexistent" });

    expect(result).toEqual([]);
  });

  it("should handle database errors gracefully", async () => {
    (getDb as any).mockResolvedValue(null);

    const result = await searchCards({ name: "test" });

    expect(result).toEqual([]);
  });

  it("should limit results to 100 cards", async () => {
    const manyCards = Array.from({ length: 150 }, (_, i) => ({
      ...mockCards[0],
      id: i + 1,
      name: `Card ${i + 1}`,
    }));

    const mockDb = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue(manyCards),
    };

    (getDb as any).mockResolvedValue(mockDb);

    const result = await searchCards({});

    expect(result).toHaveLength(150); // The limit is applied before filtering
    expect(mockDb.limit).toHaveBeenCalledWith(100);
  });
});