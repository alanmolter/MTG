/**
 * Data backfill for migration 20261016234006_competitive_decks_provenance.
 * Kept out of the migration (no long ACCESS EXCLUSIVE lock) and out of the
 * import pipeline. Every step only touches rows still NULL, so it is
 * idempotent and resumable, and it runs in small batches.
 *
 *   1. competitive_decks.download_status  → 'ok' (has cards) / 'empty'
 *   2. competitive_deck_cards.raw_name    → card_name
 *   3. competitive_deck_cards.oracle_id / resolved → CardNameResolver against cards
 */
import { CardNameResolver } from "./cardNameResolver";

export type Query = (sql: string, params?: unknown[]) => Promise<Array<Record<string, unknown>>>;

export const PENDING_SQL = `
SELECT
  (SELECT COUNT(*) FROM competitive_decks WHERE download_status IS NULL)       AS download_status,
  (SELECT COUNT(*) FROM competitive_deck_cards WHERE raw_name IS NULL)         AS raw_name,
  (SELECT COUNT(*) FROM competitive_deck_cards WHERE resolved IS NULL)         AS resolved
`;

export const DOWNLOAD_STATUS_BATCH_SQL = `
WITH b AS (
  SELECT id FROM competitive_decks WHERE download_status IS NULL ORDER BY id LIMIT $1
)
UPDATE competitive_decks d
SET download_status = (CASE WHEN EXISTS (SELECT 1 FROM competitive_deck_cards c WHERE c.deck_id = d.id)
                            THEN 'ok' ELSE 'empty' END)::deck_download_status
FROM b WHERE d.id = b.id AND d.download_status IS NULL
RETURNING d.id
`;

export const RAW_NAME_BATCH_SQL = `
WITH b AS (
  SELECT id FROM competitive_deck_cards WHERE raw_name IS NULL ORDER BY id LIMIT $1
)
UPDATE competitive_deck_cards c SET raw_name = c.card_name
FROM b WHERE c.id = b.id AND c.raw_name IS NULL
RETURNING c.id
`;

export const UNRESOLVED_NAMES_SQL = `
SELECT DISTINCT card_name FROM competitive_deck_cards
WHERE resolved IS NULL AND card_name > $1
ORDER BY card_name LIMIT $2
`;

export const RESOLVE_BATCH_SQL = `
UPDATE competitive_deck_cards c
SET oracle_id = v.oracle_id, resolved = v.resolved
FROM jsonb_to_recordset($1::jsonb) AS v(card_name text, oracle_id text, resolved boolean)
WHERE c.card_name = v.card_name AND c.resolved IS NULL
RETURNING c.id
`;

export interface BackfillReport {
  dryRun: boolean;
  pending: { downloadStatus: number; rawName: number; resolved: number };
  updated: { downloadStatus: number; rawName: number; resolvedLines: number };
  names: { resolved: number; unresolved: number; unresolvedSample: string[] };
}

export async function backfillDeckProvenance(
  query: Query,
  opts: { apply: boolean; batchSize?: number; resolver?: CardNameResolver; log?: (m: string) => void },
): Promise<BackfillReport> {
  const batch = Math.max(1, opts.batchSize ?? 5000);
  const log = opts.log ?? (() => undefined);
  const [p] = await query(PENDING_SQL);
  const report: BackfillReport = {
    dryRun: !opts.apply,
    pending: { downloadStatus: Number(p.download_status), rawName: Number(p.raw_name), resolved: Number(p.resolved) },
    updated: { downloadStatus: 0, rawName: 0, resolvedLines: 0 },
    names: { resolved: 0, unresolved: 0, unresolvedSample: [] },
  };

  if (opts.apply) {
    for (;;) {
      const rows = await query(DOWNLOAD_STATUS_BATCH_SQL, [batch]);
      report.updated.downloadStatus += rows.length;
      if (rows.length > 0) log(`download_status +${rows.length} (total ${report.updated.downloadStatus})`);
      if (rows.length < batch) break;
    }
    for (;;) {
      const rows = await query(RAW_NAME_BATCH_SQL, [batch]);
      report.updated.rawName += rows.length;
      if (rows.length > 0) log(`raw_name +${rows.length} (total ${report.updated.rawName})`);
      if (rows.length < batch) break;
    }
  }

  if (opts.resolver) {
    let after = "";
    for (;;) {
      const names = (await query(UNRESOLVED_NAMES_SQL, [after, batch])).map((r) => String(r.card_name));
      if (names.length === 0) break;
      after = names[names.length - 1];
      const oracle: Array<string | null> = [];
      const ok: boolean[] = [];
      for (const name of names) {
        const hit = opts.resolver.resolve(name);
        oracle.push(hit?.oracleId ?? null);
        ok.push(Boolean(hit?.oracleId));
        if (hit?.oracleId) report.names.resolved += 1;
        else {
          report.names.unresolved += 1;
          if (report.names.unresolvedSample.length < 20) report.names.unresolvedSample.push(name);
        }
      }
      if (opts.apply) {
        const payload = names.map((name, i) => ({ card_name: name, oracle_id: oracle[i], resolved: ok[i] }));
        const rows = await query(RESOLVE_BATCH_SQL, [JSON.stringify(payload)]);
        report.updated.resolvedLines += rows.length;
        log(`oracle_id batch: ${names.length} names, ${rows.length} lines`);
      }
      if (names.length < batch) break;
    }
  }
  return report;
}
