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

function bar(current: number, total: number, width = 20): string {
  const filled = Math.round((current / total) * width);
  return "[" + "#".repeat(filled) + "-".repeat(width - filled) + "]";
}

export async function importMTGTop8Decks(
  format: string = "modern",
  limit: number = 20
): Promise<ImportResult> {
  const result: ImportResult = { decksImported: 0, cardsImported: 0, decksSkipped: 0, errors: [] };

  const formatCode = format === "modern" ? "MO" : format === "legacy" ? "LE" : format === "commander" ? "EDH" : "ST";
  const url = `${MTGTOP8_BASE_URL}/format?f=${formatCode}`;
  console.log(`  [MTGTop8] Conectando a: ${url}`);
  console.log(`  [MTGTop8] Aguardando resposta (timeout: ${FETCH_TIMEOUT_MS / 1000}s)...`);

  let deckSummaries: any[] = [];

  try {
    const t0 = Date.now();
    const response = await fetchWithTimeout(url, { headers: { "User-Agent": USER_AGENT } });
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

    if (!response.ok) {
      console.warn(`  [MTGTop8] HTTP ${response.status} — site pode estar bloqueando. Pulando.`);
      return result;
    }

    const html = await response.text();
    console.log(`  [MTGTop8] Resposta recebida em ${elapsed}s (${(html.length / 1024).toFixed(0)} KB)`);

    const deckRegex = /event\?e=(\d+)&d=(\d+)/g;
    const seen = new Set<string>();
    let match;
    while ((match = deckRegex.exec(html)) !== null && deckSummaries.length < limit) {
      const id = `e=${match[1]}&d=${match[2]}`;
      if (seen.has(id)) continue;
      seen.add(id);
      deckSummaries.push({ id });
    }

    console.log(`  [MTGTop8] ${deckSummaries.length} decks encontrados no formato ${format.toUpperCase()}`);

    if (deckSummaries.length === 0) {
      console.warn(`  [MTGTop8] Nenhum deck encontrado. HTML pode ter mudado de estrutura.`);
      return result;
    }
  } catch (error: any) {
    const msg = error?.name === "AbortError"
      ? `Timeout (${FETCH_TIMEOUT_MS / 1000}s) ao conectar — site bloqueando ou lento`
      : `Erro de conexao: ${error?.message}`;
    console.warn(`  [MTGTop8] ${msg}`);
    result.errors.push(msg);
    return result;
  }

  console.log(`  [MTGTop8] Baixando detalhes de ${deckSummaries.length} decks...`);

  for (let i = 0; i < deckSummaries.length; i++) {
    const summary = deckSummaries[i];
    const progress = bar(i + 1, deckSummaries.length);
    process.stdout.write(`\r  [MTGTop8] ${progress} ${i + 1}/${deckSummaries.length} deck: ${summary.id}`);

    try {
      const deckUrl = `${MTGTOP8_BASE_URL}/mtgo?${summary.id}`;
      const response = await fetchWithTimeout(deckUrl, { headers: { "User-Agent": USER_AGENT } });

      if (!response.ok) {
        result.decksSkipped++;
        continue;
      }

      const text = await response.text();
      const lines = text.split("\n");
      const mainboard: any[] = [];
      const sideboard: any[] = [];
      let isSideboard = false;

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        if (trimmed.startsWith("Sideboard")) { isSideboard = true; continue; }
        const m = /^(\d+)\s+(.+)$/.exec(trimmed);
        if (m) {
          const entry = { quantity: parseInt(m[1]), cardName: m[2].trim() };
          isSideboard ? sideboard.push(entry) : mainboard.push(entry);
        }
      }

      const deckDetail = {
        id: summary.id,
        name: "Deck " + summary.id.split("&")[0],
        player: "Unknown",
        archetype: null as string | null,
        mainboard,
        sideboard,
      };

      const competitiveDeck: InsertCompetitiveDeck = {
        sourceId: `top8-${deckDetail.id}`,
        source: "mtgtop8",
        name: deckDetail.name,
        format,
        archetype: deckDetail.archetype,
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
        ? `Timeout no deck ${summary.id}`
        : `Erro no deck ${summary.id}: ${error?.message}`;
      result.errors.push(msg);
      result.decksSkipped++;
    }
  }

  process.stdout.write("\n");
  console.log(`  [MTGTop8] Concluido: ${result.decksImported} importados, ${result.decksSkipped} pulados, ${result.cardsImported} cartas.`);
  if (result.errors.length > 0) {
    console.warn(`  [MTGTop8] ${result.errors.length} avisos: ${result.errors.slice(0, 2).join("; ")}`);
  }

  return result;
}
