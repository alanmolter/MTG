import { getDb } from "../db";
import {
  competitiveDecks,
  competitiveDeckCards,
  InsertCompetitiveDeck,
  InsertCompetitiveDeckCard,
} from "../../drizzle/schema";
import { eq, and } from "drizzle-orm";

const MTGTOP8_BASE_URL = "https://mtgtop8.com";
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

export interface ImportResult {
  decksImported: number;
  cardsImported: number;
  errors: string[];
}

export async function importMTGTop8Decks(
  format: string = "modern",
  limit: number = 20
): Promise<ImportResult> {
  const result: ImportResult = {
    decksImported: 0,
    cardsImported: 0,
    errors: [],
  };

  try {
    const deckSummaries = await fetchMTGTop8Decks(format, limit);

    for (const summary of deckSummaries) {
      try {
        const deckDetail = await fetchMTGTop8DeckDetail(summary.id);

        const competitiveDeck: InsertCompetitiveDeck = {
          sourceId: deckDetail.id,
          source: "mtgtop8",
          name: deckDetail.name,
          format: format,
          archetype: deckDetail.archetype || null,
          author: deckDetail.player,
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
        
        await new Promise(r => setTimeout(r, 500));
      } catch (error: any) {
        result.errors.push(`Failed to import deck ${summary.id}: ${error.message}`);
      }
    }
  } catch (error: any) {
    result.errors.push(`Failed to fetch MTGTop8 data: ${error.message}`);
  }

  return result;
}

async function fetchMTGTop8Decks(format: string, limit: number): Promise<any[]> {
  const formatCode = format === "modern" ? "MO" : "ST";
  const url = `${MTGTOP8_BASE_URL}/format?f=${formatCode}`;
  const response = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  
  if (!response.ok) throw new Error(`Status ${response.status}`);
  
  const html = await response.text();
  const deckRegex = /event\?e=(\d+)&d=(\d+)/g;
  const decks: any[] = [];
  let match;
  
  const seen = new Set();
  while ((match = deckRegex.exec(html)) !== null && decks.length < limit) {
    const id = `e=${match[1]}&d=${match[2]}`;
    if (seen.has(id)) continue;
    seen.add(id);
    decks.push({ id });
  }
  
  return decks;
}

async function fetchMTGTop8DeckDetail(deckId: string): Promise<any> {
  const url = `${MTGTOP8_BASE_URL}/mtgo?${deckId}`;
  const response = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  
  if (!response.ok) throw new Error(`Detail Status ${response.status}`);
  
  const text = await response.text();
  const lines = text.split('\n');
  const mainboard: any[] = [];
  const sideboard: any[] = [];
  let isSideboard = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("Sideboard")) {
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
    name: "Deck " + deckId.split('&')[0],
    player: "Unknown",
    mainboard,
    sideboard,
  };
}