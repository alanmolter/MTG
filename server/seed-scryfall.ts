import { getDb } from "./db.ts";
import { cards, InsertCard } from "../drizzle/schema.ts";
import { eq } from "drizzle-orm";

const SCRYFALL_API = "https://api.scryfall.com";

interface ScryfallCard {
  id: string;
  name: string;
  type_line: string;
  colors?: string[];
  /**
   * Anomaly-3 fix: color_identity is the SOURCE OF TRUTH for DFCs and
   * split/fuse cards. It already aggregates colors from both faces. A card
   * like Aclazotz (MDFC) has colors=undefined at top level but
   * color_identity=["B"], so falling through to color_identity prevents
   * the card from being stored as "C" (colorless).
   */
  color_identity?: string[];
  cmc: number;
  rarity: string;
  image_uris?: {
    normal: string;
  };
  card_faces?: Array<{
    /** Anomaly-3 fix: front/back-face colors; unioned as a fallback. */
    colors?: string[];
    image_uris?: {
      normal: string;
    };
  }>;
  power?: string;
  toughness?: string;
  oracle_text?: string;
  oracle_id?: string;
  arena_id?: number;
  digital?: boolean;
  set?: string;
  set_type?: string;
  /**
   * Scryfall's authoritative list of platforms a card is available on.
   * Possible values include "paper", "arena", "mtgo". Used as the canonical
   * source for `cards.is_arena` so we don't conflate MTGO-only digital
   * reprints (which also have `digital: true`) with Arena-legal cards.
   */
  games?: string[];
  prices?: {
    usd?: string;
    usd_foil?: string;
  };
}

/**
 * Anomaly-3 fix: resolve a card's stored `colors` string from Scryfall data
 * with a fallback chain that works for normal cards, DFCs, split cards and
 * "colorless" edge cases.
 *
 * Order of preference (first that yields ≥1 colors wins):
 *   1. card.colors                (most cards)
 *   2. union of card_faces[i].colors  (DFCs/split — Aclazotz, Valki, etc.)
 *   3. card.color_identity        (WotC-authoritative fallback)
 *
 * Returns:
 *   - "" (empty string) when the card is genuinely colorless (artifacts etc.)
 *   - null  if no Scryfall data could resolve it (shouldn't normally happen)
 */
export function resolveScryfallColors(card: {
  colors?: string[];
  color_identity?: string[];
  card_faces?: Array<{ colors?: string[] }>;
  type_line?: string;
}): string | null {
  // 1. Top-level colors
  if (Array.isArray(card.colors) && card.colors.length > 0) {
    return card.colors.join("");
  }

  // 2. Union of face colors (DFCs). Use a Set to dedupe if both faces
  //    share a color (e.g. a B/R DFC with a mono-B front and a B/R back).
  if (Array.isArray(card.card_faces) && card.card_faces.length > 0) {
    const union = new Set<string>();
    for (const face of card.card_faces) {
      if (Array.isArray(face.colors)) {
        for (const c of face.colors) union.add(c);
      }
    }
    if (union.size > 0) {
      // Preserve WUBRG canonical order for display stability
      const order = ["W", "U", "B", "R", "G"];
      return order.filter((c) => union.has(c)).join("");
    }
  }

  // 3. color_identity (authoritative — Scryfall aggregates across faces)
  if (Array.isArray(card.color_identity) && card.color_identity.length > 0) {
    const order = ["W", "U", "B", "R", "G"];
    return order.filter((c) => card.color_identity!.includes(c)).join("");
  }

  // 4. Genuinely colorless? If we have Scryfall data but all three fields
  //    returned zero, call it colorless ("" — distinct from null = unknown).
  if (
    card.colors !== undefined ||
    card.color_identity !== undefined ||
    card.card_faces !== undefined
  ) {
    return "";
  }

  return null;
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

  // BUSCA ABSOLUTA: Pega TODAS as cartas únicas da história do Magic (Papel e Arena)
  // unique=cards garante 1 de cada nome (Bolt, Birds, etc.) sem duplicatas inúteis.
  // game:paper OR game:arena cobre 100% da existência do jogo.
  const query = "game:paper OR game:arena";
  let nextPageUrl = `${SCRYFALL_API}/cards/search?q=${encodeURIComponent(query)}&unique=cards`;
  let pageCount = 0;
  const maxPages = 200; // Suficiente para carregar ~35.000 cartas únicas (toda a história do Magic)

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
            // Opcional: Atualizar se isArena mudou ou preço mudou
            totalSkipped++;
            continue;
          }

          // Determinar se é Arena.
          //
          // Antes (incorreto): aceitava `arena_id || set_type === "alchemy" ||
          // digital`. Isso incluía cartas MTGO-only (todas têm `digital: true`)
          // e legados pré-rotação que mantêm `arena_id` mas não estão mais no
          // cliente. Resultado: ~80% do banco marcado como Arena, sendo que
          // o pool real do Arena é ~10–15k das ~35k cartas em paper.
          //
          // Agora: usar `games[]` (canônico do Scryfall) — só marca como
          // Arena se o array contém literalmente "arena". Mesmo critério
          // que `sync-bulk.ts` já usa, então os dois caminhos de seed
          // produzem o mesmo resultado.
          const isArena = scryfallCard.games?.includes("arena") ? 1 : 0;

          const insertData: InsertCard = {
            scryfallId: scryfallCard.id,
            oracleId: scryfallCard.oracle_id || null,
            name: scryfallCard.name,
            type: scryfallCard.type_line,
            // Anomaly-3 fix: smart color resolution (top-level → faces → color_identity)
            // so DFCs like Aclazotz aren't stored as colorless "C".
            colors: resolveScryfallColors(scryfallCard),
            cmc: scryfallCard.cmc ?? 0,
            rarity: scryfallCard.rarity || "unknown",
            imageUrl: imageUrl,
            power: scryfallCard.power || null,
            toughness: scryfallCard.toughness || null,
            text: scryfallCard.oracle_text || null,
            isArena: isArena,
            priceUsd: scryfallCard.prices?.usd ? parseFloat(scryfallCard.prices.usd) : null,
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
