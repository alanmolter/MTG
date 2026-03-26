import { getDb } from "../db";
import {
  competitiveDecks,
  competitiveDeckCards,
  InsertCompetitiveDeck,
  InsertCompetitiveDeckCard,
} from "../../drizzle/schema";
import { eq, and } from "drizzle-orm";

const MTGGOLDFISH_BASE_URL = "https://www.mtggoldfish.com";
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

export interface MTGGoldfishDeckSummary {
  id: string;
  name: string;
  format: string;
  archetype?: string;
  author: string;
  views: number;
  likes: number;
}

export interface MTGGoldfishDeckDetail {
  id: string;
  name: string;
  format: string;
  archetype?: string;
  author: string;
  views: number;
  likes: number;
  mainboard: Array<{ cardName: string; quantity: number }>;
  sideboard: Array<{ cardName: string; quantity: number }>;
}

export interface ImportResult {
  decksImported: number;
  cardsImported: number;
  errors: string[];
}

export async function importMTGGoldfishDecks(
  format: string = "modern",
  limit: number = 20
): Promise<ImportResult> {
  const result: ImportResult = {
    decksImported: 0,
    cardsImported: 0,
    errors: [],
  };

  try {
    const deckSummaries = await fetchMTGGoldfishDecks(format, limit);

    for (const summary of deckSummaries) {
      try {
        const deckDetail = await fetchMTGGoldfishDeckDetail(summary.id);

        const competitiveDeck: InsertCompetitiveDeck = {
          sourceId: deckDetail.id,
          source: "mtggoldfish",
          name: deckDetail.name,
          format: format,
          archetype: summary.archetype || null,
          author: deckDetail.author,
          likes: deckDetail.likes,
          views: deckDetail.views,
        };

        const db = await getDb();
        if (!db) continue;

        const [insertedDeck] = await db
          .insert(competitiveDecks)
          .values(competitiveDeck)
          .onConflictDoUpdate({
            target: [competitiveDecks.source, competitiveDecks.sourceId],
            set: { name: deckDetail.name },
          })
          .returning({ id: competitiveDecks.id });

        if (insertedDeck) {
          result.decksImported++;

          const allCards = [
            ...deckDetail.mainboard.map(c => ({ ...c, section: "mainboard" })),
            ...deckDetail.sideboard.map(c => ({ ...c, section: "sideboard" }))
          ];

          for (const card of allCards) {
             await db.insert(competitiveDeckCards).values({
               deckId: insertedDeck.id,
               cardName: card.cardName,
               quantity: card.quantity,
               section: card.section as any,
             }).onConflictDoUpdate({
               target: [competitiveDeckCards.deckId, competitiveDeckCards.cardName, competitiveDeckCards.section],
               set: { quantity: card.quantity }
             });
             result.cardsImported++;
          }
        }
        
        // Wait to avoid rate limit
        await new Promise(r => setTimeout(r, 500));
      } catch (error: any) {
        result.errors.push(`Failed to import deck ${summary.id}: ${error.message}`);
      }
    }
  } catch (error: any) {
    result.errors.push(`Failed to fetch MTGGoldfish data: ${error.message}`);
  }

  return result;
}

async function fetchMTGGoldfishDecks(format: string, limit: number): Promise<MTGGoldfishDeckSummary[]> {
  const url = `${MTGGOLDFISH_BASE_URL}/metagame/${format}/full`;
  const response = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  
  if (!response.ok) throw new Error(`Status ${response.status}`);
  
  const html = await response.text();
  const decks: MTGGoldfishDeckSummary[] = [];
  const deckRegex = /\/deck\/(\d+)#paper/g;
  let match;
  
  const seen = new Set();
  while ((match = deckRegex.exec(html)) !== null && decks.length < limit) {
    const id = match[1];
    if (seen.has(id)) continue;
    seen.add(id);
    decks.push({
      id,
      name: "Goldfish Deck",
      format,
      author: "Unknown",
      views: 0,
      likes: 0
    });
  }
  
  return decks;
}

async function fetchMTGGoldfishDeckDetail(deckId: string): Promise<MTGGoldfishDeckDetail> {
  const url = `${MTGGOLDFISH_BASE_URL}/deck/download/${deckId}`;
  const response = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  
  if (!response.ok) throw new Error(`Detail Status ${response.status}`);
  
  const text = await response.text();
  const lines = text.split('\n');
  const mainboard: any[] = [];
  const sideboard: any[] = [];
  let isSideboard = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      isSideboard = true;
      continue;
    }
    
    const match = /^(\d+)\s+(.+)$/.exec(trimmed);
    if (match) {
      const quantity = parseInt(match[1]);
      const cardName = match[2].trim();
      if (isSideboard) {
        sideboard.push({ cardName, quantity });
      } else {
        mainboard.push({ cardName, quantity });
      }
    }
  }

  return {
    id: deckId,
    name: "Deck " + deckId,
    format: "modern",
    author: "MTGGoldfish",
    views: 0,
    likes: 0,
    mainboard,
    sideboard,
  };
}