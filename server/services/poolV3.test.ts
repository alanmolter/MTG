import { describe, expect, it } from "vitest";
import {
  assignHoldoutNear, assignSplits, buildGroups, checkConstraints, deckColors, deckHash, jaccard, macroOf,
  manifestHash, minhashSignature, nearDuplicatePairs, normalizeArchetypeName, toPoolDeck, type PoolDeckInput,
} from "./poolV3";
import { membershipRows } from "./poolMembershipRows";

const ids = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix}-${String(i).padStart(3, "0")}`);
const deck = (id: number, format: string, archetype: string | null, oids: string[]): PoolDeckInput => ({
  id, format, archetype, main: oids.map(o => [o, 4, "R", "Instant"] as [string, number, string, string]),
});

describe("pool v3 normalization", () => {
  it("normalizes archetype names", () => {
    expect(normalizeArchetypeName("Death&#039;s Shadow")).toBe(normalizeArchetypeName("Death's Shadow"));
    expect(normalizeArchetypeName("UR Aggro")).toBe("izzet aggro");
    expect(normalizeArchetypeName("BUG Midrange")).toBe("sultai midrange");
    expect(normalizeArchetypeName("Other - Aggro")).toBeNull();
    expect(normalizeArchetypeName("  ")).toBeNull();
  });
  it("maps macro archetypes", () => {
    expect(macroOf("Grixis Midrange")).toBe("midrange");
    expect(macroOf("Temur Control")).toBe("control");
    expect(macroOf("Golgari Combo")).toBe("combo-ramp");
    expect(macroOf("Red Deck Wins")).toBe("aggro");
  });
  it("deck_hash is order and quantity independent; colors skip lands", () => {
    expect(deckHash(["b", "a", "a"])).toBe(deckHash(["a", "b"]));
    expect(deckColors([["x", 4, "G", "Basic Land — Forest"], ["y", 4, "UR", "Instant"], ["z", 1, "W", "Creature"]])).toBe("WUR");
  });
});

describe("pool v3 similarity", () => {
  it("LSH finds the exact near-duplicate pairs", () => {
    const base = ids("c", 30);
    const decks = [
      toPoolDeck(deck(1, "modern", null, base)),
      toPoolDeck(deck(2, "modern", null, [...base.slice(0, 28), "x1", "x2"])), // J = 28/32 = 0.875
      toPoolDeck(deck(3, "modern", null, [...base.slice(0, 18), ...ids("y", 12)])), // J = 18/42
    ];
    expect(jaccard(decks[0].oracleIds, decks[1].oracleIds)).toBeCloseTo(0.875);
    expect(nearDuplicatePairs(decks).map(([a, b]) => [a, b])).toEqual([[0, 1]]);
    expect(minhashSignature(base)).toEqual(minhashSignature([...base].reverse()));
  });
  it("groups near-duplicates and archetypes (format-scoped); no archetype keeps its cluster", () => {
    const a = ids("a", 30), b = ids("b", 30);
    const decks = [
      deck(1, "modern", "Burn", a), deck(2, "modern", "Burn", b), deck(3, "pauper", "Burn", ids("p", 30)),
      deck(4, "modern", null, [...a.slice(0, 29), "z"]), deck(5, "modern", null, ids("q", 30)),
    ].map(toPoolDeck);
    const g = buildGroups(decks).groupOf;
    expect(g[0]).toBe(g[1]);
    expect(g[0]).toBe(g[3]);
    expect(g[2]).not.toBe(g[0]);
    expect(new Set(g).size).toBe(3);
  });
});

describe("pool v3 split", () => {
  // 6 formats x 45 archetypes x 3 decks: plenty of groups.
  const inputs: PoolDeckInput[] = [];
  let id = 1;
  for (const f of ["modern", "pauper", "legacy", "pioneer", "standard", "vintage"])
    for (let a = 0; a < 45; a++)
      for (let k = 0; k < 3; k++) inputs.push(deck(id++, f, `Arch ${a} ${a % 2 ? "Aggro" : "Control"}`, ids(`${f}${a}-${k}`, 25)));
  const decks = inputs.map(toPoolDeck);
  const { groupOf, clusterOf } = buildGroups(decks);

  it("is deterministic, leak-free by group and meets the minimums", () => {
    const r1 = assignSplits(decks, groupOf, 7, 200);
    const r2 = assignSplits(decks, groupOf, 7, 200);
    expect(r1.split).toEqual(r2.split);
    const where = new Map<string, Set<string>>();
    groupOf.forEach((g, i) => where.set(g, (where.get(g) ?? new Set()).add(r1.split[i])));
    expect(Array.from(where.values()).every(s => s.size === 1)).toBe(true);
    expect(r1.constraints.violations).toEqual([]);
    for (const f of ["modern", "vintage"]) {
      const idx = decks.map((d, i) => (d.format === f ? i : -1)).filter(i => i >= 0);
      const h = idx.filter(i => r1.split[i] === "holdout").length;
      expect(h).toBeGreaterThanOrEqual(24);
      expect(h).toBeLessThanOrEqual(30);
    }
    const near = assignHoldoutNear(decks, clusterOf, r1.split);
    expect(near.every((n, i) => !n || r1.split[i] === "train")).toBe(true);
    expect(near.filter(Boolean).length).toBeGreaterThan(0);
  });

  it("reports unmet minimums instead of relaxing them", () => {
    const tiny = inputs.slice(0, 30).map(toPoolDeck);
    const g = buildGroups(tiny).groupOf;
    const r = assignSplits(tiny, g, 1, 50);
    expect(r.constraints.violations.length).toBeGreaterThan(0);
    expect(checkConstraints(tiny, g, r.split).violations).toEqual(r.constraints.violations);
  });
});

describe("pool memberships", () => {
  it("rejects an edited manifest and emits holdout_near rows", () => {
    const body = {
      pool_version: 3, created_from: "test", params: {}, card_sets: { file: "x", sha256: "y" },
      decks: [{ deck_id: 1, split: "train" as const, holdout_near: true, group_id: "g1", near_cluster_id: "n1", archetype: null,
        archetype_key: null, macro: "unknown" as const, colors: "", format: "modern", deck_hash: "h" }],
    };
    const m = { ...body, manifest_hash: manifestHash(body) };
    expect(membershipRows(m).map(r => [r.split, r.group_id])).toEqual([["train", "g1"], ["holdout_near", "n1"]]);
    expect(() => membershipRows({ ...m, decks: [{ ...m.decks[0], split: "holdout" as const, holdout_near: false }] })).toThrow(/manifest_hash/);
  });
});
