import { getDb } from "../db";
import { cards, Card, InsertCard } from "../../drizzle/schema";
import { eq } from "drizzle-orm";

const SCRYFALL_API = "https://api.scryfall.com";

interface ScryfallCard {
  id: string;
  name: string;
  type_line: string;
  colors?: string[];
  cmc: number;
  rarity: string;
  image_uris?: {
    normal: string;
  };
  power?: string;
  toughness?: string;
  oracle_text?: string;
  games?: string[];
}

export async function searchScryfallCards(query: string): Promise<ScryfallCard[]> {
  try {
    const response = await fetch(
      `${SCRYFALL_API}/cards/search?q=${encodeURIComponent(query)}&unique=cards`
    );
    if (!response.ok) return [];
    const data = await response.json();
    return data.data || [];
  } catch (error) {
    console.error("Scryfall search error:", error);
    return [];
  }
}

export async function getScryfallCardByName(name: string): Promise<ScryfallCard | null> {
  try {
    const response = await fetch(
      `${SCRYFALL_API}/cards/named?exact=${encodeURIComponent(name)}`
    );
    if (!response.ok) return null;
    return await response.json();
  } catch (error) {
    console.error("Scryfall fetch error:", error);
    return null;
  }
}

export async function syncCardFromScryfall(scryfallCard: ScryfallCard): Promise<Card | null> {
  const db = await getDb();
  if (!db) return null;

  const insertData: InsertCard = {
    scryfallId: scryfallCard.id,
    name: scryfallCard.name,
    type: scryfallCard.type_line,
    colors: scryfallCard.colors?.join("") || null,
    cmc: scryfallCard.cmc,
    rarity: scryfallCard.rarity,
    imageUrl: scryfallCard.image_uris?.normal || null,
    power: scryfallCard.power || null,
    toughness: scryfallCard.toughness || null,
    text: scryfallCard.oracle_text || null,
    isArena: scryfallCard.games?.includes("arena") ? 1 : 0,
  };

  try {
    // Try to insert or get existing
    const existing = await db
      .select()
      .from(cards)
      .where(eq(cards.scryfallId, scryfallCard.id))
      .limit(1);

    if (existing.length > 0) {
      return existing[0];
    }

    await db.insert(cards).values(insertData);
    const result = await db
      .select()
      .from(cards)
      .where(eq(cards.scryfallId, scryfallCard.id))
      .limit(1);

    return result[0] || null;
  } catch (error) {
    console.error("Error syncing card:", error);
    return null;
  }
}

export async function getCardByName(name: string): Promise<Card | null> {
  const db = await getDb();
  if (!db) return null;

  const result = await db.select().from(cards).where(eq(cards.name, name)).limit(1);
  return result[0] || null;
}

export async function searchCards(filters: {
  name?: string;
  type?: string;
  colors?: string;
  cmc?: number;
  rarity?: string;
  isArena?: boolean;
}): Promise<Card[]> {
  const db = await getDb();
  if (!db) return [];

  const { and, ilike, eq, or } = await import("drizzle-orm");

  const conditions = [];

  if (filters.isArena) {
    conditions.push(eq(cards.isArena, 1));
  }

  if (filters.name) {
    conditions.push(ilike(cards.name, `%${filters.name}%`));
  }
  if (filters.type) {
    conditions.push(ilike(cards.type, `%${filters.type}%`));
  }
  if (filters.colors) {
    // Se várias cores forem passadas, buscar qualquer uma delas (simplificado)
    const colorConditions = filters.colors
      .split("")
      .map((c) => ilike(cards.colors, `%${c}%`));
    if (colorConditions.length > 0) {
      conditions.push(or(...colorConditions));
    }
  }
  if (filters.cmc !== undefined) {
    conditions.push(eq(cards.cmc, filters.cmc));
  }
  if (filters.rarity) {
    conditions.push(eq(cards.rarity, filters.rarity));
  }

  const query = db.select().from(cards);
  
  if (conditions.length > 0) {
    query.where(and(...conditions));
  }

  // Removemos o limite de 200 para o gerador de arquétipo ter mais variedade
  // Porém limitamos em 2000 para não quebrar a memória caso não haja filtros
  return await query.limit(2000);
}

export async function getCardById(cardId: number): Promise<Card | null> {
  const db = await getDb();
  if (!db) return null;

  const result = await db.select().from(cards).where(eq(cards.id, cardId)).limit(1);
  return result[0] || null;
}

export async function getCardsByIds(cardIds: number[]): Promise<Card[]> {
  const db = await getDb();
  if (!db) return [];

  if (cardIds.length === 0) return [];

  const { inArray } = await import("drizzle-orm");
  const result = await db.select().from(cards).where(inArray(cards.id, cardIds));
  return result;
}
