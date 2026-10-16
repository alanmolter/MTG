/**
 * Archive competitive decks that can never be filled:
 *   - mtggoldfish rows with no cards (source dropped: anti-scraper)
 *   - moxfield "fallback*" placeholders with no cards (never real decks)
 *
 * Never deletes. Placeholders are marked is_synthetic = true (the column the
 * schema already documents for fallback rows). Every candidate gets
 * download_status / archived_at / archive_reason, added by migration
 * 20261016234006_competitive_decks_provenance. Without those columns the plan
 * is not applicable (statusColumnsPresent = false) and the script refuses
 * --apply.
 */

export const ARCHIVE_CANDIDATES_SQL = `
SELECT d.id, d.source, d.source_id, d.format, d.is_synthetic,
       CASE
         WHEN lower(d.source) = 'mtggoldfish' THEN 'source_dropped'
         WHEN lower(d.source) = 'moxfield' AND d.source_id LIKE 'fallback%' THEN 'placeholder'
       END AS reason
FROM competitive_decks d
LEFT JOIN (SELECT DISTINCT deck_id FROM competitive_deck_cards) c ON c.deck_id = d.id
WHERE c.deck_id IS NULL
  AND (lower(d.source) = 'mtggoldfish'
       OR (lower(d.source) = 'moxfield' AND d.source_id LIKE 'fallback%'))
ORDER BY d.id
`;

export const STATUS_COLUMNS_SQL = `
SELECT column_name FROM information_schema.columns
WHERE table_schema = current_schema() AND table_name = 'competitive_decks'
  AND column_name IN ('download_status', 'archived_at', 'archive_reason')
`;

export interface ArchiveCandidate {
  id: number;
  source: string;
  sourceId: string;
  format: string;
  isSynthetic: boolean;
  reason: "source_dropped" | "placeholder";
}

export interface ArchiveStatement {
  sql: string;
  params: unknown[];
  description: string;
}

export interface ArchivePlan {
  candidates: ArchiveCandidate[];
  bySource: Record<string, number>;
  byReason: Record<string, number>;
  statusColumnsPresent: boolean;
  statements: ArchiveStatement[];
  pending: string[];
}

export function planArchive(candidates: ArchiveCandidate[], statusColumns: string[]): ArchivePlan {
  const have = new Set(statusColumns);
  const statusColumnsPresent = ["download_status", "archived_at", "archive_reason"].every((c) => have.has(c));
  const bySource: Record<string, number> = {};
  const byReason: Record<string, number> = {};
  for (const c of candidates) {
    bySource[c.source] = (bySource[c.source] ?? 0) + 1;
    byReason[c.reason] = (byReason[c.reason] ?? 0) + 1;
  }
  const placeholders = candidates.filter((c) => c.reason === "placeholder").map((c) => c.id);
  const statements: ArchiveStatement[] = [];
  const pending: string[] = [];
  if (placeholders.length > 0) {
    statements.push({
      description: `mark ${placeholders.length} moxfield placeholders is_synthetic=true`,
      sql: `UPDATE competitive_decks SET is_synthetic = true, is_training_eligible = false
            WHERE id = ANY($1::int[]) AND is_synthetic = false`,
      params: [placeholders],
    });
  }
  for (const reason of ["source_dropped", "placeholder"] as const) {
    const ids = candidates.filter((c) => c.reason === reason).map((c) => c.id);
    if (ids.length === 0) continue;
    if (statusColumnsPresent) {
      statements.push({
        description: `archive ${ids.length} decks as ${reason}`,
        sql: `UPDATE competitive_decks
              SET download_status = $2::deck_download_status,
                  archived_at = now(),
                  archive_reason = $2
              WHERE id = ANY($1::int[]) AND archived_at IS NULL`,
        params: [ids, reason],
      });
    } else {
      pending.push(`archive status for ${ids.length} ${reason} decks needs migration 20261016234006_competitive_decks_provenance`);
    }
  }
  return { candidates, bySource, byReason, statusColumnsPresent, statements, pending };
}
