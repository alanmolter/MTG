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

// Factory: produce a chained-query mock compatible with the Drizzle call pattern
//   db.select().from(...)[.where(...)].limit(N)
// The mock returns the rows you supply when `.limit()` is awaited.
function makeDbMock(rows: typeof mockCards) {
  const chain: any = {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue(rows),
  };
  return chain;
}

describe("searchCards", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should return all cards when no filters are provided", async () => {
    const mockDb = makeDbMock(mockCards);
    (getDb as any).mockResolvedValue(mockDb);

    const result = await searchCards({});

    expect(result).toEqual(mockCards);
    expect(mockDb.select).toHaveBeenCalled();
    expect(mockDb.from).toHaveBeenCalled();
    // searchCards uses limit(2000) as a memory guard (not 100)
    expect(mockDb.limit).toHaveBeenCalledWith(2000);
    // No filters => .where should NOT be called
    expect(mockDb.where).not.toHaveBeenCalled();
  });

  it("should call .where() when filtering by name", async () => {
    const mockDb = makeDbMock([mockCards[0]]);
    (getDb as any).mockResolvedValue(mockDb);

    const result = await searchCards({ name: "bolt" });

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("Lightning Bolt");
    expect(mockDb.where).toHaveBeenCalledTimes(1);
  });

  it("should call .where() when filtering by type", async () => {
    const mockDb = makeDbMock([mockCards[0], mockCards[1]]);
    (getDb as any).mockResolvedValue(mockDb);

    const result = await searchCards({ type: "instant" });

    expect(result).toHaveLength(2);
    expect(result.map((c) => c.name)).toEqual(["Lightning Bolt", "Counterspell"]);
    expect(mockDb.where).toHaveBeenCalledTimes(1);
  });

  it("should call .where() when filtering by colors", async () => {
    const mockDb = makeDbMock([mockCards[0]]);
    (getDb as any).mockResolvedValue(mockDb);

    const result = await searchCards({ colors: "R" });

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("Lightning Bolt");
    expect(mockDb.where).toHaveBeenCalledTimes(1);
  });

  it("should call .where() when filtering by multiple colors", async () => {
    const mockDb = makeDbMock([mockCards[1], mockCards[3]]);
    (getDb as any).mockResolvedValue(mockDb);

    const result = await searchCards({ colors: "WU" });

    expect(result).toHaveLength(2);
    expect(result.map((c) => c.name).sort()).toEqual(["Counterspell", "Serra Angel"]);
    expect(mockDb.where).toHaveBeenCalledTimes(1);
  });

  it("should call .where() when filtering by CMC", async () => {
    const mockDb = makeDbMock([mockCards[0]]);
    (getDb as any).mockResolvedValue(mockDb);

    const result = await searchCards({ cmc: 1 });

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("Lightning Bolt");
    expect(mockDb.where).toHaveBeenCalledTimes(1);
  });

  it("should call .where() when filtering by rarity", async () => {
    const mockDb = makeDbMock([mockCards[2]]);
    (getDb as any).mockResolvedValue(mockDb);

    const result = await searchCards({ rarity: "rare" });

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("Black Lotus");
    expect(mockDb.where).toHaveBeenCalledTimes(1);
  });

  it("should call .where() once when combining multiple filters", async () => {
    const mockDb = makeDbMock([mockCards[1]]);
    (getDb as any).mockResolvedValue(mockDb);

    const result = await searchCards({ type: "instant", colors: "U" });

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("Counterspell");
    // All conditions are combined into a single and(...) call
    expect(mockDb.where).toHaveBeenCalledTimes(1);
  });

  it("should return empty array when database returns no matches", async () => {
    const mockDb = makeDbMock([]);
    (getDb as any).mockResolvedValue(mockDb);

    const result = await searchCards({ name: "nonexistent" });

    expect(result).toEqual([]);
  });

  it("should handle database errors gracefully", async () => {
    (getDb as any).mockResolvedValue(null);

    const result = await searchCards({ name: "test" });

    expect(result).toEqual([]);
  });

  it("should use limit(2000) as memory guard", async () => {
    const manyCards = Array.from({ length: 150 }, (_, i) => ({
      ...mockCards[0],
      id: i + 1,
      name: `Card ${i + 1}`,
    }));

    const mockDb = makeDbMock(manyCards);
    (getDb as any).mockResolvedValue(mockDb);

    const result = await searchCards({});

    expect(result).toHaveLength(150);
    expect(mockDb.limit).toHaveBeenCalledWith(2000);
  });
});
