import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createDeck,
  getDeckById,
  getUserDecks,
  addCardToDeck,
  removeCardFromDeck,
  getDeckCards,
  getDeckCardCount,
  updateDeck,
  deleteDeck,
} from "./db-decks";
import { getDb } from "./db";

// Mock the database
vi.mock("./db", () => ({
  getDb: vi.fn(),
}));

const mockDeck = {
  id: 1,
  userId: 1,
  name: "Test Deck",
  format: "standard",
  archetype: "Control",
  description: "A test deck",
  isPublic: 0,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const mockCard = {
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
};

const mockDeckCard = {
  id: 1,
  deckId: 1,
  cardId: 1,
  quantity: 1,
};

describe("Deck CRUD Operations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("createDeck", () => {
    it("should create a new deck successfully", async () => {
      // Source: db.insert(decks).values({...}).returning()
      const mockDb = {
        insert: vi.fn().mockReturnThis(),
        values: vi.fn().mockReturnThis(),
        returning: vi.fn().mockResolvedValue([mockDeck]),
      };

      (getDb as any).mockResolvedValue(mockDb);

      const result = await createDeck(1, "Test Deck", "standard", "Control", "A test deck");

      expect(result).toEqual(mockDeck);
      expect(mockDb.insert).toHaveBeenCalledWith(expect.any(Object));
      expect(mockDb.values).toHaveBeenCalledWith({
        userId: 1,
        name: "Test Deck",
        format: "standard",
        archetype: "Control",
        description: "A test deck",
        isPublic: 0,
      });
      expect(mockDb.returning).toHaveBeenCalled();
    });

    it("should handle database errors", async () => {
      (getDb as any).mockResolvedValue(null);

      const result = await createDeck(1, "Test Deck", "standard");

      expect(result).toBeNull();
    });
  });

  describe("getDeckById", () => {
    it("should return a deck by ID", async () => {
      const mockDb = {
        select: vi.fn().mockReturnThis(),
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        limit: vi.fn().mockResolvedValue([mockDeck]),
      };

      (getDb as any).mockResolvedValue(mockDb);

      const result = await getDeckById(1);

      expect(result).toEqual(mockDeck);
    });

    it("should return null if deck not found", async () => {
      const mockDb = {
        select: vi.fn().mockReturnThis(),
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        limit: vi.fn().mockResolvedValue([]),
      };

      (getDb as any).mockResolvedValue(mockDb);

      const result = await getDeckById(999);

      expect(result).toBeNull();
    });
  });

  describe("getUserDecks", () => {
    it("should return all decks for a user", async () => {
      const mockDecks = [mockDeck, { ...mockDeck, id: 2, name: "Second Deck" }];
      const mockDb = {
        select: vi.fn().mockReturnThis(),
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockResolvedValue(mockDecks),
      };

      (getDb as any).mockResolvedValue(mockDb);

      const result = await getUserDecks(1);

      expect(result).toEqual(mockDecks);
    });

    it("should return empty array if no decks found", async () => {
      const mockDb = {
        select: vi.fn().mockReturnThis(),
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockResolvedValue([]),
      };

      (getDb as any).mockResolvedValue(mockDb);

      const result = await getUserDecks(1);

      expect(result).toEqual([]);
    });
  });

  describe("addCardToDeck", () => {
    it("should add a new card to deck", async () => {
      // Source path when no existing card:
      //   1) select().from().where().limit(1)  →  []         (no existing)
      //   2) insert().values()                               (insert)
      //   3) select().from().from().where().limit(1)  → [new]  (read back)
      const inserted = { id: 1, deckId: 1, cardId: 1, quantity: 2 };
      const mockDb = {
        select: vi.fn().mockReturnThis(),
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        limit: vi
          .fn()
          .mockResolvedValueOnce([]) // existing check: no row
          .mockResolvedValueOnce([inserted]), // read back after insert
        insert: vi.fn().mockReturnThis(),
        values: vi.fn().mockResolvedValue(undefined),
      };

      (getDb as any).mockResolvedValue(mockDb);

      const result = await addCardToDeck(1, 1, 2);

      expect(result).toEqual(inserted);
      expect(mockDb.insert).toHaveBeenCalled();
      expect(mockDb.values).toHaveBeenCalledWith({
        deckId: 1,
        cardId: 1,
        quantity: 2,
      });
    });

    it("should update quantity if card already exists", async () => {
      // Source path when existing:
      //   1) select().from().where().limit(1) → [existing]
      //   2) update().set().where()           → (ignored)
      //   returns { ...existing, quantity: newQuantity }
      const existingDeckCard = { ...mockDeckCard, quantity: 2 };
      const mockDb = {
        select: vi.fn().mockReturnThis(),
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(), // returnThis so await update().set().where() resolves
        limit: vi.fn().mockResolvedValue([existingDeckCard]),
        update: vi.fn().mockReturnThis(),
        set: vi.fn().mockReturnThis(),
      };

      (getDb as any).mockResolvedValue(mockDb);

      const result = await addCardToDeck(1, 1, 2);

      expect(result).toEqual({ ...existingDeckCard, quantity: 4 }); // 2 + 2 = 4
      expect(mockDb.update).toHaveBeenCalled();
      expect(mockDb.set).toHaveBeenCalledWith({ quantity: 4 });
    });

    it("should not exceed maximum quantity of 4", async () => {
      const existingDeckCard = { ...mockDeckCard, quantity: 3 };
      const mockDb = {
        select: vi.fn().mockReturnThis(),
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        limit: vi.fn().mockResolvedValue([existingDeckCard]),
        update: vi.fn().mockReturnThis(),
        set: vi.fn().mockReturnThis(),
      };

      (getDb as any).mockResolvedValue(mockDb);

      const result = await addCardToDeck(1, 1, 3);

      expect(result).toEqual({ ...existingDeckCard, quantity: 4 }); // 3 + 3 = 6, capped at 4
    });
  });

  describe("removeCardFromDeck", () => {
    it("should remove a card from deck", async () => {
      const mockDb = {
        delete: vi.fn().mockReturnThis(),
        where: vi.fn().mockResolvedValue(undefined),
      };

      (getDb as any).mockResolvedValue(mockDb);

      const result = await removeCardFromDeck(1, 1);

      expect(result).toBe(true);
      expect(mockDb.delete).toHaveBeenCalled();
    });

    it("should handle database errors", async () => {
      (getDb as any).mockResolvedValue(null);

      const result = await removeCardFromDeck(1, 1);

      expect(result).toBe(false);
    });
  });

  describe("getDeckCards", () => {
    it("should return deck cards with card details", async () => {
      // Source: db.select().from(deckCards).innerJoin(cards, ...).where(eq(...))
      // Returns rows with shape { deck_cards: {...}, cards: {...} }
      const joinedRows = [{ deck_cards: mockDeckCard, cards: mockCard }];
      const mockDb = {
        select: vi.fn().mockReturnThis(),
        from: vi.fn().mockReturnThis(),
        innerJoin: vi.fn().mockReturnThis(),
        where: vi.fn().mockResolvedValue(joinedRows),
      };

      (getDb as any).mockResolvedValue(mockDb);

      const result = await getDeckCards(1);

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        ...mockDeckCard,
        card: mockCard,
      });
    });

    it("should return empty array when no joined rows", async () => {
      const mockDb = {
        select: vi.fn().mockReturnThis(),
        from: vi.fn().mockReturnThis(),
        innerJoin: vi.fn().mockReturnThis(),
        where: vi.fn().mockResolvedValue([]),
      };

      (getDb as any).mockResolvedValue(mockDb);

      const result = await getDeckCards(1);

      expect(result).toEqual([]);
    });
  });

  describe("getDeckCardCount", () => {
    it("should return total card count in deck", async () => {
      const mockDeckCards = [
        { quantity: 4 },
        { quantity: 3 },
        { quantity: 2 },
      ];
      const mockDb = {
        select: vi.fn().mockReturnThis(),
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockResolvedValue(mockDeckCards),
      };

      (getDb as any).mockResolvedValue(mockDb);

      const result = await getDeckCardCount(1);

      expect(result).toBe(9); // 4 + 3 + 2
    });

    it("should return 0 for empty deck", async () => {
      const mockDb = {
        select: vi.fn().mockReturnThis(),
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockResolvedValue([]),
      };

      (getDb as any).mockResolvedValue(mockDb);

      const result = await getDeckCardCount(1);

      expect(result).toBe(0);
    });
  });

  describe("updateDeck", () => {
    it("should update deck metadata", async () => {
      // Source:
      //   1) update().set().where()             → (ignored)
      //   2) select().from().where().limit(1)   → [mockDeck]
      const mockDb = {
        update: vi.fn().mockReturnThis(),
        set: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        select: vi.fn().mockReturnThis(),
        from: vi.fn().mockReturnThis(),
        limit: vi.fn().mockResolvedValue([mockDeck]),
      };

      (getDb as any).mockResolvedValue(mockDb);

      const updates = { name: "Updated Deck", archetype: "Aggro" };
      const result = await updateDeck(1, updates);

      expect(result).toEqual(mockDeck);
      expect(mockDb.update).toHaveBeenCalled();
      expect(mockDb.set).toHaveBeenCalledWith(updates);
    });
  });

  describe("deleteDeck", () => {
    it("should delete deck and its cards", async () => {
      const mockDb = {
        delete: vi.fn().mockReturnThis(),
        where: vi.fn().mockResolvedValue(undefined),
      };

      (getDb as any).mockResolvedValue(mockDb);

      const result = await deleteDeck(1);

      expect(result).toBe(true);
      expect(mockDb.delete).toHaveBeenCalledTimes(2); // Once for deckCards, once for decks
    });

    it("should handle database errors", async () => {
      (getDb as any).mockResolvedValue(null);

      const result = await deleteDeck(1);

      expect(result).toBe(false);
    });
  });
});
