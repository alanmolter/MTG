/**
 * Fill competitive decks that have a header and zero card rows.
 *
 * Decks that already have cards are not in the query, so a re-run does not
 * touch them. Stored raw_json is preferred. When it has no mainboard, goldfish
 * and top8 ids are fetched again. Anything else is skipped and reported.
 */
import {
  parseDeckExport,
  saveCompetitiveDeck,
  type CompetitiveDeckWrite,
} from "./competitiveDeckStore";

export const EMPTY_DECK_SQL = `
SELECT d.id, d.source_id, d.source, d.name, d.format, d.archetype, d.author, d.raw_json
FROM competitive_decks d
WHERE NOT EXISTS (
  SELECT 1 FROM competitive_deck_cards c WHERE c.deck_id = d.id
)
ORDER BY d.id
`;

export interface EmptyDeckRow {
  id: number;
  sourceId: string;
  source: string;
  name: string;
  format: string;
  archetype: string | null;
  author: string | null;
  rawJson: string | null;
}

export interface ReimportReport {
  considered: number;
  reimported: number;
  skipped: string[];
  failed: string[];
}

type CardLine = { cardName: string; quantity: number };

const GOLDFISH = "https://www.mtggoldfish.com";
const TOP8 = "https://mtgtop8.com";

export function refetchUrls(row: EmptyDeckRow): string[] {
  const goldfish = /^goldfish-(\d+)$/.exec(row.sourceId);
  if (goldfish) {
    const id = goldfish[1];
    return [
      `${GOLDFISH}/deck/arena_download/${id}`,
      `${GOLDFISH}/deck/download/${id}`,
    ];
  }
  const top8 = /^top8-(e=\d+&d=\d+)$/.exec(row.sourceId);
  if (top8) return [`${TOP8}/mtgo?${top8[1]}`];
  return [];
}

function asCardLines(value: unknown): CardLine[] | null {
  if (!Array.isArray(value)) return null;
  const lines: CardLine[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") return null;
    const rec = item as Record<string, unknown>;
    const cardName = String(rec.cardName ?? rec.name ?? "").trim();
    const quantity = Number(rec.quantity ?? rec.count ?? rec.qty);
    if (!cardName || !Number.isFinite(quantity) || quantity <= 0) continue;
    lines.push({ cardName, quantity: Math.floor(quantity) });
  }
  return lines;
}

export function deckFromStoredJson(
  row: EmptyDeckRow
): CompetitiveDeckWrite | null {
  const raw = row.rawJson?.trim();
  if (!raw) return null;

  const fromLists = (
    mainboard: CardLine[],
    sideboard: CardLine[]
  ): CompetitiveDeckWrite | null => {
    if (mainboard.length === 0) return null;
    return {
      sourceId: row.sourceId,
      source: row.source,
      name: row.name,
      format: row.format,
      archetype: row.archetype,
      author: row.author,
      mainboard,
      sideboard,
    };
  };

  const fromText = (text: string): CompetitiveDeckWrite | null => {
    const parsed = parseDeckExport(text);
    if (!parsed) return null;
    return fromLists(parsed.mainboard, parsed.sideboard);
  };

  if (raw.startsWith("{") || raw.startsWith("[")) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (typeof parsed === "string") return fromText(parsed);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const obj = parsed as Record<string, unknown>;
        const mainboard = asCardLines(obj.mainboard);
        const sideboard = asCardLines(obj.sideboard) ?? [];
        if (mainboard && mainboard.length > 0)
          return fromLists(mainboard, sideboard);
        for (const key of ["text", "deck", "list"]) {
          if (typeof obj[key] === "string") {
            const decoded = fromText(obj[key] as string);
            if (decoded) return decoded;
          }
        }
      }
    } catch {
      /* fall through to plain deck text */
    }
  }
  return fromText(raw);
}

export async function reimportEmptyDecks(deps: {
  listEmpty: () => Promise<EmptyDeckRow[]>;
  fetchText: (url: string) => Promise<string | null>;
  save: (
    deck: CompetitiveDeckWrite
  ) => Promise<{ imported: boolean; cards: number }>;
}): Promise<ReimportReport> {
  const rows = await deps.listEmpty();
  const report: ReimportReport = {
    considered: rows.length,
    reimported: 0,
    skipped: [],
    failed: [],
  };

  for (const row of rows) {
    const label = `${row.id} ${row.sourceId}`;
    try {
      let deck = deckFromStoredJson(row);
      if (!deck) {
        const urls = refetchUrls(row);
        if (urls.length === 0) {
          report.skipped.push(`${label}: no raw_json and no known source url`);
          continue;
        }
        for (const url of urls) {
          const body = await deps.fetchText(url);
          if (!body) continue;
          const parsed = parseDeckExport(body);
          if (!parsed) continue;
          deck = {
            sourceId: row.sourceId,
            source: row.source,
            name: row.name,
            format: row.format,
            archetype: row.archetype,
            author: row.author,
            mainboard: parsed.mainboard,
            sideboard: parsed.sideboard,
          };
          break;
        }
      }
      if (!deck) {
        report.failed.push(`${label}: download had no mainboard`);
        continue;
      }
      const saved = await deps.save(deck);
      if (!saved.imported || saved.cards <= 0) {
        report.failed.push(`${label}: write stored no cards`);
        continue;
      }
      report.reimported += 1;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      report.failed.push(`${label}: ${message}`);
    }
  }
  return report;
}

export { saveCompetitiveDeck };
