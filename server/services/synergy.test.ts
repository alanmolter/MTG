import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  getCardSynergy,
  getSynergyNeighbors,
  updateSynergy,
  calculateDeckSynergy,
  findBestCardForDeck,
  resetSynergyCircuit,
} from "./synergy";
import { getDb } from "../db";

// Mock the database
vi.mock("../db", () => ({
  getDb: vi.fn(),
}));

const mockSynergy = {
  id: 1,
  card1Id: 1,
  card2Id: 2,
  weight: 75,
  coOccurrenceRate: 85,
  updatedAt: new Date(),
};

// Helper: produce a synergy row whose blended score equals `blended`.
// blended = round(coOccurrenceRate * 0.7 + weight * 0.3). When co=weight=B,
// blended = B exactly, so we use that shortcut.
function synergyRow(blended: number) {
  return { coOccurrenceRate: blended, weight: blended };
}

describe("Synergy Engine", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Circuit breaker state is module-global; reset so tests don't leak state
    resetSynergyCircuit();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("getCardSynergy", () => {
    it("should return synergy weight between two cards", async () => {
      const mockDb = {
        select: vi.fn().mockReturnThis(),
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        limit: vi.fn().mockResolvedValue([mockSynergy]),
      };

      (getDb as any).mockResolvedValue(mockDb);

      const result = await getCardSynergy(1, 2);

      // blended: Math.round(85*0.7 + 75*0.3) = 82
      expect(result).toBe(82);
      expect(mockDb.select).toHaveBeenCalled();
      expect(mockDb.where).toHaveBeenCalled();
    });

    it("should return 0 when no synergy exists", async () => {
      const mockDb = {
        select: vi.fn().mockReturnThis(),
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        limit: vi.fn().mockResolvedValue([]),
      };

      (getDb as any).mockResolvedValue(mockDb);

      const result = await getCardSynergy(1, 3);

      expect(result).toBe(0);
    });

    it("should handle database errors gracefully", async () => {
      (getDb as any).mockResolvedValue(null);

      const result = await getCardSynergy(1, 2);

      expect(result).toBe(0);
    });

    it("should work with cards in reverse order", async () => {
      const mockDb = {
        select: vi.fn().mockReturnThis(),
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        limit: vi.fn().mockResolvedValue([mockSynergy]),
      };

      (getDb as any).mockResolvedValue(mockDb);

      const result = await getCardSynergy(2, 1); // Reverse order

      // blended: Math.round(85*0.7 + 75*0.3) = 82
      expect(result).toBe(82);
    });
  });

  describe("getSynergyNeighbors", () => {
    it("should return synergy neighbors for a card", async () => {
      const mockSynergies = [
        { card1Id: 1, card2Id: 2, coOccurrenceRate: 85 },
        { card1Id: 1, card2Id: 3, coOccurrenceRate: 70 },
        { card1Id: 4, card2Id: 1, coOccurrenceRate: 60 },
      ];

      const mockDb = {
        select: vi.fn().mockReturnThis(),
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        limit: vi.fn().mockResolvedValue(mockSynergies),
      };

      (getDb as any).mockResolvedValue(mockDb);

      const result = await getSynergyNeighbors(1, 10);

      expect(result).toHaveLength(3);
      expect(result).toEqual([
        { cardId: 2, weight: 85 },
        { cardId: 3, weight: 70 },
        { cardId: 4, weight: 60 },
      ]);
    });

    it("should respect the limit parameter", async () => {
      const mockSynergies = [
        { card1Id: 1, card2Id: 2, coOccurrenceRate: 85 },
        { card1Id: 1, card2Id: 3, coOccurrenceRate: 70 },
      ];

      const mockDb = {
        select: vi.fn().mockReturnThis(),
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        limit: vi.fn().mockResolvedValue(mockSynergies),
      };

      (getDb as any).mockResolvedValue(mockDb);

      const result = await getSynergyNeighbors(1, 1);

      expect(result).toHaveLength(2); // limit is applied in query
      expect(mockDb.limit).toHaveBeenCalledWith(1);
    });

    it("should return empty array when no neighbors exist", async () => {
      const mockDb = {
        select: vi.fn().mockReturnThis(),
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        limit: vi.fn().mockResolvedValue([]),
      };

      (getDb as any).mockResolvedValue(mockDb);

      const result = await getSynergyNeighbors(1, 10);

      expect(result).toEqual([]);
    });
  });

  describe("updateSynergy", () => {
    it("should create new synergy when none exists", async () => {
      // Source:
      //   1) select().from().where().limit(1) → []          (no existing)
      //   2) insert().values()
      //   3) select().from().where().limit(1) → [new row]   (read back)
      const mockDb = {
        select: vi.fn().mockReturnThis(),
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        limit: vi
          .fn()
          .mockResolvedValueOnce([]) // no existing
          .mockResolvedValueOnce([mockSynergy]), // read back
        insert: vi.fn().mockReturnThis(),
        values: vi.fn().mockResolvedValue(undefined),
      };

      (getDb as any).mockResolvedValue(mockDb);

      const result = await updateSynergy(1, 2, 75, 85);

      expect(result).toEqual(mockSynergy);
      expect(mockDb.insert).toHaveBeenCalled();
      expect(mockDb.values).toHaveBeenCalledWith({
        card1Id: 1, // minId
        card2Id: 2, // maxId
        weight: 75,
        coOccurrenceRate: 85,
      });
    });

    it("should update existing synergy", async () => {
      // Source when existing:
      //   1) select().from().where().limit(1) → [existing]
      //   2) update().set().where()
      //   returns { ...existing, weight, coOccurrenceRate }
      const mockDb = {
        select: vi.fn().mockReturnThis(),
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        limit: vi.fn().mockResolvedValue([mockSynergy]),
        update: vi.fn().mockReturnThis(),
        set: vi.fn().mockReturnThis(), // MUST chain, so await .where() resolves
      };

      (getDb as any).mockResolvedValue(mockDb);

      const result = await updateSynergy(1, 2, 90, 95);

      expect(result).toEqual({ ...mockSynergy, weight: 90, coOccurrenceRate: 95 });
      expect(mockDb.update).toHaveBeenCalled();
      expect(mockDb.set).toHaveBeenCalledWith({
        weight: 90,
        coOccurrenceRate: 95,
      });
    });

    it("should order card IDs consistently (min, max)", async () => {
      const mockDb = {
        select: vi.fn().mockReturnThis(),
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        limit: vi
          .fn()
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([mockSynergy]),
        insert: vi.fn().mockReturnThis(),
        values: vi.fn().mockResolvedValue(undefined),
      };

      (getDb as any).mockResolvedValue(mockDb);

      // Call with cards in reverse order
      await updateSynergy(3, 1, 75, 85);

      expect(mockDb.values).toHaveBeenCalledWith({
        card1Id: 1, // minId
        card2Id: 3, // maxId
        weight: 75,
        coOccurrenceRate: 85,
      });
    });
  });

  describe("calculateDeckSynergy", () => {
    it("should calculate total synergy for a deck", async () => {
      const cardIds = [1, 2, 3];

      // Iteration order: (1,2), (1,3), (2,3). Each pair → 1 DB hit.
      // Use synergyRow(B) where blended score == B, then total = sum of B.
      const mockDb = {
        select: vi.fn().mockReturnThis(),
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        limit: vi
          .fn()
          .mockResolvedValueOnce([synergyRow(10)]) // 1-2
          .mockResolvedValueOnce([synergyRow(15)]) // 1-3
          .mockResolvedValueOnce([synergyRow(20)]), // 2-3
      };

      (getDb as any).mockResolvedValue(mockDb);

      const result = await calculateDeckSynergy(cardIds);

      expect(result).toBe(45); // 10 + 15 + 20
      expect(mockDb.limit).toHaveBeenCalledTimes(3);
    });

    it("should return 0 for decks with less than 2 cards", async () => {
      const result1 = await calculateDeckSynergy([1]);
      const result0 = await calculateDeckSynergy([]);

      expect(result1).toBe(0);
      expect(result0).toBe(0);
    });

    it("should handle decks with duplicate card IDs", async () => {
      const cardIds = [1, 1, 2]; // Duplicate card IDs
      // Source doesn't deduplicate, so 3 pairs are queried: (1,1), (1,2), (1,2)
      const mockDb = {
        select: vi.fn().mockReturnThis(),
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        limit: vi.fn().mockResolvedValue([synergyRow(10)]),
      };

      (getDb as any).mockResolvedValue(mockDb);

      const result = await calculateDeckSynergy(cardIds);

      // Actual behavior: 3 pairs * 10 = 30 (no dedup)
      expect(result).toBe(30);
      expect(mockDb.limit).toHaveBeenCalledTimes(3);
    });
  });

  describe("findBestCardForDeck", () => {
    it("should find the card with highest synergy score", async () => {
      const deckCardIds = [1, 2];
      const candidateCardIds = [3, 4, 5];

      // Iteration: for each candidate, for each deck card → 6 DB calls.
      // Candidate 3: synergy(3,1)=10, synergy(3,2)=5   → total 15
      // Candidate 4: synergy(4,1)=8,  synergy(4,2)=12  → total 20 ← winner
      // Candidate 5: synergy(5,1)=6,  synergy(5,2)=8   → total 14
      const mockDb = {
        select: vi.fn().mockReturnThis(),
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        limit: vi
          .fn()
          .mockResolvedValueOnce([synergyRow(10)])
          .mockResolvedValueOnce([synergyRow(5)])
          .mockResolvedValueOnce([synergyRow(8)])
          .mockResolvedValueOnce([synergyRow(12)])
          .mockResolvedValueOnce([synergyRow(6)])
          .mockResolvedValueOnce([synergyRow(8)]),
      };

      (getDb as any).mockResolvedValue(mockDb);

      const result = await findBestCardForDeck(deckCardIds, candidateCardIds);

      expect(result).toBe(4); // Card 4 has highest total synergy (20)
    });

    it("should return null when no candidates provided", async () => {
      const result = await findBestCardForDeck([1, 2], []);

      expect(result).toBeNull();
    });

    it("should return null when deck has no cards", async () => {
      const result = await findBestCardForDeck([], [3, 4]);

      expect(result).toBeNull();
    });

    it("should handle zero synergy scores", async () => {
      // deck=[1], candidates=[3]: 1 call returning blended=0.
      // Score=0 > bestScore=-1 → returns first (and only) candidate.
      const mockDb = {
        select: vi.fn().mockReturnThis(),
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        limit: vi.fn().mockResolvedValue([]), // no synergy row → blended=0
      };

      (getDb as any).mockResolvedValue(mockDb);

      const result = await findBestCardForDeck([1], [3]);

      expect(result).toBe(3); // Returns first candidate when all scores are 0
    });
  });

  describe("Integration tests", () => {
    it("should handle complex synergy calculations", async () => {
      const cardIds = [1, 2, 3, 4, 5];

      // Iteration order in calculateDeckSynergy:
      //   (1,2), (1,3), (1,4), (1,5), (2,3), (2,4), (2,5), (3,4), (3,5), (4,5)
      const pairOrder: [number, number][] = [
        [1, 2], [1, 3], [1, 4], [1, 5],
        [2, 3], [2, 4], [2, 5],
        [3, 4], [3, 5],
        [4, 5],
      ];
      const synergyMatrix: { [key: string]: number } = {
        "1-2": 10, "1-3": 15, "1-4": 5, "1-5": 8,
        "2-3": 12, "2-4": 20, "2-5": 6,
        "3-4": 18, "3-5": 9,
        "4-5": 14,
      };

      const limitMock = vi.fn();
      for (const [a, b] of pairOrder) {
        const key = `${Math.min(a, b)}-${Math.max(a, b)}`;
        limitMock.mockResolvedValueOnce([synergyRow(synergyMatrix[key])]);
      }

      const mockDb = {
        select: vi.fn().mockReturnThis(),
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        limit: limitMock,
      };

      (getDb as any).mockResolvedValue(mockDb);

      const result = await calculateDeckSynergy(cardIds);

      const expectedTotal = Object.values(synergyMatrix).reduce((s, v) => s + v, 0);
      expect(result).toBe(expectedTotal);
    });

    it("should handle database connection failures gracefully", async () => {
      (getDb as any).mockResolvedValue(null);

      const synergyResult = await getCardSynergy(1, 2);
      const neighborsResult = await getSynergyNeighbors(1);
      const updateResult = await updateSynergy(1, 2, 75, 85);

      expect(synergyResult).toBe(0);
      expect(neighborsResult).toEqual([]);
      expect(updateResult).toBeNull();
    });
  });
});
