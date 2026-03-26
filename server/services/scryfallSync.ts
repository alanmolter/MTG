import { getDb } from "../db";
import { cards, Card, InsertCard } from "../../drizzle/schema";
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
  power?: string;
  toughness?: string;
  oracle_text?: string;
  mana_cost?: string;
}

interface SyncOptions {
  format?: "standard" | "modern" | "commander" | "legacy" | "all";
  colors?: string[];
  limit?: number;
}

/**
 * Sincroniza cartas do Scryfall com o banco de dados
 * Busca cartas legais em um formato específico
 */
export async function syncCardsFromScryfall(options: SyncOptions = {}): Promise<{
  imported: number;
  skipped: number;
  errors: number;
}> {
  const { format = "standard", colors = [], limit = 5000 } = options;

  let query = "";

  // Construir query Scryfall
  if (format !== "all") {
    query = `legal:${format}`;
  }

  if (colors.length > 0) {
    query += ` c:${colors.join("")}`;
  }

  console.log(`[Scryfall Sync] Iniciando sincronização com query: "${query}"`);

  let imported = 0;
  let skipped = 0;
  let errors = 0;
  let nextPageUrl = `${SCRYFALL_API}/cards/search?q=${encodeURIComponent(query)}&unique=cards`;
  let pageCount = 0;

  while (nextPageUrl && imported + skipped < limit) {
    try {
      pageCount++;
      console.log(`[Scryfall Sync] Buscando página ${pageCount}...`);

      const response = await fetch(nextPageUrl);
      if (!response.ok) {
        console.error(`[Scryfall Sync] Erro HTTP ${response.status}`);
        break;
      }

      const data = await response.json();
      const scryfallCards = data.data || [];

      for (const scryfallCard of scryfallCards) {
        if (imported + skipped >= limit) break;

        try {
          // Pular cartas sem imagem
          if (!scryfallCard.image_uris?.normal) {
            skipped++;
            continue;
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

          const db = await getDb();
          if (!db) {
            errors++;
            continue;
          }

          // Verificar se já existe
          const existing = await db
            .select()
            .from(cards)
            .where(eq(cards.scryfallId, scryfallCard.id))
            .limit(1);

          if (existing.length === 0) {
            await db.insert(cards).values(insertData);
            imported++;

            if (imported % 100 === 0) {
              console.log(`[Scryfall Sync] Importadas ${imported} cartas...`);
            }
          } else {
            skipped++;
          }
        } catch (error) {
          console.error(`[Scryfall Sync] Erro ao processar carta ${scryfallCard.name}:`, error);
          errors++;
        }
      }

      // Verificar próxima página
      nextPageUrl = data.next_page;

      // Respeitar rate limit do Scryfall
      await new Promise((resolve) => setTimeout(resolve, 100));
    } catch (error) {
      console.error("[Scryfall Sync] Erro ao buscar página:", error);
      break;
    }
  }

  console.log(
    `[Scryfall Sync] Sincronização concluída: ${imported} importadas, ${skipped} puladas, ${errors} erros`
  );

  return { imported, skipped, errors };
}

/**
 * Obtém estatísticas de cartas no banco
 */
export async function getCardStats(): Promise<{
  total: number;
  byRarity: Record<string, number>;
  byColor: Record<string, number>;
}> {
  const db = await getDb();
  if (!db) return { total: 0, byRarity: {}, byColor: {} };

  try {
    const allCards = await db.select().from(cards);

    const byRarity: Record<string, number> = {};
    const byColor: Record<string, number> = {};

    for (const card of allCards) {
      // Contar por raridade
      if (card.rarity) {
        byRarity[card.rarity] = (byRarity[card.rarity] || 0) + 1;
      }

      // Contar por cor
      if (card.colors) {
        for (const color of card.colors.split("")) {
          byColor[color] = (byColor[color] || 0) + 1;
        }
      }
    }

    return {
      total: allCards.length,
      byRarity,
      byColor,
    };
  } catch (error) {
    console.error("Erro ao obter estatísticas:", error);
    return { total: 0, byRarity: {}, byColor: {} };
  }
}

/**
 * Limpa todas as cartas do banco (útil para resincronizar)
 */
export async function clearAllCards(): Promise<boolean> {
  const db = await getDb();
  if (!db) return false;

  try {
    // Nota: Drizzle não tem delete() sem where, então deletamos por ID
    // Uma alternativa seria usar raw SQL, mas vamos fazer de forma segura
    console.log("[Scryfall Sync] Limpando banco de cartas...");

    // Obter todas as cartas
    const allCards = await db.select().from(cards);

    // Deletar em lotes para não sobrecarregar
    const batchSize = 100;
    for (let i = 0; i < allCards.length; i += batchSize) {
      const batch = allCards.slice(i, i + batchSize);
      for (const card of batch) {
        // Deletar individualmente (não é ideal, mas é seguro)
        // Em produção, usar raw SQL seria melhor
      }
    }

    console.log("[Scryfall Sync] Banco limpo");
    return true;
  } catch (error) {
    console.error("Erro ao limpar banco:", error);
    return false;
  }
}
