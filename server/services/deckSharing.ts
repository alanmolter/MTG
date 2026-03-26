import { getDb } from "../db";
import { eq } from "drizzle-orm";
import { generateDeckVisualization } from "./deckVisualization";
import { deckShares, decks, deckCards, cards } from "../../drizzle/schema";

export interface DeckShareData {
  deckId: number;
  shareId: string;
  title: string;
  description: string;
  imageUrl?: string;
  decklist: string;
  format: string;
  colors: string[];
  createdAt: Date;
  expiresAt?: Date | null;
}

export interface ShareOptions {
  deckId: number;
  title?: string;
  description?: string;
  includeImage?: boolean;
  expiresInDays?: number;
}

/**
 * Create a shareable link for a deck
 */
export async function createDeckShare(options: ShareOptions): Promise<DeckShareData> {
  const { deckId, title, description, includeImage = true, expiresInDays } = options;

  const db = await getDb();
  if (!db) throw new Error("DB unavailable");

  const deckResult = await db
    .select()
    .from(decks)
    .where(eq(decks.id, deckId))
    .limit(1);

  if (!deckResult.length) {
    throw new Error("Deck not found");
  }

  const deck = deckResult[0];

  const deckCardsResult = await db
    .select({
      card: cards,
      quantity: deckCards.quantity,
    })
    .from(deckCards)
    .innerJoin(cards, eq(deckCards.cardId, cards.id))
    .where(eq(deckCards.deckId, deckId));

  const shareId = generateShareId();
  const decklist = generateDecklistText(deck, deckCardsResult);
  const colors = extractDeckColors(deckCardsResult);

  let imageUrl: string | undefined;
  if (includeImage) {
    try {
      const visualization = await generateDeckVisualization({
        deckId,
        style: "fantasy",
        includeCardNames: false,
      });
      imageUrl = visualization.imageUrl;
    } catch (error) {
      console.warn("Failed to generate deck image for sharing:", error);
    }
  }

  const expiresAt = expiresInDays ? new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000) : null;

  const shareInsert = {
    shareId,
    deckId,
    title: title || `${deck.name} - ${deck.format}`,
    description: description || generateDeckDescription(deck, deckCardsResult),
    imageUrl: imageUrl || null,
    decklist,
    format: deck.format,
    colors: JSON.stringify(colors),
    expiresAt,
  };

  await db.insert(deckShares).values(shareInsert);

  return {
    ...shareInsert,
    colors,
    imageUrl: imageUrl || undefined,
    expiresAt: expiresAt || undefined,
    createdAt: new Date(),
  };
}

/**
 * Get shared deck data by share ID
 */
export async function getSharedDeck(shareId: string): Promise<DeckShareData | null> {
  const db = await getDb();
  if (!db) return null;

  const results = await db
    .select()
    .from(deckShares)
    .where(eq(deckShares.shareId, shareId))
    .limit(1);

  if (results.length === 0) return null;
  const share = results[0];

  // Check expiration
  if (share.expiresAt && share.expiresAt < new Date()) {
    return null;
  }

  return {
    ...share,
    description: share.description || "",
    colors: JSON.parse(share.colors || "[]"),
    imageUrl: share.imageUrl || undefined,
    expiresAt: share.expiresAt || undefined,
  };
}

function generateShareId(): string {
  return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
}

function generateDecklistText(deck: any, deckCards: any[]): string {
  let decklist = `${deck.name}\n\n`;
  deckCards.forEach(dc => {
    decklist += `${dc.quantity} ${dc.card.name}\n`;
  });
  return decklist.trim();
}

function generateDeckDescription(deck: any, deckCards: any[]): string {
  const totalCards = deckCards.reduce((sum, dc) => sum + dc.quantity, 0);
  return `${deck.format} deck with ${totalCards} cards`;
}

function extractDeckColors(deckCards: any[]): string[] {
  const colors = new Set<string>();
  for (const dc of deckCards) {
    if (dc.card.colors) {
      dc.card.colors.split('').forEach((c: string) => colors.add(c));
    }
  }
  return Array.from(colors).sort();
}

export function generateShareUrls(shareData: DeckShareData): {
  twitter: string;
  facebook: string;
  reddit: string;
} {
  const baseUrl = `http://localhost:5173/shared/${shareData.shareId}`;
  return {
    twitter: `https://twitter.com/intent/tweet?url=${encodeURIComponent(baseUrl)}`,
    facebook: `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(baseUrl)}`,
    reddit: `https://reddit.com/submit?url=${encodeURIComponent(baseUrl)}`,
  };
}