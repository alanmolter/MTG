import { manifestHash, type PoolManifest } from "./poolV3";

export interface MembershipRow {
  pool_version: number;
  deck_id: number;
  split: "train" | "holdout" | "benchmark" | "holdout_near";
  group_id: string;
  deck_hash: string;
  manifest_hash: string;
}

/** Rows for pool_memberships. Throws if the manifest was edited after generation. */
export function membershipRows(manifest: PoolManifest): MembershipRow[] {
  const actual = manifestHash(manifest);
  if (actual !== manifest.manifest_hash)
    throw new Error(`manifest_hash mismatch: file says ${manifest.manifest_hash}, content is ${actual}`);
  const rows: MembershipRow[] = [];
  for (const d of manifest.decks) {
    const base = { pool_version: manifest.pool_version, deck_id: d.deck_id, group_id: d.group_id, deck_hash: d.deck_hash, manifest_hash: manifest.manifest_hash };
    rows.push({ ...base, split: d.split });
    if (d.holdout_near) {
      if (d.split !== "train") throw new Error(`deck ${d.deck_id}: holdout_near outside train`);
      rows.push({ ...base, split: "holdout_near", group_id: d.near_cluster_id });
    }
  }
  return rows;
}

export const INSERT_MEMBERSHIPS_SQL = `
INSERT INTO pool_memberships (pool_version, deck_id, split, group_id, deck_hash, manifest_hash)
SELECT r.pool_version, r.deck_id, r.split, r.group_id, r.deck_hash, r.manifest_hash
FROM jsonb_to_recordset($1::jsonb) AS r(pool_version int, deck_id int, split text, group_id text, deck_hash text, manifest_hash text)
ON CONFLICT (pool_version, deck_id, split) DO NOTHING`;
