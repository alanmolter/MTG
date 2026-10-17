/**
 * CI leakage gate for the committed pool manifest (data/pools/v3).
 * No deck_hash or group_id in more than one split, no near-duplicate cluster
 * on both sides of holdout_near, max exact Jaccard between splits < 0.8, and
 * the manifest and card sets unchanged since generation.
 */
import { createHash } from "crypto";
import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";
import { MINIMUMS, NEAR_DUP_JACCARD, deckHash, leakReport, manifestHash, type CardSets, type PoolManifest } from "./poolV3";

const dir = path.resolve(__dirname, "../../data/pools/v3");
const manifestRaw = fs.readFileSync(path.join(dir, "manifest.json"), "utf8");
const manifest = JSON.parse(manifestRaw) as PoolManifest;
const setsRaw = fs.readFileSync(path.join(dir, manifest.card_sets.file), "utf8");
const sets = JSON.parse(setsRaw) as CardSets;
const report = leakReport(manifest, sets);

describe("pool v3 leakage", () => {
  it("manifest and card sets are intact", () => {
    expect(manifestHash(manifest)).toBe(manifest.manifest_hash);
    expect(createHash("sha256").update(setsRaw).digest("hex")).toBe(manifest.card_sets.sha256);
    for (const d of manifest.decks)
      expect(deckHash((sets.decks[String(d.deck_id)] ?? []).map(i => sets.oracle_ids[i]))).toBe(d.deck_hash);
    expect(new Set(manifest.decks.map(d => d.deck_id)).size).toBe(manifest.decks.length);
  });
  it("no deck_hash, group_id or near cluster crosses splits", () => {
    expect(report.duplicatedDeckHash).toEqual([]);
    expect(report.duplicatedGroup).toEqual([]);
    expect(report.duplicatedNearCluster).toEqual([]);
    expect(manifest.decks.every(d => !d.holdout_near || d.split === "train")).toBe(true);
  });
  it.each(Object.keys(report.maxJaccard))("max Jaccard %s < 0.8", key => {
    expect(report.maxJaccard[key].jaccard).toBeLessThan(NEAR_DUP_JACCARD);
  });
  it("benchmark has at most 5 decks per archetype and the minimums hold", () => {
    const per = new Map<string, number>();
    for (const d of manifest.decks.filter(d => d.split === "benchmark")) {
      const k = d.archetype_key ?? `cluster:${d.group_id}`;
      per.set(k, (per.get(k) ?? 0) + 1);
    }
    expect(Math.max(...Array.from(per.values()))).toBeLessThanOrEqual(MINIMUMS.benchmark.maxPerArchetype);
    expect(per.size).toBeGreaterThanOrEqual(MINIMUMS.benchmark.archetypes);
    const hold = manifest.decks.filter(d => d.split === "holdout");
    expect(hold.length).toBeGreaterThanOrEqual(MINIMUMS.holdout.decks);
    expect(new Set(hold.map(d => d.archetype_key ?? `cluster:${d.group_id}`)).size).toBeGreaterThanOrEqual(MINIMUMS.holdout.archetypes);
  });
});
