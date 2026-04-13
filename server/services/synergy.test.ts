import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  getCardSynergy,
  getSynergyNeighbors,
  updateSynergy,
  calculateDeckSynergy,
  findBestCardForDeck,
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

describe("Synergy Engine", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
        or: vi.fn(),
        and: vi.fn(),
        eq: vi.fn(),
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
        or: vi.fn(),
        and: vi.fn(),
        eq: vi.fn(),
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
        or: vi.fn(),
        and: vi.fn(),
        eq: vi.fn(),
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
        or: vi.fn(),
        eq: vi.fn(),
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
        or: vi.fn(),
        eq: vi.fn(),
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
        or: vi.fn(),
        eq: vi.fn(),
        limit: vi.fn().mockResolvedValue([]),
      };

      (getDb as any).mockResolvedValue(mockDb);

      const result = await getSynergyNeighbors(1, 10);

      expect(result).toEqual([]);
    });
  });

  describe("updateSynergy", () => {
    it("should create new synergy when none exists", async () => {
      const mockDb = {
        select: vi.fn().mockReturnThis(),
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        and: vi.fn(),
        eq: vi.fn(),
        limit: vi.fn().mockResolvedValue([]), // No existing synergy
        insert: vi.fn().mockReturnThis(),
        values: vi.fn().mockResolvedValue(undefined),
      };

      // Mock the second select call
      mockDb.select.mockReturnValueOnce(mockDb);
      mockDb.from.mockReturnValueOnce(mockDb);
      mockDb.where.mockReturnValueOnce(mockDb);
      mockDb.and.mockReturnValueOnce(mockDb);
      mockDb.eq.mockReturnValueOnce(mockDb);
      mockDb.limit.mockResolvedValueOnce([]); // First call - no existing

      mockDb.select.mockReturnValueOnce(mockDb);
      mockDb.from.mockReturnValueOnce(mockDb);
      mockDb.where.mockReturnValueOnce(mockDb);
      mockDb.and.mockReturnValueOnce(mockDb);
      mockDb.eq.mockReturnValueOnce(mockDb);
      mockDb.limit.mockResolvedValueOnce([mockSynergy]); // Second call - return created

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
      const mockDb = {
        select: vi.fn().mockReturnThis(),
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        and: vi.fn(),
        eq: vi.fn(),
        limit: vi.fn().mockResolvedValue([mockSynergy]), // Existing synergy
        update: vi.fn().mockReturnThis(),
        set: vi.fn().mockResolvedValue(undefined),
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
        and: vi.fn(),
        eq: vi.fn(),
        limit: vi.fn().mockResolvedValue([]),
        insert: vi.fn().mockReturnThis(),
        values: vi.fn().mockResolvedValue(undefined),
      };

      mockDb.select.mockReturnValueOnce(mockDb);
      mockDb.from.mockReturnValueOnce(mockDb);
      mockDb.where.mockReturnValueOnce(mockDb);
      mockDb.and.mockReturnValueOnce(mockDb);
      mockDb.eq.mockReturnValueOnce(mockDb);
      mockDb.limit.mockResolvedValueOnce([]);

      mockDb.select.mockReturnValueOnce(mockDb);
      mockDb.from.mockReturnValueOnce(mockDb);
      mockDb.where.mockReturnValueOnce(mockDb);
      mockDb.and.mockReturnValueOnce(mockDb);
      mockDb.eq.mockReturnValueOnce(mockDb);
      mockDb.limit.mockResolvedValueOnce([mockSynergy]);

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

      // Mock getCardSynergy calls
      const getCardSynergyMock = vi.fn();
      getCardSynergyMock.mockResolvedValueOnce(10); // 1-2
      getCardSynergyMock.mockResolvedValueOnce(15); // 1-3
      getCardSynergyMock.mockResolvedValueOnce(20); // 2-3

      vi.mocked(getCardSynergy).mockImplementation(getCardSynergyMock);

      const result = await calculateDeckSynergy(cardIds);

      expect(result).toBe(45); // 10 + 15 + 20
      expect(getCardSynergyMock).toHaveBeenCalledTimes(3);
      expect(getCardSynergyMock).toHaveBeenCalledWith(1, 2);
      expect(getCardSynergyMock).toHaveBeenCalledWith(1, 3);
      expect(getCardSynergyMock).toHaveBeenCalledWith(2, 3);
    });

    it("should return 0 for decks with less than 2 cards", async () => {
      const result1 = await calculateDeckSynergy([1]);
      const result0 = await calculateDeckSynergy([]);

      expect(result1).toBe(0);
      expect(result0).toBe(0);
    });

    it("should handle decks with duplicate synergies", async () => {
      const cardIds = [1, 1, 2]; // Duplicate card IDs

      const getCardSynergyMock = vi.fn();
      getCardSynergyMock.mockResolvedValue(10);

      vi.mocked(getCardSynergy).mockImplementation(getCardSynergyMock);

      const result = await calculateDeckSynergy(cardIds);

      expect(result).toBe(20); // 1-1 + 1-2 + 1-2, but actually only unique pairs
      // Note: The current implementation doesn't deduplicate, so this tests the actual behavior
    });
  });

  describe("findBestCardForDeck", () => {
    it("should find the card with highest synergy score", async () => {
      const deckCardIds = [1, 2];
      const candidateCardIds = [3, 4, 5];

      const getCardSynergyMock = vi.fn();
      // Card 3: synergy with 1=10, with 2=5, total=15
      // Card 4: synergy with 1=8, with 2=12, total=20
      // Card 5: synergy with 1=6, with 2=8, total=14
      getCardSynergyMock.mockImplementation((card1, card2) => {
        const synergies: { [key: string]: number } = {
          "3-1": 10, "3-2": 5,
          "4-1": 8, "4-2": 12,
          "5-1": 6, "5-2": 8,
        };
        return Promise.resolve(synergies[`${card1}-${card2}`] || synergies[`${card2}-${card1}`] || 0);
      });

      vi.mocked(getCardSynergy).mockImplementation(getCardSynergyMock);

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
      const getCardSynergyMock = vi.fn();
      getCardSynergyMock.mockResolvedValue(0);

      vi.mocked(getCardSynergy).mockImplementation(getCardSynergyMock);

      const result = await findBestCardForDeck([1], [3]);

      expect(result).toBe(3); // Returns first candidate when all scores are 0
    });
  });

  describe("Integration tests", () => {
    it("should handle complex synergy calculations", async () => {
      // Test a more complex scenario with multiple cards
      const cardIds = [1, 2, 3, 4, 5];

      const synergyMatrix: { [key: string]: number } = {
        "1-2": 10, "1-3": 15, "1-4": 5, "1-5": 8,
        "2-3": 12, "2-4": 20, "2-5": 6,
        "3-4": 18, "3-5": 9,
        "4-5": 14,
      };

      const getCardSynergyMock = vi.fn();
      getCardSynergyMock.mockImplementation((card1, card2) => {
        const key = `${Math.min(card1, card2)}-${Math.max(card1, card2)}`;
        return Promise.resolve(synergyMatrix[key] || 0);
      });

      vi.mocked(getCardSynergy).mockImplementation(getCardSynergyMock);

      const result = await calculateDeckSynergy(cardIds);

      // Calculate expected total: sum of all unique pairs
      const expectedTotal = Object.values(synergyMatrix).reduce((sum, val) => sum + val, 0);
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