import { getDb } from "./db";
import { decks, deckCards, Deck, DeckCard, Card, cards } from "../drizzle/schema";
import { eq, and, sql } from "drizzle-orm";

export async function createDeck(
  userId: number,
  name: string,
  format: string,
  archetype?: string,
  description?: string
): Promise<Deck | null> {
  const db = await getDb();
  if (!db) return null;

  try {
    const result = await db.insert(decks).values({
      userId,
      name,
      format,
      archetype,
      description,
      isPublic: 0,
    }).returning();

    return result[0] || null;
  } catch (error) {
    console.error("Error creating deck:", error);
    return null;
  }
}

export async function getDeckById(deckId: number): Promise<Deck | null> {
  const db = await getDb();
  if (!db) return null;

  const result = await db.select().from(decks).where(eq(decks.id, deckId)).limit(1);
  return result[0] || null;
}

export async function getUserDecks(userId: number): Promise<Deck[]> {
  const db = await getDb();
  if (!db) return [];

  const result = await db.select().from(decks).where(eq(decks.userId, userId));
  return result;
}

export async function addCardToDeck(
  deckId: number,
  cardId: number,
  quantity: number = 1,
  format?: string
): Promise<DeckCard | null> {
  const db = await getDb();
  if (!db) return null;

  try {
    // Determine copy limit based on format
    let copyLimit = 4;
    if (format === "commander") {
      const cardRow = await db
        .select({ type: cards.type })
        .from(cards)
        .where(eq(cards.id, cardId))
        .limit(1);
      const isBasicLand = cardRow[0]?.type?.toLowerCase().includes("basic") ?? false;
      if (!isBasicLand) copyLimit = 1;
    }

    // Check if card already exists in deck
    const existing = await db
      .select()
      .from(deckCards)
      .where(and(eq(deckCards.deckId, deckId), eq(deckCards.cardId, cardId)))
      .limit(1);

    if (existing.length > 0) {
      // Update quantity
      const newQuantity = Math.min(existing[0].quantity + quantity, copyLimit);
      await db
        .update(deckCards)
        .set({ quantity: newQuantity })
        .where(and(eq(deckCards.deckId, deckId), eq(deckCards.cardId, cardId)));

      return { ...existing[0], quantity: newQuantity };
    }

    // Add new card
    await db.insert(deckCards).values({
      deckId,
      cardId,
      quantity: Math.min(quantity, copyLimit),
    });

    const result = await db
      .select()
      .from(deckCards)
      .where(and(eq(deckCards.deckId, deckId), eq(deckCards.cardId, cardId)))
      .limit(1);

    return result[0] || null;
  } catch (error) {
    console.error("Error adding card to deck:", error);
    return null;
  }
}

export async function removeCardFromDeck(deckId: number, cardId: number): Promise<boolean> {
  const db = await getDb();
  if (!db) return false;

  try {
    await db
      .delete(deckCards)
      .where(and(eq(deckCards.deckId, deckId), eq(deckCards.cardId, cardId)));
    return true;
  } catch (error) {
    console.error("Error removing card from deck:", error);
    return false;
  }
}

export async function getDeckCards(deckId: number): Promise<(DeckCard & { card: Card })[]> {
  const db = await getDb();
  if (!db) return [];

  try {
    const rows = await db
      .select()
      .from(deckCards)
      .innerJoin(cards, eq(deckCards.cardId, cards.id))
      .where(eq(deckCards.deckId, deckId));

    return rows.map((row) => ({
      ...row.deck_cards,
      card: row.cards,
    }));
  } catch (error) {
    console.error("Error getting deck cards:", error);
    return [];
  }
}

export async function getDeckCardCount(deckId: number): Promise<number> {
  const db = await getDb();
  if (!db) return 0;

  try {
    const deckCardList = await db
      .select()
      .from(deckCards)
      .where(eq(deckCards.deckId, deckId));

    return deckCardList.reduce((sum, dc) => sum + dc.quantity, 0);
  } catch (error) {
    console.error("Error getting deck card count:", error);
    return 0;
  }
}

export async function updateDeck(
  deckId: number,
  updates: { name?: string; archetype?: string; description?: string; isPublic?: number }
): Promise<Deck | null> {
  const db = await getDb();
  if (!db) return null;

  try {
    await db.update(decks).set(updates).where(eq(decks.id, deckId));

    const result = await db.select().from(decks).where(eq(decks.id, deckId)).limit(1);
    return result[0] || null;
  } catch (error) {
    console.error("Error updating deck:", error);
    return null;
  }
}

export async function deleteDeck(deckId: number): Promise<boolean> {
  const db = await getDb();
  if (!db) return false;

  try {
    // Delete deck cards first
    await db.delete(deckCards).where(eq(deckCards.deckId, deckId));
    // Delete deck
    await db.delete(decks).where(eq(decks.id, deckId));
    return true;
  } catch (error) {
    console.error("Error deleting deck:", error);
    return false;
  }
}
