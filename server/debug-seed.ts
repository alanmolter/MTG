import { getDb } from "./db.ts";
import { cards, InsertCard } from "../drizzle/schema.ts";

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
  power?: string;
  toughness?: string;
  oracle_text?: string;
}

async function debugSync() {
  console.log("🧪 Debug: Testando inserção de cartas...\n");

  const db = await getDb();
  if (!db) {
    console.error("❌ Não conseguiu conectar ao banco de dados");
    return;
  }

  try {
    // Buscar uma única carta do Scryfall
    console.log("📡 Buscando carta de teste do Scryfall...");
    const response = await fetch(
      `${SCRYFALL_API}/cards/search?q=legal:standard&unique=cards&page=1`
    );
    const data = await response.json();
    const scryfallCard = data.data?.[0];

    if (!scryfallCard) {
      console.error("❌ Nenhuma carta encontrada");
      return;
    }

    console.log(`✅ Carta encontrada: ${scryfallCard.name}`);
    console.log(`   Type: ${scryfallCard.type_line}`);
    console.log(`   CMC: ${scryfallCard.cmc}`);
    console.log(`   Rarity: ${scryfallCard.rarity}`);
    console.log(`   Has Image: ${!!scryfallCard.image_uris?.normal}`);

    if (!scryfallCard.image_uris?.normal) {
      console.warn("⚠️  Esta carta não tem imagem, será pulada");
      return;
    }

    const insertData: InsertCard = {
      scryfallId: scryfallCard.id,
      name: scryfallCard.name,
      type: scryfallCard.type_line,
      colors: scryfallCard.colors?.join("") || null,
      cmc: scryfallCard.cmc,
      rarity: scryfallCard.rarity,
      imageUrl: scryfallCard.image_uris.normal,
      power: scryfallCard.power || null,
      toughness: scryfallCard.toughness || null,
      text: scryfallCard.oracle_text || null,
    };

    console.log("\n🔧 Tentando inserir carta no banco...");
    await db.insert(cards).values(insertData);

    console.log("✅ Carta inserida com sucesso!");

    // Verificar se foi inserida
    const result = await db.select().from(cards);
    console.log(`\n📊 Total de cartas no banco: ${result.length}`);
  } catch (error) {
    console.error("❌ Erro:", error);
  }
}

debugSync();
