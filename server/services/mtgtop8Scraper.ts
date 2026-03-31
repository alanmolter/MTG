import { getDb } from "../db";
import { sql } from "drizzle-orm";

const MTGTOP8_BASE_URL = "https://mtgtop8.com";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

/** Timeout por requisição individual */
const FETCH_TIMEOUT_MS = 20_000;

/** Máximo de downloads simultâneos de decks */
const DOWNLOAD_CONCURRENCY = 3;

/** Delay entre batches de download (ms) */
const BATCH_DELAY_MS = 600;

/**
 * Mapeamento de formato legível → código MTGTop8
 * NOTA: Commander (EDH) não tem metagame público no MTGTop8, apenas eventos.
 */
export const TOP8_FORMAT_MAP: Record<string, string> = {
  standard: "ST",
  modern: "MO",
  legacy: "LE",
  pioneer: "PI",
  pauper: "PAU",
  vintage: "VI",
};

export const TOP8_FORMATS = Object.keys(TOP8_FORMAT_MAP) as Array<
  keyof typeof TOP8_FORMAT_MAP
>;

export interface ImportResult {
  decksImported: number;
  cardsImported: number;
  decksSkipped: number;
  errors: string[];
}

// ─── Utilitários ──────────────────────────────────────────────────────────────

async function fetchWithTimeout(
  url: string,
  options: RequestInit = {}
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function bar(current: number, total: number, width = 20): string {
  const filled = total > 0 ? Math.round((current / total) * width) : 0;
  return "[" + "█".repeat(filled) + "░".repeat(width - filled) + "]";
}

async function runInBatches<T>(
  tasks: (() => Promise<T>)[],
  concurrency: number,
  delayMs = 0
): Promise<T[]> {
  const results: T[] = [];
  for (let i = 0; i < tasks.length; i += concurrency) {
    const batch = tasks.slice(i, i + concurrency).map((fn) => fn());
    const batchResults = await Promise.all(batch);
    results.push(...batchResults);
    if (delayMs > 0 && i + concurrency < tasks.length) {
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  return results;
}

// ─── Extração de archetypes da página de formato ──────────────────────────────

/**
 * CORREÇÃO CRÍTICA: O MTGTop8 usa HTML sem aspas nos atributos href.
 * Padrão real: <a href=archetype?a=193&meta=54&f=MO>Boros Aggro</a>
 * (sem aspas ao redor do valor do href)
 *
 * O regex anterior usava /archetype\?a=(\d+)&meta=(\d+)&f=[^>]+>([^<]+)<\/a>/g
 * que só funciona com href="..." (com aspas). Corrigido para aceitar ambos.
 */
function extractArchetypes(
  html: string
): Array<{ id: string; meta: string; name: string }> {
  const archetypes: Array<{ id: string; meta: string; name: string }> = [];
  const seenIds = new Set<string>();

  // Regex que aceita href com ou sem aspas
  // Padrão sem aspas: href=archetype?a=193&meta=54&f=MO>Nome</a>
  // Padrão com aspas: href="archetype?a=193&meta=54&f=MO">Nome</a>
  const regex =
    /href=["']?archetype\?a=(\d+)&(?:amp;)?meta=(\d+)&(?:amp;)?f=[A-Z]+["']?\s*>([^<]+)<\/a>/g;

  let match;
  while ((match = regex.exec(html)) !== null) {
    const id = match[1];
    const meta = match[2];
    const name = match[3].trim();
    if (!seenIds.has(id) && name.length > 0) {
      seenIds.add(id);
      archetypes.push({ id, meta, name });
    }
  }

  return archetypes;
}

// ─── Extração de deck IDs por archetype ───────────────────────────────────────

/**
 * Extrai pares (e, d) de deck da página de um archetype específico.
 * Padrão: event?e=82539&d=827346 (sem aspas no href)
 */
async function getDeckIdsFromArchetype(
  archetypeId: string,
  metaId: string,
  formatCode: string,
  archetypeName: string,
  maxDecks = 5
): Promise<Array<{ e: string; d: string; name: string }>> {
  const url = `${MTGTOP8_BASE_URL}/archetype?a=${archetypeId}&meta=${metaId}&f=${formatCode}`;
  try {
    const response = await fetchWithTimeout(url, {
      headers: { "User-Agent": USER_AGENT },
    });
    if (!response.ok) return [];
    const html = await response.text();

    // Padrão real do HTML do MTGTop8 (sem aspas, com barra inicial e &f=):
    //   href=/event?e=82623&d=828015&f=MO
    // O regex aceita: barra opcional, & ou &amp;, parâmetro &f= opcional, com ou sem aspas
    const deckRegex =
      /href=["']?\/?event\?e=(\d+)&(?:amp;)?d=(\d+)(?:&(?:amp;)?f=[A-Z]+)?["']?/g;
    const seen = new Set<string>();
    const results: Array<{ e: string; d: string; name: string }> = [];
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

// ─── Download e parse de deck individual ─────────────────────────────────────

async function downloadDeck(
  e: string,
  d: string,
  name: string,
  archetype: string,
  format: string
): Promise<{
  mainboard: Array<{ cardName: string; quantity: number }>;
  sideboard: Array<{ cardName: string; quantity: number }>;
  name: string;
  archetype: string;
  format: string;
} | null> {
  try {
    // URL de download MTGO: https://mtgtop8.com/mtgo?e=82539&d=827346
    const deckUrl = `${MTGTOP8_BASE_URL}/mtgo?e=${e}&d=${d}`;
    const response = await fetchWithTimeout(deckUrl, {
      headers: { "User-Agent": USER_AGENT },
    });
    if (!response.ok) return null;

    const text = await response.text();
    const lines = text.split("\n");
    const mainboard: Array<{ cardName: string; quantity: number }> = [];
    const sideboard: Array<{ cardName: string; quantity: number }> = [];
    let isSideboard = false;

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (trimmed.toLowerCase().startsWith("sideboard")) {
        isSideboard = true;
        continue;
      }
      const m = /^(\d+)\s+(.+)$/.exec(trimmed);
      if (m) {
        const entry = { quantity: parseInt(m[1]), cardName: m[2].trim() };
        isSideboard ? sideboard.push(entry) : mainboard.push(entry);
      }
    }

    if (mainboard.length === 0) return null;
    return { mainboard, sideboard, name, archetype, format };
  } catch {
    return null;
  }
}

// ─── Persistência no banco ────────────────────────────────────────────────────
// NOTA: Usa SQL raw em vez do Drizzle ORM para o INSERT principal.
// O Drizzle 0.44.x tem um bug onde onConflictDoUpdate + returning() gera
// parâmetros duplicados ($7 e $8 para o mesmo valor), causando "Failed query".

async function saveDeckToDb(
  sourceId: string,
  detail: {
    mainboard: Array<{ cardName: string; quantity: number }>;
    sideboard: Array<{ cardName: string; quantity: number }>;
    name: string;
    archetype: string;
    format: string;
  }
): Promise<{ imported: boolean; cards: number }> {
  const db = await getDb();
  if (!db) return { imported: false, cards: 0 };

  const fullSourceId = `top8-${sourceId}`;
  const name        = detail.name || `Deck ${sourceId}`;
  const archetype   = detail.archetype || null;

  // INSERT com SQL raw — contorna o bug do Drizzle com parâmetros duplicados
  const rows = await db.execute(sql`
    INSERT INTO competitive_decks
      (source_id, source, name, format, archetype, author, is_synthetic)
    VALUES
      (${fullSourceId}, 'mtgtop8', ${name}, ${detail.format}, ${archetype}, 'MTGTop8', false)
    ON CONFLICT (source_id)
      DO UPDATE SET name = EXCLUDED.name
    RETURNING id
  `);

  const rowArr = Array.isArray(rows) ? rows : (rows as any).rows ?? [];
  const deckId = rowArr[0]?.id as number | undefined;
  if (!deckId) return { imported: false, cards: 0 };

  const allCards = [
    ...detail.mainboard.map((c) => ({ ...c, section: "mainboard" as const })),
    ...detail.sideboard.map((c) => ({ ...c, section: "sideboard" as const })),
  ];

  for (const card of allCards) {
    await db.execute(sql`
      INSERT INTO competitive_deck_cards (deck_id, card_name, quantity, section)
      VALUES (${deckId}, ${card.cardName}, ${card.quantity}, ${card.section})
      ON CONFLICT (deck_id, card_name, section)
        DO UPDATE SET quantity = EXCLUDED.quantity
    `);
  }

  return { imported: true, cards: allCards.length };
}

// ─── Importação por formato ───────────────────────────────────────────────────

/**
 * Importa até `decksPerFormat` decks de um único formato do MTGTop8.
 *
 * CORREÇÃO PRINCIPAL: O MTGTop8 usa HTML sem aspas nos atributos href.
 * O regex foi corrigido para aceitar: href=archetype?a=N&meta=N&f=XX>Nome</a>
 */
export async function importMTGTop8Decks(
  format: string = "modern",
  decksPerFormat: number = 10
): Promise<ImportResult> {
  const result: ImportResult = {
    decksImported: 0,
    cardsImported: 0,
    decksSkipped: 0,
    errors: [],
  };

  const formatCode = TOP8_FORMAT_MAP[format] ?? "MO";
  const url = `${MTGTOP8_BASE_URL}/format?f=${formatCode}`;
  console.log(`  [MTGTop8/${format.toUpperCase()}] Conectando: ${url}`);

  let archetypes: Array<{ id: string; meta: string; name: string }> = [];

  try {
    const t0 = Date.now();
    const response = await fetchWithTimeout(url, {
      headers: { "User-Agent": USER_AGENT },
    });
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

    if (!response.ok) {
      console.warn(
        `  [MTGTop8/${format.toUpperCase()}] HTTP ${response.status} — bloqueado. Pulando.`
      );
      return result;
    }

    const html = await response.text();
    console.log(
      `  [MTGTop8/${format.toUpperCase()}] Resposta em ${elapsed}s (${(html.length / 1024).toFixed(0)} KB)`
    );

    // CORREÇÃO: usar extractArchetypes que aceita href sem aspas
    archetypes = extractArchetypes(html);

    console.log(
      `  [MTGTop8/${format.toUpperCase()}] ${archetypes.length} arquetipos encontrados`
    );

    if (archetypes.length === 0) {
      console.warn(
        `  [MTGTop8/${format.toUpperCase()}] Nenhum arquetipo. HTML pode ter mudado.`
      );
      return result;
    }
  } catch (error: any) {
    const msg =
      error?.name === "AbortError"
        ? `Timeout (${FETCH_TIMEOUT_MS / 1000}s) — site lento ou bloqueando`
        : `Erro de conexao: ${error?.message}`;
    console.warn(`  [MTGTop8/${format.toUpperCase()}] ${msg}`);
    result.errors.push(msg);
    return result;
  }

  // Visitar os primeiros N archetypes (1 deck por archetype = mais diversidade)
  const archetypesToProcess = archetypes.slice(0, decksPerFormat);

  console.log(
    `  [MTGTop8/${format.toUpperCase()}] Coletando 1 deck de cada um dos ${archetypesToProcess.length} arquetipos...`
  );

  // Coletar pares (e, d) de cada archetype
  const deckEntries: Array<{
    e: string;
    d: string;
    name: string;
    archetype: string;
  }> = [];

  for (const arch of archetypesToProcess) {
    if (deckEntries.length >= decksPerFormat) break;
    const entries = await getDeckIdsFromArchetype(
      arch.id,
      arch.meta,
      formatCode,
      arch.name,
      1
    );
    for (const entry of entries) {
      if (deckEntries.length >= decksPerFormat) break;
      deckEntries.push({ ...entry, archetype: arch.name });
    }
    await new Promise((r) => setTimeout(r, 150));
  }

  console.log(
    `  [MTGTop8/${format.toUpperCase()}] ${deckEntries.length} decks localizados. Baixando em paralelo (${DOWNLOAD_CONCURRENCY} simultâneos)...`
  );

  if (deckEntries.length === 0) {
    console.warn(
      `  [MTGTop8/${format.toUpperCase()}] Nenhum deck encontrado nos arquetipos.`
    );
    return result;
  }

  // Downloads paralelos em batches
  let completed = 0;
  const downloadTasks = deckEntries.map((entry) => async () => {
    const detail = await downloadDeck(
      entry.e,
      entry.d,
      entry.name,
      entry.archetype,
      format
    );
    completed++;
    process.stdout.write(
      `\r  [MTGTop8/${format.toUpperCase()}] ${bar(completed, deckEntries.length)} ${completed}/${deckEntries.length}`
    );

    if (!detail) {
      result.decksSkipped++;
      return;
    }

    try {
      const sourceId = `e=${entry.e}&d=${entry.d}`;
      const { imported, cards } = await saveDeckToDb(sourceId, detail);
      if (imported) {
        result.decksImported++;
        result.cardsImported += cards;
      } else {
        result.decksSkipped++;
      }
    } catch (error: any) {
      result.errors.push(
        `DB error e=${entry.e}&d=${entry.d}: ${error?.message}`
      );
      result.decksSkipped++;
    }
  });

  await runInBatches(downloadTasks, DOWNLOAD_CONCURRENCY, BATCH_DELAY_MS);
  process.stdout.write("\n");

  console.log(
    `  [MTGTop8/${format.toUpperCase()}] ✓ ${result.decksImported} importados | ${result.decksSkipped} pulados | ${result.cardsImported} cartas`
  );
  if (result.errors.length > 0) {
    console.warn(
      `  [MTGTop8/${format.toUpperCase()}] ${result.errors.length} avisos: ${result.errors.slice(0, 2).join("; ")}`
    );
  }

  return result;
}

// ─── Importação de TODOS os formatos ─────────────────────────────────────────

/**
 * Importa `decksPerFormat` decks de CADA formato do MTGTop8.
 * Formatos: standard, modern, legacy, pioneer, pauper, vintage
 * Total máximo: 6 formatos × decksPerFormat decks
 */
export async function importAllTop8Formats(
  decksPerFormat: number = 10
): Promise<ImportResult> {
  const totals: ImportResult = {
    decksImported: 0,
    cardsImported: 0,
    decksSkipped: 0,
    errors: [],
  };

  console.log(`\n  [MTGTop8] Importando ${decksPerFormat} decks de cada formato:`);
  console.log(`  [MTGTop8] Formatos: ${TOP8_FORMATS.join(", ")}`);
  console.log(`  [MTGTop8] Total máximo: ${TOP8_FORMATS.length * decksPerFormat} decks\n`);

  for (const format of TOP8_FORMATS) {
    const r = await importMTGTop8Decks(format, decksPerFormat);
    totals.decksImported += r.decksImported;
    totals.cardsImported += r.cardsImported;
    totals.decksSkipped += r.decksSkipped;
    totals.errors.push(...r.errors);
    // Delay entre formatos
    await new Promise((res) => setTimeout(res, 1000));
  }

  console.log(`\n  [MTGTop8] TOTAL GERAL:`);
  console.log(`    Decks importados : ${totals.decksImported}`);
  console.log(`    Decks pulados    : ${totals.decksSkipped}`);
  console.log(`    Cartas salvas    : ${totals.cardsImported}`);

  return totals;
}
