/**
 * Fill competitive decks that have a header and zero card rows.
 *
 * Decks that already have cards are not in the query, so a re-run does not
 * touch them. Stored raw_json is preferred. When it has no mainboard, goldfish
 * and top8 ids are fetched again. Anything else is skipped and reported.
 */
import { parseDeckExport, saveCompetitiveDeck, type CompetitiveDeckWrite } from "./competitiveDeckStore";

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

export type DeckOutcome =
  | "reimported"
  | "would_reimport"
  | "skipped"
  | "failed"
  | "not_empty_anymore";

export interface DeckLogEntry {
  id: number;
  sourceId: string;
  source: string;
  outcome: DeckOutcome;
  via?: "raw_json" | "refetch";
  url?: string;
  mainCards?: number;
  sideCards?: number;
  detail?: string;
}

export interface ReimportReport {
  considered: number;
  reimported: number;
  skipped: string[];
  failed: string[];
  /** One entry per deck processed, in order. */
  log: DeckLogEntry[];
  batches: number;
  dryRun: boolean;
}

export interface ReimportOptions {
  /** List what would be written; never call save. */
  dryRun?: boolean;
  /** Decks per batch (default 50). */
  batchSize?: number;
  /** Stop after this many batches (default: all). */
  maxBatches?: number;
  /** Only rows whose source matches (case-insensitive). */
  source?: string;
  /** Called after each batch, e.g. to print progress. */
  onBatch?: (batch: number, entries: DeckLogEntry[]) => void;
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
  // MTGTop8 ids come as `top8-e=N&d=N` (current scraper) or bare `e=N&d=N`
  // (March 2026 import). The bare form is only trusted for source=mtgtop8.
  const top8 = /^top8-(e=\d+&d=\d+)$/.exec(row.sourceId)
    ?? (row.source.toLowerCase() === "mtgtop8" ? /^(e=\d+&d=\d+)$/.exec(row.sourceId) : null);
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

export function deckFromStoredJson(row: EmptyDeckRow): CompetitiveDeckWrite | null {
  const raw = row.rawJson?.trim();
  if (!raw) return null;

  const fromLists = (mainboard: CardLine[], sideboard: CardLine[]): CompetitiveDeckWrite | null => {
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
        if (mainboard && mainboard.length > 0) return fromLists(mainboard, sideboard);
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
  save: (deck: CompetitiveDeckWrite) => Promise<{ imported: boolean; cards: number }>;
  /** Re-checked right before writing so a deck filled meanwhile is not touched. */
  isStillEmpty?: (row: EmptyDeckRow) => Promise<boolean>;
  /**
   * Record the fetch outcome (download_status / last_fetch_error). Optional;
   * a no-op when the provenance columns are missing. Errors here never
   * change the deck outcome.
   */
  markStatus?: (row: EmptyDeckRow, status: "ok" | "failed", error: string | null) => Promise<void>;
}, options: ReimportOptions = {}): Promise<ReimportReport> {
  const batchSize = Math.max(1, Math.floor(options.batchSize ?? 50));
  const wanted = options.source?.toLowerCase();
  const all = await deps.listEmpty();
  const rows = wanted ? all.filter((row) => row.source.toLowerCase() === wanted) : all;
  const report: ReimportReport = {
    considered: rows.length,
    reimported: 0,
    skipped: [],
    failed: [],
    log: [],
    batches: 0,
    dryRun: Boolean(options.dryRun),
  };

  for (let start = 0; start < rows.length; start += batchSize) {
    if (options.maxBatches !== undefined && report.batches >= options.maxBatches) break;
    const entries: DeckLogEntry[] = [];
    for (const row of rows.slice(start, start + batchSize)) {
      const entry = await processRow(row, deps, report, Boolean(options.dryRun));
      if (!options.dryRun && deps.markStatus && (entry.outcome === "reimported" || entry.outcome === "failed")) {
        try {
          await deps.markStatus(row, entry.outcome === "reimported" ? "ok" : "failed",
            entry.outcome === "failed" ? (entry.detail ?? "unknown error") : null);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          entry.detail = `${entry.detail ? entry.detail + "; " : ""}status not recorded: ${message}`;
        }
      }
      entries.push(entry);
      report.log.push(entry);
    }
    report.batches += 1;
    options.onBatch?.(report.batches, entries);
  }
  return report;
}

async function processRow(
  row: EmptyDeckRow,
  deps: Parameters<typeof reimportEmptyDecks>[0],
  report: ReimportReport,
  dryRun: boolean,
): Promise<DeckLogEntry> {
  const label = `${row.id} ${row.sourceId}`;
  const base = { id: row.id, sourceId: row.sourceId, source: row.source };
  try {
    let deck = deckFromStoredJson(row);
    let via: DeckLogEntry["via"] = deck ? "raw_json" : undefined;
    let usedUrl: string | undefined;
    if (!deck) {
      const urls = refetchUrls(row);
      if (urls.length === 0) {
        const detail = "no raw_json and no known source url";
        report.skipped.push(`${label}: ${detail}`);
        return { ...base, outcome: "skipped", detail };
      }
      if (dryRun) {
        return { ...base, outcome: "would_reimport", via: "refetch", url: urls[0] };
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
        via = "refetch";
        usedUrl = url;
        break;
      }
    }
    if (!deck) {
      const detail = "download had no mainboard";
      report.failed.push(`${label}: ${detail}`);
      return { ...base, outcome: "failed", via, detail };
    }
    const mainCards = deck.mainboard.reduce((sum, card) => sum + card.quantity, 0);
    const sideCards = deck.sideboard.reduce((sum, card) => sum + card.quantity, 0);
    if (dryRun) {
      return { ...base, outcome: "would_reimport", via, mainCards, sideCards };
    }
    if (deps.isStillEmpty && !(await deps.isStillEmpty(row))) {
      return { ...base, outcome: "not_empty_anymore", via, url: usedUrl };
    }
    const saved = await deps.save(deck);
    if (!saved.imported || saved.cards <= 0) {
      const detail = "write stored no cards";
      report.failed.push(`${label}: ${detail}`);
      return { ...base, outcome: "failed", via, url: usedUrl, detail };
    }
    report.reimported += 1;
    return { ...base, outcome: "reimported", via, url: usedUrl, mainCards, sideCards };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    report.failed.push(`${label}: ${message}`);
    return { ...base, outcome: "failed", detail: message };
  }
}

export { saveCompetitiveDeck };
