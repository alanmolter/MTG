import { getDb } from "../db";
import {
  competitiveDecks,
  competitiveDeckCards,
  InsertCompetitiveDeck,
  InsertCompetitiveDeckCard,
} from "../../drizzle/schema";
import { eq } from "drizzle-orm";

const MTGGOLDFISH_BASE_URL = "https://www.mtggoldfish.com";
const USER_AGENT = "MTGDeckEngine/1.0 (educational project)";

export interface MTGGoldfishDeckSummary {
  id: string;
  name: string;
  format: string;
  archetype?: string;
  author: string;
  views: number;
  likes: number;
  colors?: string[];
}

export interface MTGGoldfishDeckDetail {
  id: string;
  name: string;
  format: string;
  archetype?: string;
  author: string;
  views: number;
  likes: number;
  mainboard: Array<{ cardName: string; quantity: number; cardId?: string }>;
  sideboard: Array<{ cardName: string; quantity: number; cardId?: string }>;
}

export interface ImportResult {
  decksImported: number;
  cardsImported: number;
  errors: string[];
}

/**
 * Import decks from MTGGoldfish for a specific format
 */
export async function importMTGGoldfishDecks(
  format: string = "standard",
  limit: number = 50
): Promise<ImportResult> {
  const result: ImportResult = {
    decksImported: 0,
    cardsImported: 0,
    errors: [],
  };

  try {
    // Get recent decks for the format
    const deckSummaries = await fetchMTGGoldfishDecks(format, limit);

    for (const summary of deckSummaries) {
      try {
        // Get detailed deck information
        const deckDetail = await fetchMTGGoldfishDeckDetail(summary.id);

        // Convert to our schema format
        const competitiveDeck: InsertCompetitiveDeck = {
          name: deckDetail.name,
          format: deckDetail.format,
          archetype: deckDetail.archetype,
          source: "mtggoldfish",
          sourceId: deckDetail.id,
          author: deckDetail.author,
          colors: deckDetail.mainboard
            .filter(card => card.cardId)
            .map(card => card.cardId!)
            .slice(0, 5)
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
                  quantity: allCards[0].quantity,
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
    result.errors.push(`Failed to fetch MTGGoldfish data: ${error}`);
  }

  return result;
}

/**
 * Fetch deck summaries from MTGGoldfish
 */
async function fetchMTGGoldfishDecks(format: string, limit: number): Promise<MTGGoldfishDeckSummary[]> {
  const formatMap: Record<string, string> = {
    standard: "standard",
    pioneer: "pioneer",
    modern: "modern",
    legacy: "legacy",
    vintage: "vintage",
    commander: "commander",
  };

  const formatPath = formatMap[format] || "standard";
  const url = `${MTGGOLDFISH_BASE_URL}/metagame/${formatPath}/full`;

  const response = await fetch(url, {
    headers: {
      "User-Agent": USER_AGENT,
    },
  });

  if (!response.ok) {
    throw new Error(`MTGGoldfish request failed: ${response.status}`);
  }

  const html = await response.text();

  // Parse HTML to extract deck information
  const decks: MTGGoldfishDeckSummary[] = [];

  // Extract deck links from the metagame page
  const deckRegex = /<a[^>]*href="\/deck\/(\d+)"[^>]*class="[^"]*deck-link[^"]*"[^>]*>([^<]*)<\/a>/g;
  let match;

  while ((match = deckRegex.exec(html)) !== null && decks.length < limit) {
    const deckId = match[1];
    const deckName = match[2].trim();

    decks.push({
      id: deckId,
      name: deckName,
      format,
      author: "Unknown", // Would need to parse from HTML
      views: 0,
      likes: 0,
    });
  }

  return decks;
}

/**
 * Fetch detailed deck information from MTGGoldfish
 */
async function fetchMTGGoldfishDeckDetail(deckId: string): Promise<MTGGoldfishDeckDetail> {
  const url = `${MTGGOLDFISH_BASE_URL}/deck/${deckId}`;

  const response = await fetch(url, {
    headers: {
      "User-Agent": USER_AGENT,
    },
  });

  if (!response.ok) {
    throw new Error(`MTGGoldfish deck detail request failed: ${response.status}`);
  }

  const html = await response.text();

  // Parse detailed deck information
  const mainboard: Array<{ cardName: string; quantity: number; cardId?: string }> = [];
  const sideboard: Array<{ cardName: string; quantity: number; cardId?: string }> = [];

  // Extract mainboard cards
  const mainboardRegex = /<td[^>]*class="[^"]*text-center[^"]*"[^>]*>(\d+)<\/td>\s*<td[^>]*>\s*<a[^>]*>([^<]+)<\/a>/g;
  let match;

  while ((match = mainboardRegex.exec(html)) !== null) {
    const quantity = parseInt(match[1]);
    const cardName = match[2].trim();

    const cardId = await findCardIdByName(cardName);

    mainboard.push({
      cardName,
      quantity,
      cardId: cardId?.toString(),
    });
  }

  // Extract sideboard cards
  const sideboardRegex = /<td[^>]*class="[^"]*text-center[^"]*sideboard[^"]*"[^>]*>(\d+)<\/td>\s*<td[^>]*>\s*<a[^>]*>([^<]+)<\/a>/g;

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
    name: "Deck from MTGGoldfish", // Would need to parse from HTML
    format: "standard", // Would need to parse from HTML
    author: "Unknown",
    views: 0,
    likes: 0,
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