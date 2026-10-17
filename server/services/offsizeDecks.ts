/**
 * Classification of decks whose mainboard is not the format size
 * (60, or 100 for commander). F2 stage 1.
 *
 * On the real DB (2026-10-16), all 46 off-size MTGTop8 decks matched the
 * live MTGTop8 export card for card (main and 15-card side). None was a
 * sideboard merged into the main, so there is no parser fix: they are real
 * lists (61-63 cards, Yorion companion with 80/81, one with 150).
 */

export const OFFSIZE_SQL = `
WITH a AS (
  SELECT deck_id,
         COALESCE(SUM(quantity) FILTER (WHERE COALESCE(section,'mainboard') = 'mainboard'), 0) AS main_qtd,
         COALESCE(SUM(quantity) FILTER (WHERE section = 'sideboard'), 0) AS side_qtd,
         bool_or(card_name ILIKE 'Yorion%') FILTER (WHERE section = 'sideboard') AS yorion_side
  FROM competitive_deck_cards GROUP BY deck_id
)
SELECT d.id, d.source, d.source_id, d.name, d.format, d.archetype, d.author, d.archive_reason,
       a.main_qtd, a.side_qtd, COALESCE(a.yorion_side, false) AS yorion_side
FROM competitive_decks d
JOIN a ON a.deck_id = d.id
WHERE d.archived_at IS NULL
  AND a.main_qtd <> CASE WHEN lower(d.format) = 'commander' THEN 100 ELSE 60 END
ORDER BY d.id
`;

export type OffsizeClass =
  | "fixable_reparse"        // source now parses to the format size: re-save
  | "source_mismatch"        // source differs from stored list but is not the format size
  | "sideboard_merged"       // main+side looks like 60+15 merged with no side stored
  | "real_offsize_yorion"    // Yorion companion in side, main >= 80 (legal)
  | "real_offsize_atypical"  // far above the format size (e.g. 150)
  | "real_offsize";          // real list a few cards over (61-77)

export interface OffsizeRow {
  id: number;
  format: string;
  mainQtd: number;
  sideQtd: number;
  yorionSide: boolean;
  /** Main size parsed from the live source, when fetched. */
  sourceMain?: number | null;
  sourceSide?: number | null;
}

export function targetSize(format: string): number {
  return format.trim().toLowerCase() === "commander" ? 100 : 60;
}

export function classifyOffsize(row: OffsizeRow): OffsizeClass {
  const target = targetSize(row.format);
  if (row.sourceMain != null) {
    if (row.sourceMain === target) return "fixable_reparse";
    if (row.sourceMain !== row.mainQtd || (row.sourceSide != null && row.sourceSide !== row.sideQtd)) {
      return "source_mismatch";
    }
  }
  if (target === 60 && row.sideQtd === 0 && row.mainQtd === 75) return "sideboard_merged";
  if (row.yorionSide && row.mainQtd >= 80) return "real_offsize_yorion";
  if (row.mainQtd > target + 40) return "real_offsize_atypical";
  return "real_offsize";
}

/** archive_reason prefix for quarantine without archiving (archived_at stays NULL). */
export const QUARANTINE_PREFIX = "quarantine:offsize_";

export const QUARANTINE_SQL = `
UPDATE competitive_decks
SET archive_reason = $2, is_training_eligible = false
WHERE id = $1 AND archived_at IS NULL
  AND (archive_reason IS NULL OR archive_reason LIKE 'quarantine:%')
  AND archive_reason IS DISTINCT FROM $2
`;
