import "dotenv/config";
import { getDb } from "./server/db.ts";
import { cards, InsertCard } from "./drizzle/schema.ts";
import { sql } from "drizzle-orm";

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

async function populateTo12000() {
  const TARGET = 12000;
  const db = await getDb();
  if (!db) {
    console.error("❌ Não conseguiu conectar ao banco de dados");
    return;
  }

  // Check current count
  const countResult = await db.select({ count: sql<number>`count(*)` }).from(cards);
  let currentCount = Number(countResult[0].count);
  console.log(`\nStarting BATCH population logic. Current count: ${currentCount}`);

  if (currentCount >= TARGET) {
    console.log(`✅ Já existem ${currentCount} cartas no banco.`);
    return;
  }

  const query = "f:modern";
  // Start from a later page to avoid cards already imported in the first 2000
  // Since 2275 cards are already there, we can start around page 14
  let nextPageUrl = `${SCRYFALL_API}/cards/search?q=${encodeURIComponent(query)}&unique=prints&page=14`;

  while (nextPageUrl && currentCount < TARGET) {
    try {
      console.log(`\n📥 Fetching: ${nextPageUrl}`);
      const response = await fetch(nextPageUrl);
      if (!response.ok) {
        console.error(`❌ Erro HTTP ${response.status}`);
        break;
      }

      const data = await response.json();
      const scryfallCards = data.data || [];
      console.log(`   Processing ${scryfallCards.length} cards...`);

      const cardsToInsert: InsertCard[] = [];
      for (const scryfallCard of scryfallCards) {
        const imageUrl = await getImageUrl(scryfallCard);
        if (!imageUrl) continue;

        cardsToInsert.push({
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
        });
      }

      if (cardsToInsert.length > 0) {
        // Batch insert with conflict handling
        await db.insert(cards).values(cardsToInsert).onConflictDoNothing();
        
        // Re-check count (expensive but accurate for progress)
        const newCountResult = await db.select({ count: sql<number>`count(*)` }).from(cards);
        currentCount = Number(newCountResult[0].count);
        console.log(`   ✅ Current total: ${currentCount}`);
      }

      nextPageUrl = data.next_page;
      await new Promise((resolve) => setTimeout(resolve, 100));

    } catch (err) {
      console.error("❌ Erro:", err);
      break;
    }
  }

  console.log(`\n✨ Finalizado! Total no banco: ${currentCount}`);
}

populateTo12000().catch(console.error);
