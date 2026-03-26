import { getDb } from "./db";
import { cards, InsertCard } from "../drizzle/schema";
import { sql } from "drizzle-orm";

const SCRYFALL_BULK_URL = "https://api.scryfall.com/bulk-data";

async function getImageUrl(card: any): Promise<string | null> {
  if (card.image_uris?.normal) {
    return card.image_uris.normal;
  }
  if (card.card_faces?.[0]?.image_uris?.normal) {
    return card.card_faces[0].image_uris.normal;
  }
  return null;
}

async function syncBulkOracleCards() {
  console.log("\n🚀 Iniciando sincronização do Bulk (Oracle Cards) do Scryfall...");
  
  const db = await getDb();
  if (!db) {
    console.error("❌ Erro ao conectar ao banco.");
    return;
  }

  try {
    console.log("📥 Buscando informações do Bulk Data...");
    const bulkRes = await fetch(SCRYFALL_BULK_URL);
    if (!bulkRes.ok) throw new Error("Falha ao buscar endpoints do Bulk Data.");
    
    const bulkData = await bulkRes.json();
    const oracleMeta = bulkData.data.find((d: any) => d.type === "oracle_cards");

    if (!oracleMeta || !oracleMeta.download_uri) {
      throw new Error("Não encontrou o link para download das oracle_cards.");
    }

    console.log(`📥 Fazendo download do JSON (~${Math.round(oracleMeta.compressed_size / 1024 / 1024)}MB)...`);
    const dataRes = await fetch(oracleMeta.download_uri);
    if (!dataRes.ok) throw new Error("Falha ao fazer download do Bulk JSON.");
    
    console.log("🧠 Carregando cartas para memória...");
    const cardsArray = await dataRes.json();
    console.log(`✅ ${cardsArray.length} oracle cards encontradas. Iniciando inserção no banco...`);

    const batchSize = 1000;
    
    for (let i = 0; i < cardsArray.length; i += batchSize) {
      const batch = cardsArray.slice(i, i + batchSize);
      const insertDataBatch: InsertCard[] = [];

      for (const card of batch) {
        // Obter URL de imagem
        const imageUrl = await getImageUrl(card);

        insertDataBatch.push({
          scryfallId: card.id,
          oracleId: card.oracle_id,
          name: card.name,
          type: card.type_line,
          colors: card.colors?.length ? card.colors.join("") : null,
          cmc: Math.floor(Number(card.cmc)) || 0,
          rarity: card.rarity || "unknown",
          imageUrl: imageUrl, // Pode ser null
          power: card.power || null,
          toughness: card.toughness || null,
          text: card.oracle_text || null,
          isArena: card.games?.includes("arena") ? 1 : 0,
        });
      }

      if (insertDataBatch.length > 0) {
        // Inserir usando ON CONFLICT DO UPDATE
        await db.insert(cards).values(insertDataBatch).onConflictDoUpdate({
          target: cards.scryfallId,
          set: {
            oracleId: sql`EXCLUDED.oracle_id`,
            name: sql`EXCLUDED.name`,
            type: sql`EXCLUDED.type`,
            colors: sql`EXCLUDED.colors`,
            cmc: sql`EXCLUDED.cmc`,
            rarity: sql`EXCLUDED.rarity`,
            imageUrl: sql`EXCLUDED.image_url`,
            power: sql`EXCLUDED.power`,
            toughness: sql`EXCLUDED.toughness`,
            text: sql`EXCLUDED.text`,
            isArena: sql`EXCLUDED.is_arena`,
            updatedAt: sql`NOW()`,
          }
        });
      }

      console.log(`   🔄 Processado: ${Math.min(i + batchSize, cardsArray.length)} / ${cardsArray.length}...`);
    }

    console.log("\n✨ Sincronização do Oracle Bulk finalizada com sucesso!");
    
    const countRes = await db.execute(sql`SELECT count(*) FROM cards`);
    console.log(`📈 Total de cartas físicas/únicas agora no banco: ${countRes[0].count}`);

  } catch (error) {
    console.error("❌ Erro durante o processo de Bulk Sync:");
    console.error(error);
  }
}

syncBulkOracleCards().catch(console.error);
