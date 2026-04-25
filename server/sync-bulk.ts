/**
 * sync-bulk.ts
 *
 * Sincroniza cartas do Scryfall (Oracle Cards bulk) para o banco PostgreSQL.
 * - Pula sincronizacao se banco ja foi atualizado ha menos de 24h
 * - Cria conexao propria com max:1 e fecha explicitamente via finally
 * - Garante process.exit(0) em TODOS os caminhos para nao travar o pipeline
 */
import "dotenv/config";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { cards, InsertCard } from "../drizzle/schema";
import { sql } from "drizzle-orm";

const SCRYFALL_BULK_URL    = "https://api.scryfall.com/bulk-data";
const MIN_SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 horas
const FETCH_TIMEOUT_MS     = 20_000;               // 20s para meta
const DOWNLOAD_TIMEOUT_MS  = 180_000;              // 3min para JSON grande

function getImageUrl(card: any): string | null {
  if (card.image_uris?.normal) return card.image_uris.normal;
  if (card.card_faces?.[0]?.image_uris?.normal) return card.card_faces[0].image_uris.normal;
  return null;
}

/**
 * Anomaly-3 fix (2026-04-23): resolve a card's `colors` column with a
 * fallback chain. DFCs like Aclazotz have `colors=undefined` at top level
 * and Scryfall only exposes their color identity on `color_identity` or
 * inside `card_faces[i].colors`. Previously we only read `card.colors`
 * and stored DFCs as "C" (colorless), which broke commander filters.
 *
 * Order: colors → union of card_faces colors → color_identity.
 * Returns null only if Scryfall provided none of the three.
 */
function resolveCardColors(card: any): string | null {
  if (Array.isArray(card.colors) && card.colors.length > 0) {
    return card.colors.join("");
  }
  if (Array.isArray(card.card_faces) && card.card_faces.length > 0) {
    const union = new Set<string>();
    for (const face of card.card_faces) {
      if (Array.isArray(face.colors)) for (const c of face.colors) union.add(c);
    }
    if (union.size > 0) {
      return ["W", "U", "B", "R", "G"].filter((c) => union.has(c)).join("");
    }
  }
  if (Array.isArray(card.color_identity) && card.color_identity.length > 0) {
    return ["W", "U", "B", "R", "G"].filter((c) => card.color_identity.includes(c)).join("");
  }
  // Genuinely colorless (artifact, land, etc.): Scryfall returned an empty
  // `colors: []`. Store "" so downstream queries can distinguish from null.
  if (card.colors !== undefined || card.color_identity !== undefined || card.card_faces !== undefined) {
    return "";
  }
  return null;
}

async function syncBulkOracleCards(): Promise<void> {
  console.log("[sync-bulk] Verificando banco de cartas...");

  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.error("[sync-bulk] DATABASE_URL nao configurado. Pulando sync.");
    return;
  }

  // Conexao dedicada com max:1 — garante que client.end() fecha tudo
  const client = postgres(dbUrl, {
    max: 1,
    idle_timeout: 5,
    connect_timeout: 10,
    onnotice: () => {}, // suprimir notices do PostgreSQL
  });
  const db = drizzle(client);

  try {
    // ── Verificar se banco precisa de atualizacao ──────────────────────────
    const countRes = await db.execute(sql`SELECT COUNT(*) as cnt FROM cards`);
    const cardCount = Number((countRes as any)[0]?.cnt ?? 0);

    if (cardCount > 0) {
      const lastUpdateRes = await db.execute(
        sql`SELECT MAX(updated_at) as last_update FROM cards`
      );
      const lastUpdate    = (lastUpdateRes as any)[0]?.last_update;
      const lastUpdateMs  = lastUpdate ? new Date(lastUpdate).getTime() : 0;
      const msSinceUpdate = Date.now() - lastUpdateMs;

      if (msSinceUpdate < MIN_SYNC_INTERVAL_MS) {
        const hoursAgo  = Math.round(msSinceUpdate / 1000 / 60 / 60);
        const nextInMin = Math.round((MIN_SYNC_INTERVAL_MS - msSinceUpdate) / 1000 / 60);
        console.log(`[sync-bulk] Banco ja tem ${cardCount} cartas, atualizado ha ${hoursAgo}h. Pulando sync.`);
        console.log(`[sync-bulk] Proxima sync disponivel em ${nextInMin}min.`);
        return; // finally fecha o client
      }

      console.log(`[sync-bulk] Banco tem ${cardCount} cartas mas ultima sync foi ha mais de 24h. Atualizando...`);
    } else {
      console.log("[sync-bulk] Banco vazio. Realizando carga inicial completa...");
    }

    // ── Buscar metadados do Scryfall ───────────────────────────────────────
    console.log("[sync-bulk] Buscando metadados do Bulk Data...");
    const bulkRes = await fetch(SCRYFALL_BULK_URL, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!bulkRes.ok) throw new Error(`HTTP ${bulkRes.status} ao buscar bulk-data`);

    const bulkData   = await bulkRes.json();
    const oracleMeta = bulkData.data?.find((d: any) => d.type === "oracle_cards");
    if (!oracleMeta?.download_uri) throw new Error("Link de oracle_cards nao encontrado.");

    const sizeMB = Math.round((oracleMeta.compressed_size ?? 0) / 1024 / 1024);
    console.log(`[sync-bulk] Fazendo download do JSON (~${sizeMB}MB)...`);

    const dataRes = await fetch(oracleMeta.download_uri, {
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
    if (!dataRes.ok) throw new Error(`HTTP ${dataRes.status} ao baixar bulk JSON`);

    console.log("[sync-bulk] Carregando cartas para memoria...");
    const cardsArray: any[] = await dataRes.json();
    console.log(`[sync-bulk] ${cardsArray.length} oracle cards encontradas. Inserindo no banco...`);

    const batchSize = 1000;
    let processed   = 0;

    for (let i = 0; i < cardsArray.length; i += batchSize) {
      const batch: InsertCard[] = cardsArray.slice(i, i + batchSize).map((card: any) => ({
        scryfallId: card.id,
        oracleId:   card.oracle_id ?? null,
        name:       card.name,
        type:       card.type_line ?? null,
        // Anomaly-3 fix: use smart resolution so DFCs don't fall through as "C".
        colors:     resolveCardColors(card),
        cmc:        Math.floor(Number(card.cmc)) || 0,
        rarity:     card.rarity || "unknown",
        imageUrl:   getImageUrl(card),
        power:      card.power ?? null,
        toughness:  card.toughness ?? null,
        text:       card.oracle_text ?? null,
        priceUsd:   card.prices?.usd ? parseFloat(card.prices.usd) : null,
        isArena:    card.games?.includes("arena") ? 1 : 0,
      }));

      if (batch.length > 0) {
        await db.insert(cards).values(batch).onConflictDoUpdate({
          target: cards.scryfallId,
          set: {
            oracleId:  sql`EXCLUDED.oracle_id`,
            name:      sql`EXCLUDED.name`,
            type:      sql`EXCLUDED.type`,
            colors:    sql`EXCLUDED.colors`,
            cmc:       sql`EXCLUDED.cmc`,
            rarity:    sql`EXCLUDED.rarity`,
            imageUrl:  sql`EXCLUDED.image_url`,
            power:     sql`EXCLUDED.power`,
            toughness: sql`EXCLUDED.toughness`,
            text:      sql`EXCLUDED.text`,
            priceUsd:  sql`EXCLUDED.price_usd`,
            isArena:   sql`EXCLUDED.is_arena`,
            updatedAt: sql`NOW()`,
          },
        });
      }

      processed = Math.min(i + batchSize, cardsArray.length);
      const pct = ((processed / cardsArray.length) * 100).toFixed(0);
      process.stdout.write(`\r[sync-bulk] Inserindo... ${processed}/${cardsArray.length} (${pct}%)`);
    }

    process.stdout.write("\n");
    const finalRes = await db.execute(sql`SELECT COUNT(*) as cnt FROM cards`);
    console.log(`[sync-bulk] Concluido! Total no banco: ${(finalRes as any)[0]?.cnt} cartas.`);

  } catch (error: any) {
    if (error?.name === "TimeoutError" || error?.message?.includes("timeout")) {
      console.warn("[sync-bulk] Timeout ao conectar ao Scryfall. Usando dados existentes.");
    } else {
      console.error("[sync-bulk] Erro:", error?.message ?? error);
    }
  } finally {
    // SEMPRE fechar a conexao — sem isso o processo Node.js nao encerra
    try { await client.end({ timeout: 3 }); } catch (_) {}
  }
}

// Garantir process.exit(0) independente do resultado
syncBulkOracleCards()
  .catch((e) => console.error("[sync-bulk] Erro fatal:", e?.message))
  .finally(() => process.exit(0));
