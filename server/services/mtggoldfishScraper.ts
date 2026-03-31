import { getRawClient } from "../db";

const MTGGOLDFISH_BASE_URL = "https://www.mtggoldfish.com";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

/** Timeout por requisição individual */
const FETCH_TIMEOUT_MS = 20_000;

/** Máximo de downloads simultâneos de decks (evita rate-limit) */
const DOWNLOAD_CONCURRENCY = 3;

/** Delay entre batches de download (ms) */
const BATCH_DELAY_MS = 500;

/** Formatos suportados pelo MTGGoldfish metagame */
export const GOLDFISH_FORMATS = [
  "standard",
  "modern",
  "legacy",
  "pioneer",
  "pauper",
  "vintage",
] as const;

export type GoldfishFormat = (typeof GOLDFISH_FORMATS)[number];

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

/** Executa array de promises em batches de tamanho `concurrency` */
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

// ─── Extração de deck IDs por archetype ───────────────────────────────────────

/**
 * Extrai IDs de deck numéricos da página de um archetype específico.
 * Padrão atual do MTGGoldfish: href="/deck/7693069" ou href="/deck/7693069#paper"
 */
async function getDeckIdsFromArchetype(
  archetypeSlug: string,
  maxDecks = 5
): Promise<{ id: string; name: string }[]> {
  const url = `${MTGGOLDFISH_BASE_URL}/archetype/${archetypeSlug}#paper`;
  try {
    const response = await fetchWithTimeout(url, {
      headers: { "User-Agent": USER_AGENT },
    });
    if (!response.ok) return [];
    const html = await response.text();

    // Padrão atual: href="/deck/7693069" ou href="/deck/7693069#paper"
    const deckRegex = /href="\/deck\/(\d+)(?:#[^"]*)?"/g;
    const seen = new Set<string>();
    const results: { id: string; name: string }[] = [];

    // Derivar nome legível do slug
    const archetypeName = archetypeSlug
      .replace(/^(modern|standard|legacy|pioneer|vintage|pauper)-/, "")
      .replace(/-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, "")
      .replace(/-\d+$/, "")
      .replace(/-/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase());

    let match;
    while ((match = deckRegex.exec(html)) !== null && results.length < maxDecks) {
      const id = match[1];
      if (!seen.has(id)) {
        seen.add(id);
        results.push({ id, name: archetypeName });
      }
    }
    return results;
  } catch {
    return [];
  }
}

// ─── Download e parse de deck individual ─────────────────────────────────────

async function downloadDeck(
  summary: MTGGoldfishDeckSummary
): Promise<MTGGoldfishDeckDetail | null> {
  try {
    const deckUrl = `${MTGGOLDFISH_BASE_URL}/deck/download/${summary.id}`;
    const response = await fetchWithTimeout(deckUrl, {
      headers: { "User-Agent": USER_AGENT },
    });
    if (!response.ok) return null;

    const text = await response.text();
    const lines = text.split("\n");
    const mainboard: { cardName: string; quantity: number }[] = [];
    const sideboard: { cardName: string; quantity: number }[] = [];
    let isSideboard = false;

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
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

    return {
      ...summary,
      mainboard,
      sideboard,
    };
  } catch {
    return null;
  }
}

// ─── Persistência no banco ────────────────────────────────────────────────────
// Usa o cliente postgres.js DIRETAMENTE (tagged template literal nativa).
// Contorna completamente o Drizzle ORM para evitar o bug de parâmetros duplicados.

async function saveDeckToDb(
  detail: MTGGoldfishDeckDetail,
  format: string
): Promise<{ imported: boolean; cards: number }> {
  const pgClient = await getRawClient();
  if (!pgClient) return { imported: false, cards: 0 };

  const sourceId  = `goldfish-${detail.id}`;
  const name      = detail.name || `Deck ${detail.id}`;
  const archetype = detail.archetype ?? null;

  // INSERT usando postgres.js tagged template literal (sem Drizzle)
  const rows = await pgClient`
    INSERT INTO competitive_decks
      (source_id, source, name, format, archetype, author)
    VALUES
      (${sourceId}, ${'mtggoldfish'}, ${name}, ${format}, ${archetype}, ${'MTGGoldfish'})
    ON CONFLICT (source_id)
      DO UPDATE SET name = EXCLUDED.name
    RETURNING id
  `;

  const deckId = rows[0]?.id as number | undefined;
  if (!deckId) return { imported: false, cards: 0 };

  const allCards = [
    ...detail.mainboard.map((c) => ({ ...c, section: "mainboard" as const })),
    ...detail.sideboard.map((c) => ({ ...c, section: "sideboard" as const })),
  ];

  for (const card of allCards) {
    await pgClient`
      INSERT INTO competitive_deck_cards (deck_id, card_name, quantity, section)
      VALUES (${deckId}, ${card.cardName}, ${card.quantity}, ${card.section})
      ON CONFLICT (deck_id, card_name, section)
        DO UPDATE SET quantity = EXCLUDED.quantity
    `;
  }

  return { imported: true, cards: allCards.length };
}

// ─── Importação por formato ───────────────────────────────────────────────────

/**
 * Importa até `decksPerFormat` decks de um único formato do MTGGoldfish.
 * Usa downloads paralelos em batches de DOWNLOAD_CONCURRENCY para performance.
 */
export async function importMTGGoldfishDecks(
  format: string = "modern",
  decksPerFormat: number = 10
): Promise<ImportResult> {
  const result: ImportResult = {
    decksImported: 0,
    cardsImported: 0,
    decksSkipped: 0,
    errors: [],
  };

  const url = `${MTGGOLDFISH_BASE_URL}/metagame/${format}/full`;
  console.log(`  [MTGGoldfish/${format.toUpperCase()}] Conectando: ${url}`);

  let archetypeSlugs: string[] = [];

  try {
    const t0 = Date.now();
    const response = await fetchWithTimeout(url, {
      headers: { "User-Agent": USER_AGENT },
    });
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

    if (!response.ok) {
      console.warn(
        `  [MTGGoldfish/${format.toUpperCase()}] HTTP ${response.status} — bloqueado. Pulando.`
      );
      return result;
    }

    const html = await response.text();
    console.log(
      `  [MTGGoldfish/${format.toUpperCase()}] Resposta em ${elapsed}s (${(html.length / 1024).toFixed(0)} KB)`
    );

    // Extrair slugs de archetype — padrão: href="/archetype/modern-boros-energy"
    const archetypeRegex = /href="\/archetype\/([^"#]+)(?:#[^"]*)?"/g;
    const seenSlugs = new Set<string>();
    let match;
    while ((match = archetypeRegex.exec(html)) !== null) {
      const slug = match[1];
      if (!seenSlugs.has(slug) && !slug.includes("custom")) {
        seenSlugs.add(slug);
        archetypeSlugs.push(slug);
      }
    }

    console.log(
      `  [MTGGoldfish/${format.toUpperCase()}] ${archetypeSlugs.length} arquetipos encontrados`
    );

    if (archetypeSlugs.length === 0) {
      console.warn(
        `  [MTGGoldfish/${format.toUpperCase()}] Nenhum arquetipo. HTML pode ter mudado.`
      );
      return result;
    }
  } catch (error: any) {
    const msg =
      error?.name === "AbortError"
        ? `Timeout (${FETCH_TIMEOUT_MS / 1000}s) — site lento ou bloqueando`
        : `Erro de conexao: ${error?.message}`;
    console.warn(`  [MTGGoldfish/${format.toUpperCase()}] ${msg}`);
    result.errors.push(msg);
    return result;
  }

  // Calcular quantos archetypes visitar para atingir decksPerFormat decks
  // (1 deck por archetype = mais diversidade)
  const archetypesToProcess = archetypeSlugs.slice(0, decksPerFormat);

  console.log(
    `  [MTGGoldfish/${format.toUpperCase()}] Coletando 1 deck de cada um dos ${archetypesToProcess.length} arquetipos...`
  );

  // Coletar IDs de deck de cada archetype (sequencial para não sobrecarregar)
  const deckSummaries: MTGGoldfishDeckSummary[] = [];
  for (const slug of archetypesToProcess) {
    if (deckSummaries.length >= decksPerFormat) break;
    const entries = await getDeckIdsFromArchetype(slug, 1);
    for (const entry of entries) {
      if (deckSummaries.length >= decksPerFormat) break;
      deckSummaries.push({
        id: entry.id,
        name: entry.name,
        format,
        archetype: entry.name,
        author: "MTGGoldfish",
        views: 0,
        likes: 0,
      });
    }
    await new Promise((r) => setTimeout(r, 100));
  }

  console.log(
    `  [MTGGoldfish/${format.toUpperCase()}] ${deckSummaries.length} decks localizados. Baixando em paralelo (${DOWNLOAD_CONCURRENCY} simultâneos)...`
  );

  if (deckSummaries.length === 0) {
    console.warn(
      `  [MTGGoldfish/${format.toUpperCase()}] Nenhum deck encontrado nos arquetipos.`
    );
    return result;
  }

  // Downloads paralelos em batches
  let completed = 0;
  const downloadTasks = deckSummaries.map((summary) => async () => {
    const detail = await downloadDeck(summary);
    completed++;
    process.stdout.write(
      `\r  [MTGGoldfish/${format.toUpperCase()}] ${bar(completed, deckSummaries.length)} ${completed}/${deckSummaries.length}`
    );

    if (!detail) {
      result.decksSkipped++;
      return;
    }

    try {
      const { imported, cards } = await saveDeckToDb(detail, format);
      if (imported) {
        result.decksImported++;
        result.cardsImported += cards;
      } else {
        result.decksSkipped++;
      }
    } catch (error: any) {
      result.errors.push(`DB error deck ${summary.id}: ${error?.message}`);
      result.decksSkipped++;
    }
  });

  await runInBatches(downloadTasks, DOWNLOAD_CONCURRENCY, BATCH_DELAY_MS);
  process.stdout.write("\n");

  console.log(
    `  [MTGGoldfish/${format.toUpperCase()}] ✓ ${result.decksImported} importados | ${result.decksSkipped} pulados | ${result.cardsImported} cartas`
  );
  if (result.errors.length > 0) {
    console.warn(
      `  [MTGGoldfish/${format.toUpperCase()}] ${result.errors.length} avisos: ${result.errors.slice(0, 2).join("; ")}`
    );
  }

  return result;
}

// ─── Importação de TODOS os formatos ─────────────────────────────────────────

/**
 * Importa `decksPerFormat` decks de CADA formato do MTGGoldfish.
 * Formatos: standard, modern, legacy, pioneer, pauper, vintage
 * Total máximo: 6 formatos × decksPerFormat decks
 */
export async function importAllGoldfishFormats(
  decksPerFormat: number = 10
): Promise<ImportResult> {
  const totals: ImportResult = {
    decksImported: 0,
    cardsImported: 0,
    decksSkipped: 0,
    errors: [],
  };

  console.log(`\n  [MTGGoldfish] Importando ${decksPerFormat} decks de cada formato:`);
  console.log(`  [MTGGoldfish] Formatos: ${GOLDFISH_FORMATS.join(", ")}`);
  console.log(`  [MTGGoldfish] Total máximo: ${GOLDFISH_FORMATS.length * decksPerFormat} decks\n`);

  for (const format of GOLDFISH_FORMATS) {
    const r = await importMTGGoldfishDecks(format, decksPerFormat);
    totals.decksImported += r.decksImported;
    totals.cardsImported += r.cardsImported;
    totals.decksSkipped += r.decksSkipped;
    totals.errors.push(...r.errors);
    // Delay entre formatos para não sobrecarregar o servidor
    await new Promise((res) => setTimeout(res, 1000));
  }

  console.log(`\n  [MTGGoldfish] TOTAL GERAL:`);
  console.log(`    Decks importados : ${totals.decksImported}`);
  console.log(`    Decks pulados    : ${totals.decksSkipped}`);
  console.log(`    Cartas salvas    : ${totals.cardsImported}`);

  return totals;
}
