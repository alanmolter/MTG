import "dotenv/config";
import { getDb } from "./server/db.ts";
import { cards, InsertCard } from "./drizzle/schema.ts";
import { eq, sql } from "drizzle-orm";

const SCRYFALL_API = "https://api.scryfall.com";

interface ScryfallCard {
  id: string;
  name: string;
  type_line: string;
  colors?: string[];
  cmc: number;
  rarity: string;
  image_uris?: {
    normal: string;
  };
  card_faces?: Array<{
    image_uris?: {
      normal: string;
    };
  }>;
  power?: string;
  toughness?: string;
  oracle_text?: string;
}

async function getImageUrl(card: ScryfallCard): Promise<string | null> {
  if (card.image_uris?.normal) return card.image_uris.normal;
  if (card.card_faces?.[0]?.image_uris?.normal) return card.card_faces[0].image_uris.normal;
  return null;
}

async function populateTo2000() {
  const TARGET = 2000;
  const db = await getDb();
  if (!db) {
    console.error("❌ Não conseguiu conectar ao banco de dados");
    return;
  }

  // Check current count
  const countResult = await db.select({ count: sql<number>`count(*)` }).from(cards);
  let currentCount = Number(countResult[0].count);
  console.log(`\nStarting population logic. Current count: ${currentCount}`);

  if (currentCount >= TARGET) {
    console.log(`✅ Já existem ${currentCount} cartas no banco.`);
    return;
  }

  let totalImported = 0;
  // Use a different query to find more cards (not just creatures)
  const query = "legal:modern unique:prints";
  let nextPageUrl = `${SCRYFALL_API}/cards/search?q=${encodeURIComponent(query)}&page=1`;

  while (nextPageUrl && currentCount < TARGET) {
    try {
      console.log(`\n📥 Buscando na Scryfall: ${nextPageUrl}`);
      const response = await fetch(nextPageUrl);
      if (!response.ok) {
        console.error(`❌ Erro HTTP ${response.status}`);
        break;
      }

      const data = await response.json();
      const scryfallCards = data.data || [];
      console.log(`   Fetched ${scryfallCards.length} cards from API...`);

      for (const scryfallCard of scryfallCards) {
        if (currentCount >= TARGET) break;

        try {
          // Check if already exists by scryfallId
          const existing = await db
            .select()
            .from(cards)
            .where(eq(cards.scryfallId, scryfallCard.id))
            .limit(1);

          if (existing.length > 0) {
            continue;
          }

          const imageUrl = await getImageUrl(scryfallCard);
          if (!imageUrl) continue;

          const insertData: InsertCard = {
            scryfallId: scryfallCard.id,
            name: scryfallCard.name,
            type: scryfallCard.type_line,
            colors: scryfallCard.colors?.join("") || null,
            cmc: scryfallCard.cmc || 0,
            rarity: scryfallCard.rarity || "unknown",
            imageUrl: imageUrl,
            power: scryfallCard.power || null,
            toughness: scryfallCard.toughness || null,
            text: scryfallCard.oracle_text || null,
          };

          await db.insert(cards).values(insertData);
          totalImported++;
          currentCount++;

          if (totalImported % 50 === 0) {
            console.log(`   ✅ Total cards: ${currentCount} (+${totalImported} imported)`);
          }
        } catch (err) {
          // Silently skip on error for a single card
        }
      }

      nextPageUrl = data.next_page;
      // Rate limit
      await new Promise((resolve) => setTimeout(resolve, 100));

    } catch (err) {
      console.error("❌ Erro ao buscar página:", err);
      break;
    }
  }

  console.log(`\n✨ Finalizado! Total no banco: ${currentCount}`);
}

populateTo2000().catch(console.error);
