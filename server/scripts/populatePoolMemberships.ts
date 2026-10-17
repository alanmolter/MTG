/**
 * Fills pool_memberships from data/pools/v<N>/manifest.json. Dry-run by default.
 *
 *   npx tsx server/scripts/populatePoolMemberships.ts [--manifest data/pools/v3/manifest.json] [--apply]
 *
 * - Verifies manifest_hash against the content before anything else.
 * - Refuses if the table is missing (migration 20261017002547 not applied), if
 *   the pool version already has rows from another manifest_hash, or if any
 *   deck_id does not exist. Never deletes: to rebuild a version, the DBA
 *   decides what to do with the old rows.
 * - Insert is one transaction, ON CONFLICT DO NOTHING (safe to re-run).
 */
import "dotenv/config";
import * as fs from "fs";
import { INSERT_MEMBERSHIPS_SQL, membershipRows } from "../services/poolMembershipRows";
import type { PoolManifest } from "../services/poolV3";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const apply = process.argv.includes("--apply");
  const file = arg("--manifest") ?? "data/pools/v3/manifest.json";
  const manifest = JSON.parse(fs.readFileSync(file, "utf8")) as PoolManifest;
  const rows = membershipRows(manifest);
  const bySplit: Record<string, number> = {};
  for (const r of rows) bySplit[r.split] = (bySplit[r.split] ?? 0) + 1;
  console.log(`[pool] v${manifest.pool_version} manifest_hash=${manifest.manifest_hash} rows=${rows.length} ${JSON.stringify(bySplit)}`);

  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set");
  const { getRawClient, closeDb } = await import("../db");
  const pg = await getRawClient();
  if (!pg) throw new Error("could not open the database");
  try {
    const [{ t }] = (await pg.unsafe(`SELECT to_regclass('public.pool_memberships')::text AS t`)) as unknown as Array<{ t: string | null }>;
    if (!t) throw new Error("table pool_memberships does not exist: apply migration 20261017002547_pool_memberships first");
    const other = (await pg.unsafe(
      `SELECT manifest_hash, count(*)::int AS n FROM pool_memberships WHERE pool_version = $1 GROUP BY 1`,
      [manifest.pool_version]
    )) as unknown as Array<{ manifest_hash: string; n: number }>;
    const foreign = other.filter(o => o.manifest_hash !== manifest.manifest_hash);
    if (foreign.length) throw new Error(`pool_version ${manifest.pool_version} already has rows from another manifest: ${JSON.stringify(foreign)}`);
    const ids = Array.from(new Set(rows.map(r => r.deck_id)));
    const [{ missing }] = (await pg.unsafe(
      `SELECT count(*)::int AS missing FROM unnest($1::int[]) AS u(id) WHERE NOT EXISTS (SELECT 1 FROM competitive_decks d WHERE d.id = u.id)`,
      [ids as never]
    )) as unknown as Array<{ missing: number }>;
    if (missing) throw new Error(`${missing} deck_id(s) of the manifest do not exist in competitive_decks`);
    const existing = other.reduce((s, o) => s + o.n, 0);
    console.log(`[pool] existing rows for this manifest: ${existing}`);
    if (!apply) {
      console.log("[pool] dry-run: nothing written. Re-run with --apply.");
      return;
    }
    const inserted = await pg.begin(async (tx: any) => {
      const res = await tx.unsafe(INSERT_MEMBERSHIPS_SQL, [JSON.stringify(rows) as never]);
      return res.count;
    });
    console.log(`[pool] inserted ${inserted} rows (${rows.length - inserted} already present).`);
  } finally {
    await closeDb();
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
