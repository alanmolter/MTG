/**
 * Write a competitive deck and its cards in one transaction.
 *
 * The previous importers inserted `competitive_decks` first and then each
 * card. A failed download, a Cloudflare HTML body, or a card-insert error
 * left the header committed with zero `competitive_deck_cards` rows and a
 * null `raw_json`. Re-import now replaces the card rows and stores the
 * parsed list, and it refuses to write a header that has no mainboard.
 */

export interface DeckCardEntry {
  cardName: string;
  quantity: number;
  section: "mainboard" | "sideboard";
}

export interface CompetitiveDeckWrite {
  sourceId: string;
  source: string;
  name: string;
  format: string;
  archetype?: string | null;
  author?: string | null;
  mainboard: Array<{ cardName: string; quantity: number }>;
  sideboard: Array<{ cardName: string; quantity: number }>;
}

type Sql = (strings: TemplateStringsArray, ...values: unknown[]) => Promise<Array<{ id?: number }>>;

export function parseDeckExport(text: string): {
  mainboard: Array<{ cardName: string; quantity: number }>;
  sideboard: Array<{ cardName: string; quantity: number }>;
} | null {
  const textarea = text.match(/<textarea[^>]*>([\s\S]*?)<\/textarea>/i);
  const body = decodeHtml(textarea ? textarea[1] : text);
  if (!textarea && /<!doctype html|<html|just a moment/i.test(body)) return null;

  const mainboard: Array<{ cardName: string; quantity: number }> = [];
  const sideboard: Array<{ cardName: string; quantity: number }> = [];
  let section: "main" | "side" | "skip" = "main";
  let headerMode = false;
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) {
      // Goldfish's plain download uses a blank line as the sideboard break.
      // Arena exports name the sections, so blanks there are just spacing.
      if (!headerMode && section === "main") section = "side";
      continue;
    }
    const header = line.toLowerCase();
    if (header === "about" || header.startsWith("name ") || header === "companion") {
      headerMode = true;
      section = "skip";
      continue;
    }
    if (header === "deck") {
      headerMode = true;
      section = "main";
      continue;
    }
    if (header === "sideboard" || header.startsWith("sideboard")) {
      headerMode = true;
      section = "side";
      continue;
    }
    if (section === "skip") continue;
    const match = /^(\d+)\s+(.+)$/.exec(line);
    if (!match) continue;
    const entry = {
      quantity: parseInt(match[1], 10),
      cardName: match[2].replace(/\s+\([A-Za-z0-9]+\)\s+\S+$/, "").trim(),
    };
    if (!entry.cardName || entry.quantity <= 0) continue;
    (section === "side" ? sideboard : mainboard).push(entry);
  }
  if (mainboard.length === 0) return null;
  return { mainboard, sideboard };
}

function decodeHtml(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

export async function saveCompetitiveDeck(
  pgClient: Sql & { begin?: (fn: (sql: Sql) => Promise<{ imported: boolean; cards: number }>) => Promise<{ imported: boolean; cards: number }> },
  deck: CompetitiveDeckWrite
): Promise<{ imported: boolean; cards: number }> {
  const cards: DeckCardEntry[] = [
    ...deck.mainboard.map((card) => ({ ...card, section: "mainboard" as const })),
    ...deck.sideboard.map((card) => ({ ...card, section: "sideboard" as const })),
  ];
  if (deck.mainboard.length === 0 || deck.mainboard.every((card) => card.quantity <= 0)) {
    return { imported: false, cards: 0 };
  }
  const rawJson = JSON.stringify({
    mainboard: deck.mainboard,
    sideboard: deck.sideboard,
  });
  const write = async (sql: Sql) => {
    const rows = await sql`
      INSERT INTO competitive_decks
        (source_id, source, name, format, archetype, author, raw_json)
      VALUES
        (${deck.sourceId}, ${deck.source}, ${deck.name}, ${deck.format}, ${deck.archetype ?? null}, ${deck.author ?? null}, ${rawJson})
      ON CONFLICT (source_id)
        DO UPDATE SET
          name = EXCLUDED.name,
          format = EXCLUDED.format,
          archetype = EXCLUDED.archetype,
          raw_json = EXCLUDED.raw_json
      RETURNING id
    `;
    const deckId = rows[0]?.id;
    if (!deckId) return { imported: false, cards: 0 };
    await sql`DELETE FROM competitive_deck_cards WHERE deck_id = ${deckId}`;
    for (const card of cards) {
      await sql`
        INSERT INTO competitive_deck_cards (deck_id, card_name, quantity, section)
        VALUES (${deckId}, ${card.cardName}, ${card.quantity}, ${card.section})
      `;
    }
    return { imported: true, cards: cards.length };
  };
  if (typeof pgClient.begin === "function") {
    return pgClient.begin(write);
  }
  return write(pgClient);
}
