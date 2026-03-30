import { getDb } from "../db";
import {
  competitiveDecks,
  competitiveDeckCards,
  InsertCompetitiveDeck,
} from "../../drizzle/schema";

const MTGGOLDFISH_BASE_URL = "https://www.mtggoldfish.com";
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const FETCH_TIMEOUT_MS = 20000;

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
  decksSkipped: number;
  errors: string[];
}

async function fetchWithTimeout(url: string, options: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export async function importMTGGoldfishDecks(
  format: string = "modern",
  limit: number = 20
): Promise<ImportResult> {
  const result: ImportResult = { decksImported: 0, cardsImported: 0, decksSkipped: 0, errors: [] };

  try {
    console.log(`[MTGGoldfish] Buscando decks (${format}, limite: ${limit})...`);
    const deckSummaries = await fetchMTGGoldfishDecks(format, limit);

    if (deckSummaries.length === 0) {
      console.warn("[MTGGoldfish] Nenhum deck encontrado. Site pode estar bloqueando.");
      return result;
    }

    console.log(`[MTGGoldfish] ${deckSummaries.length} decks encontrados. Importando...`);

    for (const summary of deckSummaries) {
      try {
        const deckDetail = await fetchMTGGoldfishDeckDetail(summary.id);

        const competitiveDeck: InsertCompetitiveDeck = {
          sourceId: `goldfish-${deckDetail.id}`,
          source: "mtggoldfish",
          name: deckDetail.name,
          format,
          archetype: summary.archetype ?? null,
          author: deckDetail.author,
          likes: deckDetail.likes,
          views: deckDetail.views,
          isSynthetic: false,
        };

        const db = await getDb();
        if (!db) continue;

        const [insertedDeck] = await db
          .insert(competitiveDecks)
          .values(competitiveDeck)
          .onConflictDoUpdate({
            target: competitiveDecks.sourceId,
            set: { name: deckDetail.name },
          })
          .returning({ id: competitiveDecks.id });

        if (insertedDeck) {
          result.decksImported++;
          const allCards = [
            ...deckDetail.mainboard.map((c) => ({ ...c, section: "mainboard" })),
            ...deckDetail.sideboard.map((c) => ({ ...c, section: "sideboard" })),
          ];
          for (const card of allCards) {
            await db.insert(competitiveDeckCards).values({
              deckId: insertedDeck.id,
              cardName: card.cardName,
              quantity: card.quantity,
              section: card.section as any,
            }).onConflictDoUpdate({
              target: [competitiveDeckCards.deckId, competitiveDeckCards.cardName, competitiveDeckCards.section],
              set: { quantity: card.quantity },
            });
            result.cardsImported++;
          }
        } else {
          result.decksSkipped++;
        }
        await new Promise((r) => setTimeout(r, 300));
      } catch (error: any) {
        const msg = error?.name === "AbortError"
          ? `Timeout ao buscar deck ${summary.id}`
          : `Erro no deck ${summary.id}: ${error?.message}`;
        result.errors.push(msg);
        result.decksSkipped++;
      }
    }
  } catch (error: any) {
    const msg = error?.name === "AbortError"
      ? "Timeout ao conectar ao MTGGoldfish (site pode estar bloqueando)"
      : `Erro: ${error?.message}`;
    result.errors.push(msg);
    console.warn(`[MTGGoldfish] ${msg}`);
  }

  console.log(`[MTGGoldfish] Concluido: ${result.decksImported} importados, ${result.decksSkipped} pulados.`);
  return result;
}

async function fetchMTGGoldfishDecks(format: string, limit: number): Promise<MTGGoldfishDeckSummary[]> {
  const url = `${MTGGOLDFISH_BASE_URL}/metagame/${format}/full`;
  const response = await fetchWithTimeout(url, { headers: { "User-Agent": USER_AGENT } });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const html = await response.text();
  const decks: MTGGoldfishDeckSummary[] = [];
  const deckRegex = /\/deck\/(\d+)#paper/g;
  const seen = new Set<string>();
  let match;
  while ((match = deckRegex.exec(html)) !== null && decks.length < limit) {
    const id = match[1];
    if (seen.has(id)) continue;
    seen.add(id);
    decks.push({ id, name: "Goldfish Deck", format, author: "Unknown", views: 0, likes: 0 });
  }
  return decks;
}

async function fetchMTGGoldfishDeckDetail(deckId: string): Promise<MTGGoldfishDeckDetail> {
  const url = `${MTGGOLDFISH_BASE_URL}/deck/download/${deckId}`;
  const response = await fetchWithTimeout(url, { headers: { "User-Agent": USER_AGENT } });
  if (!response.ok) throw new Error(`HTTP ${response.status} ao buscar deck ${deckId}`);
  const text = await response.text();
  const lines = text.split("\n");
  const mainboard: any[] = [];
  const sideboard: any[] = [];
  let isSideboard = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) { isSideboard = true; continue; }
    const match = /^(\d+)\s+(.+)$/.exec(trimmed);
    if (match) {
      const entry = { quantity: parseInt(match[1]), cardName: match[2].trim() };
      isSideboard ? sideboard.push(entry) : mainboard.push(entry);
    }
  }
  return { id: deckId, name: `Deck ${deckId}`, format: "modern", author: "MTGGoldfish", views: 0, likes: 0, mainboard, sideboard };
}
