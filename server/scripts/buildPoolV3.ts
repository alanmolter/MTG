/**
 * Builds pool v3 (spec: Eng. IA/ML, 2026-10-16) from the training-eligible decks.
 * Read-only on the database: one SELECT, no writes.
 *
 *   npx tsx server/scripts/buildPoolV3.ts                 # reads DATABASE_URL
 *   npx tsx server/scripts/buildPoolV3.ts --input x.json  # offline export (same rows)
 *   --out data/pools/v3  (default)
 *
 * Writes manifest.json (source of truth, with manifest_hash), card_sets.json
 * (oracle_id sets for the CI leakage test) and report.md. Exits 2 if the
 * holdout/benchmark minimums are not met; the files are still written so the
 * report can be read, but the pool must not be used.
 */
import "dotenv/config";
import { createHash } from "crypto";
import * as fs from "fs";
import * as path from "path";
import {
  LSH_BANDS, MINHASH_PERMS, MINIMUMS, NEAR_DUP_JACCARD, POOL_SEED, POOL_VERSION, SEARCH_TRIALS, SPLIT_RATIOS,
  HOLDOUT_NEAR_RATIO, archetypeLabel, assignHoldoutNear, assignSplits, buildCardSets, buildGroups, leakReport,
  manifestHash, toPoolDeck, type ManifestDeck, type PoolDeckInput, type PoolManifest,
} from "../services/poolV3";

export const ELIGIBLE_DECKS_SQL = `
SELECT d.id, d.format, d.archetype,
  COALESCE((
    SELECT json_agg(json_build_array(c.oracle_id, c.quantity, k.colors, k.type) ORDER BY c.oracle_id)
    FROM competitive_deck_cards c
    LEFT JOIN LATERAL (
      SELECT min(colors) AS colors, min(type) AS type FROM cards WHERE cards.oracle_id = c.oracle_id
    ) k ON true
    WHERE c.deck_id = d.id AND c.section = 'mainboard' AND c.oracle_id IS NOT NULL
  ), '[]'::json) AS main
FROM competitive_decks d
WHERE d.is_training_eligible AND d.archived_at IS NULL AND NOT d.is_synthetic
ORDER BY d.id`;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function loadInput(): Promise<{ rows: PoolDeckInput[]; source: string }> {
  const file = arg("--input");
  if (file) {
    const raw = fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "");
    return { rows: JSON.parse(raw), source: `file:${path.basename(file)}` };
  }
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set (or pass --input)");
  const { getRawClient, closeDb } = await import("../db");
  const pg = await getRawClient();
  if (!pg) throw new Error("could not open the database");
  try {
    const rows = Array.from(await pg.unsafe(ELIGIBLE_DECKS_SQL)) as unknown as PoolDeckInput[];
    return { rows: rows.map(r => ({ ...r, main: typeof r.main === "string" ? JSON.parse(r.main) : r.main })), source: "database" };
  } finally {
    await closeDb();
  }
}

function table(rows: Array<Record<string, string | number>>, cols: string[]): string {
  return [`| ${cols.join(" | ")} |`, `|${cols.map(() => "---").join("|")}|`, ...rows.map(r => `| ${cols.map(c => r[c] ?? 0).join(" | ")} |`)].join("\n");
}

async function main() {
  const outDir = arg("--out") ?? "data/pools/v3";
  const { rows, source } = await loadInput();
  const decks = rows.map(toPoolDeck).sort((a, b) => a.id - b.id);
  const empty = decks.filter(d => d.oracleIds.length === 0).map(d => d.id);
  if (empty.length) throw new Error(`decks without resolved mainboard oracle_ids: ${empty.join(",")}`);

  const grouping = buildGroups(decks);
  const res = assignSplits(decks, grouping.groupOf);
  const near = assignHoldoutNear(decks, grouping.clusterOf, res.split);

  const sets = buildCardSets(decks);
  const setsJson = JSON.stringify(sets);
  const manifestDecks: ManifestDeck[] = decks.map((d, i) => ({
    deck_id: d.id, split: res.split[i], holdout_near: near[i], group_id: grouping.groupOf[i],
    near_cluster_id: grouping.clusterOf[i], archetype: d.archetypeRaw, archetype_key: d.archetypeKey,
    macro: d.macro, colors: d.colors, format: d.format, deck_hash: d.deckHash,
  }));
  const body: Omit<PoolManifest, "manifest_hash"> = {
    pool_version: POOL_VERSION,
    created_from: source,
    params: {
      seed: POOL_SEED, ratios: SPLIT_RATIOS, holdout_near_ratio_of_train: HOLDOUT_NEAR_RATIO,
      near_dup_jaccard: NEAR_DUP_JACCARD, minhash_perms: MINHASH_PERMS, lsh_bands: LSH_BANDS,
      search_trials: SEARCH_TRIALS, minimums: MINIMUMS, deck_hash: "sha256(sorted distinct mainboard oracle_ids joined by \\n)",
      archetype_key: "format::normalized archetype; decks without archetype use their near-duplicate cluster",
      eligible_filter: "is_training_eligible AND archived_at IS NULL AND NOT is_synthetic",
    },
    card_sets: { file: "card_sets.json", sha256: createHash("sha256").update(setsJson).digest("hex") },
    decks: manifestDecks,
  };
  const { pool_version, ...rest } = body;
  const manifest: PoolManifest = { pool_version, manifest_hash: manifestHash(body), ...rest };
  const leak = leakReport(manifest, sets);

  // ---- report ----
  const splits = ["train", "holdout", "benchmark"] as const;
  const count = (key: (m: ManifestDeck) => string) => {
    const m = new Map<string, Record<string, string | number>>();
    for (const d of manifestDecks) {
      const k = key(d);
      const r = m.get(k) ?? { key: k, train: 0, holdout: 0, benchmark: 0, holdout_near: 0, total: 0 };
      (r[d.split] as number)++;
      if (d.holdout_near) (r.holdout_near as number)++;
      (r.total as number)++;
      m.set(k, r);
    }
    return Array.from(m.values()).sort((a, b) => String(a.key).localeCompare(String(b.key)));
  };
  const totals = count(() => "total");
  const nArch = (s?: string) =>
    new Set(manifestDecks.filter(m => !s || m.split === s).map((m, _i) => archetypeLabel({ archetypeKey: m.archetype_key } as never, m.group_id))).size;
  const nGroups = (s?: string) => new Set(manifestDecks.filter(m => !s || m.split === s).map(m => m.group_id)).size;
  const c = res.constraints;
  const report = [
    `# Pool v3: relatório`,
    ``,
    `- manifest_hash: \`${manifest.manifest_hash}\``,
    `- origem: ${source}; decks elegíveis: ${decks.length}; seed ${POOL_SEED}; melhor tentativa ${res.trial} de ${SEARCH_TRIALS} (score ${res.score.toFixed(4)})`,
    `- pares quase-duplicados (Jaccard exato >= ${NEAR_DUP_JACCARD} entre candidatos LSH ${LSH_BANDS}x${MINHASH_PERMS / LSH_BANDS}): ${grouping.nearPairs}; clusters: ${new Set(grouping.clusterOf).size}`,
    `- grupos: ${nGroups()} (treino ${nGroups("train")}, holdout ${nGroups("holdout")}, benchmark ${nGroups("benchmark")}); arquétipos: ${nArch()} (treino ${nArch("train")}, holdout ${nArch("holdout")}, benchmark ${nArch("benchmark")})`,
    `- mínimos: holdout ${c.holdoutDecks} decks / ${c.holdoutArchetypes} arquétipos (>= ${MINIMUMS.holdout.decks}/${MINIMUMS.holdout.archetypes}); benchmark ${c.benchmarkDecks} decks / ${c.benchmarkArchetypes} arquétipos, máx ${c.benchmarkMaxPerArchetype} por arquétipo (>= ${MINIMUMS.benchmark.decks}/${MINIMUMS.benchmark.archetypes}, <= ${MINIMUMS.benchmark.maxPerArchetype})`,
    `- violações: ${c.violations.length ? c.violations.join("; ") : "nenhuma"}`,
    ``,
    `## Jaccard máximo entre splits (exato, conjuntos de oracle_id do main)`,
    ``,
    ...Object.entries(leak.maxJaccard).map(([k, v]) => `- ${k}: ${v.jaccard.toFixed(4)} (decks ${v.a} x ${v.b})`),
    `- deck_hash em mais de um split: ${leak.duplicatedDeckHash.length}; group_id em mais de um split: ${leak.duplicatedGroup.length}; cluster em train_near e holdout_near: ${leak.duplicatedNearCluster.length}`,
    ``,
    `## Por split`,
    ``,
    table(totals, ["key", ...splits, "holdout_near", "total"]),
    ``,
    `holdout_near é tirado do treino (coluna train inclui esses decks).`,
    ``,
    `## Por formato`,
    ``,
    table(count(m => m.format), ["key", ...splits, "holdout_near", "total"]),
    ``,
    `## Por macro-arquétipo`,
    ``,
    table(count(m => m.macro), ["key", ...splits, "holdout_near", "total"]),
    ``,
    `## Por cor (número de cores das mágicas não-terreno)`,
    ``,
    table(count(m => (m.colors.length === 0 ? "c" : m.colors.length >= 3 ? "3+" : String(m.colors.length))), ["key", ...splits, "holdout_near", "total"]),
    ``,
    `## Por formato x macro`,
    ``,
    table(count(m => `${m.format} / ${m.macro}`), ["key", ...splits, "holdout_near", "total"]),
    ``,
  ].join("\n");

  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 1) + "\n");
  fs.writeFileSync(path.join(outDir, "card_sets.json"), setsJson);
  fs.writeFileSync(path.join(outDir, "report.md"), report);
  console.log(report);
  if (c.violations.length) {
    console.error(`[pool-v3] minimums NOT met: ${c.violations.join("; ")}. Do not use this pool.`);
    process.exitCode = 2;
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
