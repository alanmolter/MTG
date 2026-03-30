import { getDb } from "../db";
import {
  competitiveDecks,
  competitiveDeckCards,
  InsertCompetitiveDeck,
} from "../../drizzle/schema";

const MTGTOP8_BASE_URL = "https://mtgtop8.com";
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const FETCH_TIMEOUT_MS = 20000;

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

export async function importMTGTop8Decks(
  format: string = "modern",
  limit: number = 20
): Promise<ImportResult> {
  const result: ImportResult = { decksImported: 0, cardsImported: 0, decksSkipped: 0, errors: [] };

  try {
    console.log(`[MTGTop8] Buscando decks (${format}, limite: ${limit})...`);
    const deckSummaries = await fetchMTGTop8Decks(format, limit);

    if (deckSummaries.length === 0) {
      console.warn("[MTGTop8] Nenhum deck encontrado. Site pode estar bloqueando.");
      return result;
    }

    console.log(`[MTGTop8] ${deckSummaries.length} decks encontrados. Importando...`);

    for (const summary of deckSummaries) {
      try {
        const deckDetail = await fetchMTGTop8DeckDetail(summary.id);

        const competitiveDeck: InsertCompetitiveDeck = {
          sourceId: `top8-${deckDetail.id}`,
          source: "mtgtop8",
          name: deckDetail.name,
          format,
          archetype: deckDetail.archetype ?? null,
          author: deckDetail.player,
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
            ...deckDetail.mainboard.map((c: any) => ({ ...c, section: "mainboard" })),
            ...deckDetail.sideboard.map((c: any) => ({ ...c, section: "sideboard" })),
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
        await new Promise((r) => setTimeout(r, 500));
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
      ? "Timeout ao conectar ao MTGTop8 (site pode estar bloqueando)"
      : `Erro: ${error?.message}`;
    result.errors.push(msg);
    console.warn(`[MTGTop8] ${msg}`);
  }

  console.log(`[MTGTop8] Concluido: ${result.decksImported} importados, ${result.decksSkipped} pulados.`);
  return result;
}

async function fetchMTGTop8Decks(format: string, limit: number): Promise<any[]> {
  const formatCode = format === "modern" ? "MO" : format === "legacy" ? "LE" : format === "commander" ? "EDH" : "ST";
  const url = `${MTGTOP8_BASE_URL}/format?f=${formatCode}`;
  const response = await fetchWithTimeout(url, { headers: { "User-Agent": USER_AGENT } });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const html = await response.text();
  const deckRegex = /event\?e=(\d+)&d=(\d+)/g;
  const decks: any[] = [];
  const seen = new Set<string>();
  let match;
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
  const response = await fetchWithTimeout(url, { headers: { "User-Agent": USER_AGENT } });
  if (!response.ok) throw new Error(`HTTP ${response.status} ao buscar deck ${deckId}`);
  const text = await response.text();
  const lines = text.split("\n");
  const mainboard: any[] = [];
  const sideboard: any[] = [];
  let isSideboard = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("Sideboard")) { isSideboard = true; continue; }
    const match = /^(\d+)\s+(.+)$/.exec(trimmed);
    if (match) {
      const entry = { quantity: parseInt(match[1]), cardName: match[2].trim() };
      isSideboard ? sideboard.push(entry) : mainboard.push(entry);
    }
  }
  return {
    id: deckId,
    name: "Deck " + deckId.split("&")[0],
    player: "Unknown",
    archetype: null,
    mainboard,
    sideboard,
  };
}
