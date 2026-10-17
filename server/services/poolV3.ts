/**
 * Pool v3 (spec: Eng. IA/ML, 2026-10-16). Pure functions only, no DB.
 *
 * - deck_hash: sha256 of the sorted distinct mainboard oracle_ids.
 * - Leakage unit: near-duplicates (MinHash/LSH candidates, kept when the exact
 *   Jaccard on mainboard oracle_id sets is >= 0.8), then union by normalized
 *   archetype (format-scoped). A deck with no archetype keeps its cluster.
 * - Split by group: 70/20/10 train/holdout/benchmark, stratified by format
 *   (required: every group has one format) and, best effort, by macro and
 *   color bucket. Fixed seed, deterministic.
 * - Holdout >= 150 decks and >= 15 archetypes; benchmark >= 40 decks, >= 8
 *   archetypes and <= 5 decks per archetype. Not met -> reported, never relaxed.
 * - Secondary split holdout_near: drawn from the train decks by near-duplicate
 *   cluster only (archetypes are shared with train on purpose).
 */
import { createHash } from "crypto";
import { deckSizeClass, type DeckSizeClass } from "./trainingQuality";

export const POOL_VERSION = 3;
export const POOL_SEED = 20261016;
export const NEAR_DUP_JACCARD = 0.8;
export const MINHASH_PERMS = 128;
export const LSH_BANDS = 32; // 32 bands x 4 rows: ~P(candidate) > 0.98 at J = 0.8
export const SPLIT_RATIOS = { train: 0.7, holdout: 0.2, benchmark: 0.1 } as const;
export const HOLDOUT_NEAR_RATIO = 0.2; // share of the train decks
export const MINIMUMS = {
  holdout: { decks: 150, archetypes: 15 },
  benchmark: { decks: 40, archetypes: 8, maxPerArchetype: 5 },
} as const;
export const SEARCH_TRIALS = 4000;

export type Split = "train" | "holdout" | "benchmark";
export type Macro = "aggro" | "midrange" | "control" | "combo-ramp" | "unknown";

export interface PoolDeckInput {
  id: number;
  format: string;
  archetype: string | null;
  /** Mainboard rows: oracle_id, quantity, card colors ("UR", ""), type line. */
  main: Array<[string, number, string | null, string | null]>;
  /** Mainboard card count and Yorion in companion/side, for the size class (optional for old exports). */
  main_cards?: number;
  yorion?: boolean;
}

export interface PoolDeck {
  id: number;
  format: string;
  archetypeRaw: string | null;
  /** Format-scoped normalized archetype ("modern::izzet aggro"), null if none. */
  archetypeKey: string | null;
  macro: Macro;
  colors: string; // WUBRG order, "" for colorless
  colorBucket: string; // "c" | "1" | "2" | "3+"
  oracleIds: string[]; // sorted, distinct
  deckHash: string;
  sizeClass?: DeckSizeClass;
}

// ---------- normalization ----------

const GUILD: Record<string, string> = {
  wu: "azorius", ub: "dimir", br: "rakdos", rg: "gruul", wg: "selesnya",
  wb: "orzhov", ur: "izzet", bg: "golgari", wr: "boros", ug: "simic",
  ubg: "sultai", urg: "temur", wur: "jeskai", ubr: "grixis", brg: "jund",
  wbg: "abzan", wbr: "mardu", wug: "bant", wub: "esper", wrg: "naya",
};
const NO_ARCHETYPE = /^(other|unknown|misc|rogue)\b/;

function decodeEntities(s: string): string {
  return s
    .replace(/&#0*39;|&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

/** Lowercase, entities decoded, accents and punctuation dropped, color codes -> guild names. */
export function normalizeArchetypeName(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = decodeEntities(raw)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/['’`]/g, "")
    .replace(/[^a-z0-9/]+/g, " ")
    .trim()
    .split(/\s+/)
    .map(w => {
      const key = w.split("").sort((a, b) => "wubrg".indexOf(a) - "wubrg".indexOf(b)).join("");
      return /^[wubrg]{2,3}$/.test(w) && GUILD[key] ? GUILD[key] : w;
    })
    .join(" ");
  if (!s || NO_ARCHETYPE.test(s)) return null;
  return s;
}

export function archetypeKey(format: string, raw: string | null): string | null {
  const n = normalizeArchetypeName(raw);
  return n ? `${format.toLowerCase()}::${n}` : null;
}

const MACRO_RULES: Array<[RegExp, Macro]> = [
  [/combo|ramp|ritual|storm|devotion|reclamation|cascade|crash|bazaar|gifts|scapeshift|tron/, "combo-ramp"],
  [/control|mud|xerox|artifacts blue/, "control"],
  [/midrange|jund|blink|death s shadow|deaths shadow|maverick|hollow one|legends/, "midrange"],
  [/aggro|tempo|burn|red deck wins|weenie|hatebear|affinity|elves|merfolk|stompy|phoenix|eldrazi/, "aggro"],
];

/** Macro archetype from the name. Best effort, used only for stratification and the report. */
export function macroOf(raw: string | null): Macro {
  const n = normalizeArchetypeName(raw) ?? (raw ? raw.toLowerCase() : "");
  for (const [re, m] of MACRO_RULES) if (re.test(n)) return m;
  return "unknown";
}

/** Deck color from the colors of its non-land cards, WUBRG order. */
export function deckColors(main: PoolDeckInput["main"]): string {
  const set = new Set<string>();
  for (const [, , colors, type] of main) {
    if (type && /\bLand\b/.test(type)) continue;
    for (const ch of (colors ?? "").toUpperCase()) if ("WUBRG".includes(ch)) set.add(ch);
  }
  return "WUBRG".split("").filter(c => set.has(c)).join("");
}

export function colorBucket(colors: string): string {
  return colors.length === 0 ? "c" : colors.length >= 3 ? "3+" : String(colors.length);
}

export function deckHash(oracleIds: Iterable<string>): string {
  const sorted = Array.from(new Set(oracleIds)).sort();
  return createHash("sha256").update(sorted.join("\n")).digest("hex");
}

export function toPoolDeck(d: PoolDeckInput): PoolDeck {
  const oracleIds = Array.from(new Set(d.main.map(r => r[0]).filter(Boolean))).sort();
  const colors = deckColors(d.main);
  return {
    id: d.id,
    format: d.format.toLowerCase(),
    archetypeRaw: d.archetype,
    archetypeKey: archetypeKey(d.format, d.archetype),
    macro: macroOf(d.archetype),
    colors,
    colorBucket: colorBucket(colors),
    oracleIds,
    deckHash: deckHash(oracleIds),
    sizeClass: d.main_cards === undefined ? undefined : deckSizeClass(d.format, Number(d.main_cards), Boolean(d.yorion)),
  };
}

// ---------- similarity ----------

export function jaccard(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 && b.length === 0) return 1;
  const sb = new Set(b);
  let inter = 0;
  for (const x of a) if (sb.has(x)) inter++;
  return inter / (a.length + sb.size - inter);
}

export function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

function fmix32(h: number): number {
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

export function minhashSignature(ids: readonly string[], perms = MINHASH_PERMS, seed = POOL_SEED): Uint32Array {
  const rnd = mulberry32(seed);
  const salts = Array.from({ length: perms }, () => Math.floor(rnd() * 4294967296) >>> 0);
  const sig = new Uint32Array(perms).fill(0xffffffff);
  for (const id of ids) {
    const base = fnv1a(id);
    for (let i = 0; i < perms; i++) {
      const h = fmix32(base ^ salts[i]);
      if (h < sig[i]) sig[i] = h;
    }
  }
  return sig;
}

/** LSH candidate pairs (i < j, indexes into decks), then exact Jaccard >= threshold. */
export function nearDuplicatePairs(
  decks: readonly PoolDeck[],
  threshold = NEAR_DUP_JACCARD,
  bands = LSH_BANDS
): Array<[number, number, number]> {
  const rows = MINHASH_PERMS / bands;
  const sigs = decks.map(d => minhashSignature(d.oracleIds));
  const seen = new Set<string>();
  const out: Array<[number, number, number]> = [];
  for (let b = 0; b < bands; b++) {
    const buckets = new Map<string, number[]>();
    decks.forEach((_, i) => {
      const key = Array.from(sigs[i].subarray(b * rows, (b + 1) * rows)).join(",");
      const list = buckets.get(key);
      if (list) list.push(i);
      else buckets.set(key, [i]);
    });
    for (const list of Array.from(buckets.values())) {
      for (let x = 0; x < list.length; x++)
        for (let y = x + 1; y < list.length; y++) {
          const k = `${list[x]},${list[y]}`;
          if (seen.has(k)) continue;
          seen.add(k);
          const j = jaccard(decks[list[x]].oracleIds, decks[list[y]].oracleIds);
          if (j >= threshold) out.push([list[x], list[y], j]);
        }
    }
  }
  return out;
}

class UnionFind {
  parent: number[];
  constructor(n: number) {
    this.parent = Array.from({ length: n }, (_, i) => i);
  }
  find(i: number): number {
    while (this.parent[i] !== i) {
      this.parent[i] = this.parent[this.parent[i]];
      i = this.parent[i];
    }
    return i;
  }
  union(a: number, b: number) {
    const ra = this.find(a), rb = this.find(b);
    if (ra !== rb) this.parent[Math.max(ra, rb)] = Math.min(ra, rb);
  }
}

export interface Grouping {
  /** group_id per deck index: "g" + smallest deck id of the group. */
  groupOf: string[];
  /** near-duplicate cluster id per deck index: "n" + smallest deck id. */
  clusterOf: string[];
  nearPairs: number;
}

export function buildGroups(decks: readonly PoolDeck[]): Grouping {
  const pairs = nearDuplicatePairs(decks);
  const near = new UnionFind(decks.length);
  const full = new UnionFind(decks.length);
  for (const [a, b] of pairs) {
    near.union(a, b);
    full.union(a, b);
  }
  const firstByArch = new Map<string, number>();
  decks.forEach((d, i) => {
    if (!d.archetypeKey) return;
    const f = firstByArch.get(d.archetypeKey);
    if (f === undefined) firstByArch.set(d.archetypeKey, i);
    else full.union(f, i);
  });
  const label = (uf: UnionFind, prefix: string) => {
    const minId = new Map<number, number>();
    decks.forEach((d, i) => {
      const r = uf.find(i);
      minId.set(r, Math.min(minId.get(r) ?? Infinity, d.id));
    });
    return decks.map((_, i) => `${prefix}${minId.get(uf.find(i))}`);
  };
  return { groupOf: label(full, "g"), clusterOf: label(near, "n"), nearPairs: pairs.length };
}

// ---------- split ----------

interface Group {
  id: string;
  format: string;
  members: number[];
  archCounts: Map<string, number>;
}

function groupsOf(decks: readonly PoolDeck[], ids: readonly string[], subset?: readonly number[]): Group[] {
  const map = new Map<string, Group>();
  for (const i of subset ?? decks.map((_, k) => k)) {
    const id = ids[i];
    let g = map.get(id);
    if (!g) {
      g = { id, format: decks[i].format, members: [], archCounts: new Map() };
      map.set(id, g);
    }
    if (g.format !== decks[i].format) g.format = "__mixed__";
    g.members.push(i);
    const a = decks[i].archetypeKey ?? `cluster:${id}`;
    g.archCounts.set(a, (g.archCounts.get(a) ?? 0) + 1);
  }
  return Array.from(map.values()).sort((a, b) => (a.id < b.id ? -1 : 1));
}

function shuffle<T>(arr: T[], rnd: () => number): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function distribution(decks: readonly PoolDeck[], idx: readonly number[], key: (d: PoolDeck) => string) {
  const m = new Map<string, number>();
  for (const i of idx) m.set(key(decks[i]), (m.get(key(decks[i])) ?? 0) + 1);
  const total = idx.length || 1;
  return new Map(Array.from(m, ([k, v]) => [k, v / total] as [string, number]));
}

function l1(a: Map<string, number>, b: Map<string, number>): number {
  let s = 0;
  for (const k of Array.from(new Set([...Array.from(a.keys()), ...Array.from(b.keys())])))
    s += Math.abs((a.get(k) ?? 0) - (b.get(k) ?? 0));
  return s;
}

/** Archetypes counted as in the spec: format-scoped archetype, or the cluster for decks without one. */
export function archetypeLabel(d: PoolDeck, group: string): string {
  return d.archetypeKey ?? `cluster:${group}`;
}

export interface ConstraintCheck {
  holdoutDecks: number;
  holdoutArchetypes: number;
  benchmarkDecks: number;
  benchmarkArchetypes: number;
  benchmarkMaxPerArchetype: number;
  violations: string[];
}

export function checkConstraints(decks: readonly PoolDeck[], groupOf: readonly string[], split: readonly Split[]): ConstraintCheck {
  const arch = (s: Split) => {
    const m = new Map<string, number>();
    decks.forEach((d, i) => {
      if (split[i] === s) m.set(archetypeLabel(d, groupOf[i]), (m.get(archetypeLabel(d, groupOf[i])) ?? 0) + 1);
    });
    return m;
  };
  const h = arch("holdout"), b = arch("benchmark");
  const res: ConstraintCheck = {
    holdoutDecks: split.filter(s => s === "holdout").length,
    holdoutArchetypes: h.size,
    benchmarkDecks: split.filter(s => s === "benchmark").length,
    benchmarkArchetypes: b.size,
    benchmarkMaxPerArchetype: Math.max(0, ...Array.from(b.values())),
    violations: [],
  };
  const M = MINIMUMS;
  if (res.holdoutDecks < M.holdout.decks) res.violations.push(`holdout decks ${res.holdoutDecks} < ${M.holdout.decks}`);
  if (res.holdoutArchetypes < M.holdout.archetypes) res.violations.push(`holdout archetypes ${res.holdoutArchetypes} < ${M.holdout.archetypes}`);
  if (res.benchmarkDecks < M.benchmark.decks) res.violations.push(`benchmark decks ${res.benchmarkDecks} < ${M.benchmark.decks}`);
  if (res.benchmarkArchetypes < M.benchmark.archetypes) res.violations.push(`benchmark archetypes ${res.benchmarkArchetypes} < ${M.benchmark.archetypes}`);
  if (res.benchmarkMaxPerArchetype > M.benchmark.maxPerArchetype)
    res.violations.push(`benchmark max per archetype ${res.benchmarkMaxPerArchetype} > ${M.benchmark.maxPerArchetype}`);
  return res;
}

/** Greedy fill: take a group when it brings the count closer to the target. */
function fill(groups: Group[], target: number, current: number, accept: (g: Group) => boolean): [Group[], number] {
  const taken: Group[] = [];
  for (const g of groups) {
    if (!accept(g)) continue;
    const next = current + g.members.length;
    if (Math.abs(next - target) < Math.abs(current - target)) {
      taken.push(g);
      current = next;
    }
  }
  return [taken, current];
}

export interface SplitResult {
  split: Split[];
  trial: number;
  score: number;
  constraints: ConstraintCheck;
}

/**
 * Seeded random-restart search. Per format: shuffle its groups, fill the
 * benchmark (only groups with <= 5 decks per archetype), then the holdout, the
 * rest is train. Score: per-format deviation from 20%/10% plus best-effort
 * macro and color distance between each eval split and the whole pool;
 * constraint violations dominate the score. Lowest score wins.
 */
export function assignSplits(decks: readonly PoolDeck[], groupOf: readonly string[], seed = POOL_SEED, trials = SEARCH_TRIALS): SplitResult {
  const groups = groupsOf(decks, groupOf);
  const formats = Array.from(new Set(groups.map(g => g.format))).sort();
  const all = decks.map((_, i) => i);
  const macroAll = distribution(decks, all, d => d.macro);
  const colorAll = distribution(decks, all, d => d.colorBucket);
  const benchOk = (g: Group) => Array.from(g.archCounts.values()).every(c => c <= MINIMUMS.benchmark.maxPerArchetype);
  const rnd = mulberry32(seed);
  let best: SplitResult | null = null;
  for (let t = 0; t < trials; t++) {
    const split: Split[] = decks.map(() => "train");
    let dev = 0;
    for (const f of formats) {
      const gs = shuffle(groups.filter(g => g.format === f), rnd);
      const n = gs.reduce((s, g) => s + g.members.length, 0);
      const [bench, bc] = fill(gs, n * SPLIT_RATIOS.benchmark, 0, benchOk);
      const benchIds = new Set(bench.map(g => g.id));
      const [hold, hc] = fill(gs, n * SPLIT_RATIOS.holdout, 0, g => !benchIds.has(g.id));
      for (const g of bench) for (const i of g.members) split[i] = "benchmark";
      for (const g of hold) for (const i of g.members) split[i] = "holdout";
      dev += (Math.abs(bc - n * SPLIT_RATIOS.benchmark) + Math.abs(hc - n * SPLIT_RATIOS.holdout)) / decks.length;
    }
    const idx = (s: Split) => all.filter(i => split[i] === s);
    const h = idx("holdout"), b = idx("benchmark");
    const strat =
      0.5 * l1(distribution(decks, h, d => d.macro), macroAll) +
      0.25 * l1(distribution(decks, b, d => d.macro), macroAll) +
      0.25 * l1(distribution(decks, h, d => d.colorBucket), colorAll) +
      0.1 * l1(distribution(decks, b, d => d.colorBucket), colorAll);
    const constraints = checkConstraints(decks, groupOf, split);
    const score = 100 * constraints.violations.length + 4 * dev + strat;
    if (!best || score < best.score - 1e-12) best = { split, trial: t, score, constraints };
  }
  return best!;
}

export const HOLDOUT_CONTROL_TARGET = 10;
const PROMOTE_MAX_GROUP = 15;

export interface ControlPromotion {
  split: Split[];
  moved: { group_id: string; format: string; decks: number; control: number } | null;
  holdoutControlBefore: number;
  holdoutControlAfter: number;
}

/**
 * Best effort: if the holdout has fewer than HOLDOUT_CONTROL_TARGET control decks,
 * move ONE small, single-format, control-majority train group (whole group, so the
 * grouping is not broken) to the holdout. Smallest group first, ties by group id;
 * skipped if it would break a minimum or leave its format without train decks.
 */
export function promoteControlToHoldout(decks: readonly PoolDeck[], groupOf: readonly string[], split: readonly Split[]): ControlPromotion {
  const ctl = (s: readonly Split[]) => decks.filter((d, i) => s[i] === "holdout" && d.macro === "control").length;
  const before = ctl(split);
  const out = split.slice();
  if (before >= HOLDOUT_CONTROL_TARGET) return { split: out, moved: null, holdoutControlBefore: before, holdoutControlAfter: before };
  const train = decks.map((_, i) => i).filter(i => split[i] === "train");
  const holdFormats = new Set(decks.filter((d, i) => split[i] === "holdout" && d.macro === "control").map(d => d.format));
  const cands = groupsOf(decks, groupOf, train)
    .map(g => ({ g, control: g.members.filter(i => decks[i].macro === "control").length }))
    .filter(({ g, control }) => g.format !== "__mixed__" && g.members.length <= PROMOTE_MAX_GROUP && control * 2 >= g.members.length)
    .sort((a, b) => Number(holdFormats.has(a.g.format)) - Number(holdFormats.has(b.g.format)) || a.g.members.length - b.g.members.length || (a.g.id < b.g.id ? -1 : 1));
  for (const { g, control } of cands) {
    const trial = out.slice();
    for (const i of g.members) trial[i] = "holdout";
    const leftInFormat = decks.some((d, i) => trial[i] === "train" && d.format === g.format);
    if (!leftInFormat || checkConstraints(decks, groupOf, trial).violations.length) continue;
    return { split: trial, moved: { group_id: g.id, format: g.format, decks: g.members.length, control }, holdoutControlBefore: before, holdoutControlAfter: ctl(trial) };
  }
  return { split: out, moved: null, holdoutControlBefore: before, holdoutControlAfter: before };
}

/** holdout_near: whole near-duplicate clusters taken out of the train decks, stratified by format. */
export function assignHoldoutNear(decks: readonly PoolDeck[], clusterOf: readonly string[], split: readonly Split[], seed = POOL_SEED + 1): boolean[] {
  const trainIdx = decks.map((_, i) => i).filter(i => split[i] === "train");
  const groups = groupsOf(decks, clusterOf, trainIdx);
  const rnd = mulberry32(seed);
  const near = decks.map(() => false);
  for (const f of Array.from(new Set(groups.map(g => g.format))).sort()) {
    const gs = shuffle(groups.filter(g => g.format === f), rnd);
    const n = gs.reduce((s, g) => s + g.members.length, 0);
    const [taken] = fill(gs, n * HOLDOUT_NEAR_RATIO, 0, () => true);
    for (const g of taken) for (const i of g.members) near[i] = true;
  }
  return near;
}

/** Max exact Jaccard between two deck index sets, with the pair. */
export function maxCrossJaccard(decks: readonly PoolDeck[], a: readonly number[], b: readonly number[]) {
  let best = { jaccard: 0, a: -1, b: -1 };
  for (const i of a)
    for (const j of b) {
      const v = jaccard(decks[i].oracleIds, decks[j].oracleIds);
      if (v > best.jaccard) best = { jaccard: v, a: decks[i].id, b: decks[j].id };
    }
  return best;
}

// ---------- manifest ----------

export interface ManifestDeck {
  deck_id: number;
  split: Split;
  holdout_near: boolean;
  /** true for holdout_near (and any non-train split): BC/RL loaders must not train on this deck. */
  exclude_from_train: boolean;
  /** standard60 | offsize_61_63 | yorion_80_81 | atypical (trainingQuality.deckSizeClass). */
  size_class: string | null;
  group_id: string;
  near_cluster_id: string;
  archetype: string | null;
  archetype_key: string | null;
  macro: Macro;
  colors: string;
  format: string;
  deck_hash: string;
}

export interface PoolManifest {
  pool_version: number;
  manifest_hash: string;
  created_from: string;
  params: Record<string, unknown>;
  card_sets: { file: string; sha256: string };
  caveats?: string[];
  decks: ManifestDeck[];
}

/** Deck ids a BC/RL loader may train on: split train and not excluded (holdout_near). */
export function trainDeckIds(manifest: Pick<PoolManifest, "decks">): number[] {
  return manifest.decks.filter(d => d.split === "train" && !d.exclude_from_train && !d.holdout_near).map(d => d.deck_id);
}

export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v && typeof v === "object")
    return `{${Object.keys(v as object)
      .sort()
      .map(k => `${JSON.stringify(k)}:${canonicalJson((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  return JSON.stringify(v);
}

/** sha256 of the canonical JSON of the manifest without manifest_hash (and without created_from). */
export function manifestHash(m: Omit<PoolManifest, "manifest_hash"> | PoolManifest): string {
  const { manifest_hash: _h, created_from: _c, ...rest } = m as PoolManifest;
  return createHash("sha256").update(canonicalJson(rest)).digest("hex");
}

/** Compact card sets: a sorted oracle_id dictionary and, per deck, indexes into it. */
export interface CardSets {
  oracle_ids: string[];
  decks: Record<string, number[]>;
}

export function buildCardSets(decks: readonly PoolDeck[]): CardSets {
  const dict = Array.from(new Set(decks.flatMap(d => d.oracleIds))).sort();
  const pos = new Map(dict.map((o, i) => [o, i]));
  const out: Record<string, number[]> = {};
  for (const d of Array.from(decks).sort((a, b) => a.id - b.id)) out[String(d.id)] = d.oracleIds.map(o => pos.get(o)!);
  return { oracle_ids: dict, decks: out };
}

export interface LeakReport {
  duplicatedDeckHash: string[];
  duplicatedGroup: string[];
  duplicatedNearCluster: string[];
  maxJaccard: Record<string, { jaccard: number; a: number; b: number }>;
}

/** The checks the CI runs on the committed manifest. */
export function leakReport(manifest: PoolManifest, sets: CardSets): LeakReport {
  const decks: PoolDeck[] = manifest.decks.map(m => ({
    id: m.deck_id, format: m.format, archetypeRaw: m.archetype, archetypeKey: m.archetype_key,
    macro: m.macro, colors: m.colors, colorBucket: colorBucket(m.colors),
    oracleIds: (sets.decks[String(m.deck_id)] ?? []).map(i => sets.oracle_ids[i]), deckHash: m.deck_hash,
  }));
  const spread = (key: (m: ManifestDeck) => string, part: (m: ManifestDeck) => string, filter: (m: ManifestDeck) => boolean = () => true) => {
    const m = new Map<string, Set<string>>();
    for (const d of manifest.decks.filter(filter)) {
      const s = m.get(key(d)) ?? new Set<string>();
      s.add(part(d));
      m.set(key(d), s);
    }
    return Array.from(m).filter(([, s]) => s.size > 1).map(([k]) => k).sort();
  };
  const idx = (f: (m: ManifestDeck) => boolean) => manifest.decks.map((m, i) => (f(m) ? i : -1)).filter(i => i >= 0);
  const train = idx(m => m.split === "train"), hold = idx(m => m.split === "holdout"), bench = idx(m => m.split === "benchmark");
  const nearH = idx(m => m.split === "train" && m.holdout_near), nearT = idx(m => m.split === "train" && !m.holdout_near);
  return {
    duplicatedDeckHash: spread(m => m.deck_hash, m => m.split),
    duplicatedGroup: spread(m => m.group_id, m => m.split),
    duplicatedNearCluster: spread(m => m.near_cluster_id, m => String(m.holdout_near), m => m.split === "train"),
    maxJaccard: {
      "train x holdout": maxCrossJaccard(decks, train, hold),
      "train x benchmark": maxCrossJaccard(decks, train, bench),
      "holdout x benchmark": maxCrossJaccard(decks, hold, bench),
      "train_near x holdout_near": maxCrossJaccard(decks, nearT, nearH),
    },
  };
}
