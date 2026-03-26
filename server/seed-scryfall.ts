import { getDb } from "./db.ts";
import { cards, InsertCard } from "../drizzle/schema.ts";
import { eq } from "drizzle-orm";

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
  // Tentar obter imagem principal
  if (card.image_uris?.normal) {
    return card.image_uris.normal;
  }
  
  // Para cartas dupla-face, tentar primeira face
  if (card.card_faces?.[0]?.image_uris?.normal) {
    return card.card_faces[0].image_uris.normal;
  }
  
  return null;
}

async function seedScryfall() {
  console.log("\n🚀 Iniciando seed de dados do Scryfall");
  console.log("=" .repeat(60));

  const db = await getDb();
  if (!db) {
    console.error("❌ Não conseguiu conectar ao banco de dados");
    return;
  }

  let totalImported = 0;
  let totalSkipped = 0;
  let errors: string[] = [];

  // Buscar cartas simples (evitar dupla-face que têm mais problemas)
  const query = "legal:modern is:permanent type:creature unique:prints";
  let nextPageUrl = `${SCRYFALL_API}/cards/search?q=${encodeURIComponent(query)}&unique=prints`;
  let pageCount = 0;
  const maxPages = 5; // Limitar a 5 páginas para teste rápido

  while (nextPageUrl && pageCount < maxPages) {
    try {
      pageCount++;
      console.log(`\n📥 Buscando página ${pageCount}...`);

      const response = await fetch(nextPageUrl);
      if (!response.ok) {
        console.error(`❌ Erro HTTP ${response.status}`);
        break;
      }

      const data = await response.json();
      const scryfallCards = data.data || [];
      console.log(`   Found ${scryfallCards.length} cards...`);

      for (const scryfallCard of scryfallCards) {
        try {
          const imageUrl = await getImageUrl(scryfallCard);
          
          if (!imageUrl) {
            totalSkipped++;
            continue;
          }

          // Verificar se já existe
          const existing = await db
            .select()
            .from(cards)
            .where(eq(cards.scryfallId, scryfallCard.id))
            .limit(1);

          if (existing.length > 0) {
            totalSkipped++;
            continue;
          }

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

          if (totalImported % 50 === 0) {
            console.log(`   ✅ ${totalImported} cards imported...`);
          }
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          if (errors.length < 5) errors.push(errMsg);
          totalSkipped++;
        }
      }

      // Verificar próxima página
      nextPageUrl = data.next_page;

      // Respeitar rate limit
      await new Promise((resolve) => setTimeout(resolve, 100));
    } catch (err) {
      console.error("❌ Erro ao buscar página:", err);
      break;
    }
  }

  // Exibir resultado final
  console.log("\n" + "=".repeat(60));
  console.log("📊 Resultado Final:");
  console.log("=".repeat(60));
  console.log(`✅ Importadas:  ${totalImported}`);
  console.log(`⏭️  Puladas:     ${totalSkipped}`);

  if (errors.length > 0) {
    console.log("\n❌ Primeiros erros:");
    errors.forEach((err, i) => console.log(`   ${i + 1}. ${err}`));
  }

  const allCards = await db.select().from(cards);
  console.log(`\n📈 Total de cartas no banco: ${allCards.length}`);

  console.log("\n✨ Seed concluído!");
}

seedScryfall().catch(console.error);
