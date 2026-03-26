import { getDb } from "../db";
import {
  competitiveDecks,
  competitiveDeckCards,
  InsertCompetitiveDeck,
  InsertCompetitiveDeckCard,
} from "../../drizzle/schema";
import { eq } from "drizzle-orm";

const MTGTOP8_BASE_URL = "https://mtgtop8.com";
const USER_AGENT = "MTGDeckEngine/1.0 (educational project)";

export interface MTGTop8DeckSummary {
  id: string;
  name: string;
  format: string;
  archetype?: string;
  player: string;
  tournament: string;
  placement: string;
  date: string;
  colors?: string[];
}

export interface MTGTop8DeckDetail {
  id: string;
  name: string;
  format: string;
  archetype?: string;
  player: string;
  tournament: string;
  placement: string;
  date: string;
  mainboard: Array<{ cardName: string; quantity: number; cardId?: string }>;
  sideboard: Array<{ cardName: string; quantity: number; cardId?: string }>;
}

export interface ImportResult {
  decksImported: number;
  cardsImported: number;
  errors: string[];
}

/**
 * Import decks from MTGTop8 for a specific format
 */
export async function importMTGTop8Decks(
  format: string = "standard",
  limit: number = 50
): Promise<ImportResult> {
  const result: ImportResult = {
    decksImported: 0,
    cardsImported: 0,
    errors: [],
  };

  try {
    // Get recent tournament decks for the format
    const deckSummaries = await fetchMTGTop8Decks(format, limit);

    for (const summary of deckSummaries) {
      try {
        // Get detailed deck information
        const deckDetail = await fetchMTGTop8DeckDetail(summary.id);

        // Convert to our schema format
        const competitiveDeck: InsertCompetitiveDeck = {
          name: deckDetail.name,
          format: deckDetail.format,
          archetype: deckDetail.archetype,
          source: "mtgtop8",
          sourceId: deckDetail.id,
          author: deckDetail.player,
          tournament: deckDetail.tournament,
          placement: deckDetail.placement,
          colors: deckDetail.mainboard
            .filter(card => card.cardId)
            .map(card => card.cardId!)
            .slice(0, 5) // Just get first 5 cards for color detection
            .join(","),
          createdAt: new Date(),
          updatedAt: new Date(),
        };

        // Insert deck
        const db = getDb();
        const [insertedDeck] = await db
          .insert(competitiveDecks)
          .values(competitiveDeck)
          .onDuplicateKeyUpdate({
            set: {
              updatedAt: new Date(),
            },
          })
          .returning();

        if (insertedDeck) {
          result.decksImported++;

          // Insert mainboard cards
          const mainboardCards: InsertCompetitiveDeckCard[] = deckDetail.mainboard
            .filter(card => card.cardId)
            .map(card => ({
              competitiveDeckId: insertedDeck.id,
              cardId: parseInt(card.cardId!),
              quantity: card.quantity,
              isSideboard: false,
              createdAt: new Date(),
              updatedAt: new Date(),
            }));

          // Insert sideboard cards
          const sideboardCards: InsertCompetitiveDeckCard[] = deckDetail.sideboard
            .filter(card => card.cardId)
            .map(card => ({
              competitiveDeckId: insertedDeck.id,
              cardId: parseInt(card.cardId!),
              quantity: card.quantity,
              isSideboard: true,
              createdAt: new Date(),
              updatedAt: new Date(),
            }));

          const allCards = [...mainboardCards, ...sideboardCards];

          if (allCards.length > 0) {
            await db
              .insert(competitiveDeckCards)
              .values(allCards)
              .onDuplicateKeyUpdate({
                set: {
                  quantity: allCards[0].quantity, // Use the new quantity
                  updatedAt: new Date(),
                },
              });

            result.cardsImported += allCards.length;
          }
        }
      } catch (error) {
        result.errors.push(`Failed to import deck ${summary.id}: ${error}`);
      }
    }
  } catch (error) {
    result.errors.push(`Failed to fetch MTGTop8 data: ${error}`);
  }

  return result;
}

/**
 * Fetch deck summaries from MTGTop8
 */
async function fetchMTGTop8Decks(format: string, limit: number): Promise<MTGTop8DeckSummary[]> {
  // MTGTop8 doesn't have a clean API, so we'll use web scraping approach
  // This is a simplified implementation - in practice, you'd need more robust parsing

  const formatMap: Record<string, string> = {
    standard: "ST",
    pioneer: "PI",
    modern: "MO",
    legacy: "LE",
    vintage: "VI",
    commander: "EDH",
  };

  const formatCode = formatMap[format] || "ST";
  const url = `${MTGTOP8_BASE_URL}/format?f=${formatCode}`;

  const response = await fetch(url, {
    headers: {
      "User-Agent": USER_AGENT,
    },
  });

  if (!response.ok) {
    throw new Error(`MTGTop8 request failed: ${response.status}`);
  }

  const html = await response.text();

  // Parse HTML to extract deck information
  // This is a basic implementation - you'd need more sophisticated parsing
  const decks: MTGTop8DeckSummary[] = [];

  // Extract deck links and basic info from HTML
  // Note: This is simplified - real implementation would use cheerio or similar
  const deckRegex = /<td[^>]*><a[^>]*href="\/event\?([^"]*)"[^>]*>([^<]*)<\/a><\/td>/g;
  let match;

  while ((match = deckRegex.exec(html)) !== null && decks.length < limit) {
    const eventId = match[1];
    const deckName = match[2];

    decks.push({
      id: eventId,
      name: deckName,
      format,
      player: "Unknown", // Would need to parse from HTML
      tournament: "Unknown", // Would need to parse from HTML
      placement: "Unknown", // Would need to parse from HTML
      date: new Date().toISOString().split('T')[0],
    });
  }

  return decks;
}

/**
 * Fetch detailed deck information from MTGTop8
 */
async function fetchMTGTop8DeckDetail(deckId: string): Promise<MTGTop8DeckDetail> {
  const url = `${MTGTOP8_BASE_URL}/event?${deckId}`;

  const response = await fetch(url, {
    headers: {
      "User-Agent": USER_AGENT,
    },
  });

  if (!response.ok) {
    throw new Error(`MTGTop8 deck detail request failed: ${response.status}`);
  }

  const html = await response.text();

  // Parse detailed deck information
  // This is simplified - real implementation would need proper HTML parsing

  const mainboard: Array<{ cardName: string; quantity: number; cardId?: string }> = [];
  const sideboard: Array<{ cardName: string; quantity: number; cardId?: string }> = [];

  // Extract mainboard cards
  const mainboardRegex = /<td[^>]*class="[^"]*G14[^"]*"[^>]*>(\d+)<\/td>\s*<td[^>]*><a[^>]*>([^<]+)<\/a><\/td>/g;
  let match;

  while ((match = mainboardRegex.exec(html)) !== null) {
    const quantity = parseInt(match[1]);
    const cardName = match[2].trim();

    // Try to find card ID from our database
    const cardId = await findCardIdByName(cardName);

    mainboard.push({
      cardName,
      quantity,
      cardId: cardId?.toString(),
    });
  }

  // Extract sideboard cards (similar logic)
  const sideboardRegex = /<td[^>]*class="[^"]*G13[^"]*"[^>]*>(\d+)<\/td>\s*<td[^>]*><a[^>]*>([^<]+)<\/a><\/td>/g;

  while ((match = sideboardRegex.exec(html)) !== null) {
    const quantity = parseInt(match[1]);
    const cardName = match[2].trim();

    const cardId = await findCardIdByName(cardName);

    sideboard.push({
      cardName,
      quantity,
      cardId: cardId?.toString(),
    });
  }

  return {
    id: deckId,
    name: "Deck from MTGTop8", // Would need to parse from HTML
    format: "standard", // Would need to parse from HTML
    player: "Unknown",
    tournament: "Unknown",
    placement: "Unknown",
    date: new Date().toISOString().split('T')[0],
    mainboard,
    sideboard,
  };
}

/**
 * Find card ID by name in our database
 */
async function findCardIdByName(cardName: string): Promise<number | null> {
  const db = getDb();
  const { cards } = await import("../../drizzle/schema");

  const result = await db
    .select({ id: cards.id })
    .from(cards)
    .where(eq(cards.name, cardName))
    .limit(1);

  return result[0]?.id || null;
}