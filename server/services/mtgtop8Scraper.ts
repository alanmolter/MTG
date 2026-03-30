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

/**
 * Extrai pares (e, d) de deck da página de um archetype específico.
 * Exemplo: https://mtgtop8.com/archetype?a=193&meta=54&f=MO
 * Retorna pares { e, d } para construir URLs de download.
 */
async function getDeckIdsFromArchetype(
  archetypeId: string,
  metaId: string,
  formatCode: string,
  archetypeName: string,
  maxDecks = 5
): Promise<{ e: string; d: string; name: string }[]> {
  const url = `${MTGTOP8_BASE_URL}/archetype?a=${archetypeId}&meta=${metaId}&f=${formatCode}`;
  try {
    const response = await fetchWithTimeout(url, { headers: { "User-Agent": USER_AGENT } });
    if (!response.ok) return [];
    const html = await response.text();
    // Padrão: event?e=82539&d=827346
    const deckRegex = /event\?e=(\d+)&d=(\d+)/g;
    const seen = new Set<string>();
    const results: { e: string; d: string; name: string }[] = [];
    let match;
    while ((match = deckRegex.exec(html)) !== null && results.length < maxDecks) {
      const key = `${match[1]}_${match[2]}`;
      if (!seen.has(key)) {
        seen.add(key);
        results.push({ e: match[1], d: match[2], name: archetypeName });
      }
    }
    return results;
  } catch {
    return [];
  }
}

export async function importMTGTop8Decks(
  format: string = "modern",
  limit: number = 20
): Promise<ImportResult> {
  const result: ImportResult = { decksImported: 0, cardsImported: 0, decksSkipped: 0, errors: [] };

  const formatCode = format === "modern" ? "MO"
    : format === "legacy" ? "LE"
    : format === "commander" ? "EDH"
    : format === "pioneer" ? "PI"
    : format === "pauper" ? "PAU"
    : "ST";

  const url = `${MTGTOP8_BASE_URL}/format?f=${formatCode}`;
  console.log(`  [MTGTop8] Conectando a: ${url}`);
  console.log(`  [MTGTop8] Aguardando resposta (timeout: ${FETCH_TIMEOUT_MS / 1000}s)...`);

  // Estrutura: { archetypeId, metaId, name }
  let archetypes: { id: string; meta: string; name: string }[] = [];

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

    // ESTRATÉGIA ATUALIZADA: extrair archetypes da página de formato
    // Padrão: archetype?a=193&meta=54&f=MO>Boros Aggro</a>
    const archetypeRegex = /archetype\?a=(\d+)&meta=(\d+)&f=[^>]+>([^<]+)<\/a>/g;
    const seenIds = new Set<string>();
    let match;
    while ((match = archetypeRegex.exec(html)) !== null) {
      const id = match[1];
      const meta = match[2];
      const name = match[3].trim();
      if (!seenIds.has(id)) {
        seenIds.add(id);
        archetypes.push({ id, meta, name });
      }
    }

    console.log(`  [MTGTop8] ${archetypes.length} arquetipos encontrados no formato ${format.toUpperCase()}`);

    if (archetypes.length === 0) {
      console.warn(`  [MTGTop8] Nenhum arquetipo encontrado. HTML pode ter mudado de estrutura.`);
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

  // Calcular quantos decks por archetype
  const decksPerArchetype = Math.max(1, Math.ceil(limit / Math.min(archetypes.length, limit)));
  const archetypesToProcess = archetypes.slice(0, Math.min(archetypes.length, limit));

  console.log(`  [MTGTop8] Coletando ate ${decksPerArchetype} deck(s) de cada arquetipo (${archetypesToProcess.length} arquetipos)...`);

  // Coletar IDs de deck de cada archetype
  const deckSummaries: { e: string; d: string; name: string; archetype: string }[] = [];
  for (let i = 0; i < archetypesToProcess.length && deckSummaries.length < limit; i++) {
    const arch = archetypesToProcess[i];
    const entries = await getDeckIdsFromArchetype(arch.id, arch.meta, formatCode, arch.name, decksPerArchetype);
    for (const entry of entries) {
      if (deckSummaries.length >= limit) break;
      deckSummaries.push({ ...entry, archetype: arch.name });
    }
    await new Promise((r) => setTimeout(r, 200)); // Rate limiting
  }

  console.log(`  [MTGTop8] ${deckSummaries.length} decks encontrados no formato ${format.toUpperCase()}`);

  if (deckSummaries.length === 0) {
    console.warn(`  [MTGTop8] Nenhum deck encontrado nos arquetipos.`);
    return result;
  }

  console.log(`  [MTGTop8] Baixando detalhes de ${deckSummaries.length} decks...`);

  for (let i = 0; i < deckSummaries.length; i++) {
    const summary = deckSummaries[i];
    const progress = bar(i + 1, deckSummaries.length);
    process.stdout.write(`\r  [MTGTop8] ${progress} ${i + 1}/${deckSummaries.length} deck: e=${summary.e}&d=${summary.d}`);

    try {
      // URL de download MTGO: https://mtgtop8.com/mtgo?e=82539&d=827346
      const deckUrl = `${MTGTOP8_BASE_URL}/mtgo?e=${summary.e}&d=${summary.d}`;
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
        if (trimmed.toLowerCase().startsWith("sideboard")) { isSideboard = true; continue; }
        const m = /^(\d+)\s+(.+)$/.exec(trimmed);
        if (m) {
          const entry = { quantity: parseInt(m[1]), cardName: m[2].trim() };
          isSideboard ? sideboard.push(entry) : mainboard.push(entry);
        }
      }

      // Ignorar decks vazios
      if (mainboard.length === 0) {
        result.decksSkipped++;
        continue;
      }

      const deckId = `e=${summary.e}&d=${summary.d}`;
      const competitiveDeck: InsertCompetitiveDeck = {
        sourceId: `top8-${deckId}`,
        source: "mtgtop8",
        name: summary.name || `Deck ${deckId}`,
        format,
        archetype: summary.archetype || null,
        author: "MTGTop8",
        isSynthetic: false,
      };

      const db = await getDb();
      if (!db) continue;

      const [insertedDeck] = await db
        .insert(competitiveDecks)
        .values(competitiveDeck)
        .onConflictDoUpdate({
          target: competitiveDecks.sourceId,
          set: { name: competitiveDeck.name },
        })
        .returning({ id: competitiveDecks.id });

      if (insertedDeck) {
        result.decksImported++;
        const allCards = [
          ...mainboard.map((c: any) => ({ ...c, section: "mainboard" })),
          ...sideboard.map((c: any) => ({ ...c, section: "sideboard" })),
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

      await new Promise((r) => setTimeout(r, 400));
    } catch (error: any) {
      const msg = error?.name === "AbortError"
        ? `Timeout no deck e=${summary.e}&d=${summary.d}`
        : `Erro no deck e=${summary.e}&d=${summary.d}: ${error?.message}`;
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
