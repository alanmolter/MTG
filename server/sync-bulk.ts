import { getDb } from "./db";
import { cards, InsertCard } from "../drizzle/schema";
import { sql } from "drizzle-orm";

const SCRYFALL_BULK_URL = "https://api.scryfall.com/bulk-data";

// Intervalo mínimo entre sincronizações completas (24 horas em ms)
const MIN_SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000;

async function getImageUrl(card: any): Promise<string | null> {
  if (card.image_uris?.normal) return card.image_uris.normal;
  if (card.card_faces?.[0]?.image_uris?.normal) return card.card_faces[0].image_uris.normal;
  return null;
}

async function syncBulkOracleCards() {
  console.log("\n[sync-bulk] Iniciando sincronizacao do Bulk (Oracle Cards) do Scryfall...");

  const db = await getDb();
  if (!db) {
    console.error("[sync-bulk] Erro ao conectar ao banco.");
    return;
  }

  try {
    // ── Verificação 1: banco já tem cartas suficientes? ──────────────────────
    const countRes = await db.execute(sql`SELECT COUNT(*) as cnt FROM cards`);
    const cardCount = Number((countRes as any)[0]?.cnt ?? 0);

    if (cardCount > 0) {
      // Verificar quando foi a última atualização
      const lastUpdateRes = await db.execute(
        sql`SELECT MAX(updated_at) as last_update FROM cards`
      );
      const lastUpdate = (lastUpdateRes as any)[0]?.last_update;
      const lastUpdateMs = lastUpdate ? new Date(lastUpdate).getTime() : 0;
      const msSinceUpdate = Date.now() - lastUpdateMs;

      if (msSinceUpdate < MIN_SYNC_INTERVAL_MS) {
        const hoursAgo = Math.round(msSinceUpdate / 1000 / 60 / 60);
        console.log(
          `[sync-bulk] Banco ja tem ${cardCount} cartas, atualizado ha ${hoursAgo}h. Pulando sync.`
        );
        console.log(
          `[sync-bulk] Proxima sync disponivel em ${Math.round((MIN_SYNC_INTERVAL_MS - msSinceUpdate) / 1000 / 60)}min.`
        );
        return;
      }

      console.log(
        `[sync-bulk] Banco tem ${cardCount} cartas mas ultima sync foi ha mais de 24h. Atualizando...`
      );
    } else {
      console.log("[sync-bulk] Banco vazio. Realizando carga inicial completa...");
    }

    // ── Verificação 2: Scryfall acessível? ──────────────────────────────────
    console.log("[sync-bulk] Buscando metadados do Bulk Data...");
    const bulkRes = await fetch(SCRYFALL_BULK_URL, { signal: AbortSignal.timeout(15000) });
    if (!bulkRes.ok) throw new Error(`Falha ao buscar endpoints do Bulk Data: HTTP ${bulkRes.status}`);

    const bulkData = await bulkRes.json();
    const oracleMeta = bulkData.data?.find((d: any) => d.type === "oracle_cards");

    if (!oracleMeta?.download_uri) {
      throw new Error("Nao encontrou o link para download das oracle_cards.");
    }

    const sizeMB = Math.round((oracleMeta.compressed_size ?? 0) / 1024 / 1024);
    console.log(`[sync-bulk] Fazendo download do JSON (~${sizeMB}MB)...`);

    const dataRes = await fetch(oracleMeta.download_uri, { signal: AbortSignal.timeout(120000) });
    if (!dataRes.ok) throw new Error(`Falha ao fazer download do Bulk JSON: HTTP ${dataRes.status}`);

    console.log("[sync-bulk] Carregando cartas para memoria...");
    const cardsArray: any[] = await dataRes.json();
    console.log(`[sync-bulk] ${cardsArray.length} oracle cards encontradas. Inserindo no banco...`);

    const batchSize = 1000;
    let processed = 0;

    for (let i = 0; i < cardsArray.length; i += batchSize) {
      const batch = cardsArray.slice(i, i + batchSize);
      const insertDataBatch: InsertCard[] = [];

      for (const card of batch) {
        const imageUrl = await getImageUrl(card);
        insertDataBatch.push({
          scryfallId: card.id,
          oracleId: card.oracle_id ?? null,
          name: card.name,
          type: card.type_line ?? null,
          colors: card.colors?.length ? card.colors.join("") : null,
          cmc: Math.floor(Number(card.cmc)) || 0,
          rarity: card.rarity || "unknown",
          imageUrl,
          power: card.power ?? null,
          toughness: card.toughness ?? null,
          text: card.oracle_text ?? null,
          priceUsd: card.prices?.usd ? parseFloat(card.prices.usd) : null,
          isArena: card.games?.includes("arena") ? 1 : 0,
        });
      }

      if (insertDataBatch.length > 0) {
        await db.insert(cards).values(insertDataBatch).onConflictDoUpdate({
          target: cards.scryfallId,
          set: {
            oracleId:   sql`EXCLUDED.oracle_id`,
            name:       sql`EXCLUDED.name`,
            type:       sql`EXCLUDED.type`,
            colors:     sql`EXCLUDED.colors`,
            cmc:        sql`EXCLUDED.cmc`,
            rarity:     sql`EXCLUDED.rarity`,
            imageUrl:   sql`EXCLUDED.image_url`,
            power:      sql`EXCLUDED.power`,
            toughness:  sql`EXCLUDED.toughness`,
            text:       sql`EXCLUDED.text`,
            priceUsd:   sql`EXCLUDED.price_usd`,
            isArena:    sql`EXCLUDED.is_arena`,
            updatedAt:  sql`NOW()`,
          },
        });
      }

      processed = Math.min(i + batchSize, cardsArray.length);
      console.log(`   Processado: ${processed} / ${cardsArray.length}...`);
    }

    const finalCount = await db.execute(sql`SELECT COUNT(*) as cnt FROM cards`);
    console.log(`[sync-bulk] Concluido! Total no banco: ${(finalCount as any)[0]?.cnt}`);

  } catch (error: any) {
    if (error?.name === "TimeoutError" || error?.message?.includes("timeout")) {
      console.warn("[sync-bulk] Timeout ao conectar ao Scryfall. Usando dados existentes no banco.");
    } else {
      console.error("[sync-bulk] Erro:", error?.message ?? error);
    }
  }
}

syncBulkOracleCards().catch(console.error);
