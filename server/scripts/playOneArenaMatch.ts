/**
 * playOneArenaMatch.ts — End-to-end visual showcase of the learning pipeline.
 *
 * Single command that exercises the full stack on Arena pool:
 *
 *   1. Pre-flight: DB up, Forge GUI jar present, >=2 Arena-legal decks in
 *      Historic-compatible sources. Native Historic is preferred; Standard and
 *      Pioneer are accepted as Arena-legal subsets for a Historic table demo.
 *   2. Pick two decks. Validate every mainboard/sideboard card is Arena-legal
 *      (cards.is_arena = 1). Pad with basic lands only if the DB import is 1-4
 *      mainboard cards short.
 *   3. Write Forge `.dck` files into the user's Forge data dir
 *      (%APPDATA%/Forge/decks/constructed/AutoArena/) so the GUI's
 *      deck picker discovers them automatically.
 *   4. Launch Forge GUI Desktop as a child process. NOT headless —
 *      the user sees the window, watches the AI vs AI match unfold.
 *   5. Print step-by-step instructions on what to click in Forge.
 *   6. Wait for Forge to close (user closes window after match ends).
 *   7. Prompt the user for the winner (1=agent, 2=opponent, 0=draw).
 *   8. Apply learning signal: winning-deck cards get +0.10, losing-deck
 *      cards get -0.04 (asymmetric — losses don't penalize cards as
 *      hard as wins reinforce them, matching the trainer convention).
 *   9. Compute the model's current "learning level" + ETA in runs to
 *      reach the "Mestre" tier (perfect Arena decks).
 *
 * Run with:
 *
 *   npm run train:visual:historic
 *
 * The npm script sets TRAINING_POOL_ARENA_ONLY=1 so the deck picker
 * and signal application both restrict to Arena cards.
 */

import "dotenv/config";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";
import { spawn, spawnSync } from "node:child_process";
import { deflateSync } from "node:zlib";
import { and, count, eq, inArray, sql } from "drizzle-orm";
import {
  cardLearning,
  cards,
  competitiveDecks,
  competitiveDeckCards,
} from "../../drizzle/schema";
import { closeDb, getDb } from "../db";
import { getCardLearningQueue } from "../services/cardLearningQueue";
import { describeTrainingPool } from "./utils/poolFilter";

// ── Constants ────────────────────────────────────────────────────────────────

const FORGE_JAR_REL = "forge/forge-gui-desktop/target/forge-gui-desktop-2.0.12-SNAPSHOT-jar-with-dependencies.jar";
const FORGE_BRIDGE_JAR_REL = "forge/rlbridge/target/rlbridge.jar";
const FORGE_BRIDGE_BUILD_DIR = "forge/rlbridge";
const FORGE_ASSETS_ROOT = "forge/forge-gui";
const HISTORIC_TABLE_FORMAT = "historic";
const HISTORIC_COMPATIBLE_SOURCE_FORMATS = ["historic", "standard", "pioneer"] as const;
const DECK_TARGET_SIZE = 60;
const MAX_BASIC_PAD = 4;
const PREFLIGHT_ONLY = process.argv.includes("--preflight-only");
const AUTO_VISUAL_MATCH = process.argv.includes("--auto") || process.env.VISUAL_AUTO_MATCH === "1";
const MIN_FORGE_GUI_LIFETIME_MS = 8_000;
const VISUAL_AUTO_RESULT_PREFIX = "VISUAL_AUTO_MATCH_RESULT ";
const FORGE_JVM_OPENS = [
  "--add-opens=java.base/java.lang.reflect=ALL-UNNAMED",
  "--add-opens=java.base/java.lang=ALL-UNNAMED",
  "--add-opens=java.base/java.math=ALL-UNNAMED",
  "--add-opens=java.base/java.net=ALL-UNNAMED",
  "--add-opens=java.base/java.nio=ALL-UNNAMED",
  "--add-opens=java.base/java.text=ALL-UNNAMED",
  "--add-opens=java.base/java.util.concurrent=ALL-UNNAMED",
  "--add-opens=java.base/java.util=ALL-UNNAMED",
  "--add-opens=java.base/jdk.internal.misc=ALL-UNNAMED",
  "--add-opens=java.base/sun.nio.ch=ALL-UNNAMED",
  "--add-opens=java.desktop/java.awt.font=ALL-UNNAMED",
  "--add-opens=java.desktop/java.awt=ALL-UNNAMED",
  "--add-opens=java.desktop/java.beans=ALL-UNNAMED",
  "--add-opens=java.desktop/javax.swing.border=ALL-UNNAMED",
  "--add-opens=java.desktop/javax.swing=ALL-UNNAMED",
];

// Reward signal — same magnitudes as applyTournamentSignal, just per-card here.
const DELTA_WIN = 0.10;
const DELTA_LOSS = -0.04;

// ── Helpers ──────────────────────────────────────────────────────────────────

function div(label: string) {
  console.log(`\n${"═".repeat(64)}`);
  console.log(`  ${label}`);
  console.log("═".repeat(64));
}

function sub(label: string) {
  console.log(`\n${"─".repeat(64)}`);
  console.log(`  ${label}`);
  console.log("─".repeat(64));
}

async function ask(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (a) => { rl.close(); resolve(a.trim()); }));
}

function colorsToBasics(colors: string | null): string[] {
  // Map "WUBRG" string to basic land names; default to Wastes (not Arena legal
  // for some formats) → fallback Plains. The basics here are all canonical
  // and Arena-legal everywhere.
  const map: Record<string, string> = { W: "Plains", U: "Island", B: "Swamp", R: "Mountain", G: "Forest" };
  const out = (colors ?? "").split("").map((c) => map[c]).filter(Boolean);
  return out.length > 0 ? out : ["Plains"];
}

function findForgeDataDir(): string {
  // Forge looks at %APPDATA%/Forge by default on Windows. We mirror that.
  // On non-Windows we fall back to ~/.forge or workspace bundled dir.
  const appdata = process.env.APPDATA;
  if (appdata) return path.join(appdata, "Forge");
  const home = os.homedir();
  if (home) return path.join(home, ".forge");
  return path.resolve("forge/forge-gui/res");
}

function deckOutputDir(): string {
  return path.join(findForgeDataDir(), "decks", "constructed", "AutoArena");
}

function ensureDir(p: string) {
  fs.mkdirSync(p, { recursive: true });
}

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let offset = 0; offset < buf.length; offset++) {
    const b = buf[offset];
    crc ^= b;
    for (let i = 0; i < 8; i++) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBuf = Buffer.from(type, "ascii");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function solidPng(width: number, height: number, rgba: [number, number, number, number]): Buffer {
  const header = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // RGBA

  const row = Buffer.alloc(1 + width * 4);
  row[0] = 0; // no filter
  for (let x = 0; x < width; x++) {
    const off = 1 + x * 4;
    row[off] = rgba[0];
    row[off + 1] = rgba[1];
    row[off + 2] = rgba[2];
    row[off + 3] = rgba[3];
  }
  const raw = Buffer.alloc(row.length * height);
  for (let y = 0; y < height; y++) row.copy(raw, y * row.length);

  return Buffer.concat([
    header,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function writePngIfMissing(filePath: string, width: number, height: number, color: [number, number, number, number]) {
  if (fs.existsSync(filePath)) return;
  fs.writeFileSync(filePath, solidPng(width, height, color));
}

function localForgeCacheSkinDir(): string {
  const root = process.env.LOCALAPPDATA || process.env.APPDATA || os.homedir();
  return path.join(root, "Forge", "Cache", "skins");
}

function copySystemFontIfMissing(target: string) {
  if (fs.existsSync(target)) return;
  const candidates = [
    "C:/Windows/Fonts/arial.ttf",
    "C:/Windows/Fonts/segoeui.ttf",
    "C:/Windows/Fonts/calibri.ttf",
  ];
  const source = candidates.find((p) => fs.existsSync(p));
  if (source) fs.copyFileSync(source, target);
}

function ensureForgeGuiAssets(): string {
  const assetsRoot = path.resolve(FORGE_ASSETS_ROOT);
  const defaultSkinDir = path.join(assetsRoot, "res", "skins", "default");
  ensureDir(defaultSkinDir);
  ensureDir(localForgeCacheSkinDir());

  // Source checkouts do not always include binary skin assets. Forge Desktop
  // refuses to open without a default skin, so create deterministic fallback
  // assets that let the GUI boot and still render the board/card text.
  const bgFiles = [
    "bg_splash.png", "bg_splash_hd.png", "bg_texture.jpg", "bg_match.jpg",
    "bg_day.jpg", "bg_night.jpg", "bg_space.png", "bg_chaos_wheel.png",
    "bg_draft_deck.png",
  ];
  for (const file of bgFiles) {
    writePngIfMissing(path.join(defaultSkinDir, file), 1200, 800, [32, 38, 46, 255]);
  }

  const spriteFiles = [
    "sprite_icons.png", "sprite_foils.png", "sprite_old_foils.png",
    "sprite_trophies.png", "sprite_ability.png", "sprite_adv_buttons.png",
    "sprite_buttons.png", "sprite_deckbox.png", "sprite_start.png",
    "sprite_manaicons.png", "sprite_phyrexian.png",
    "sprite_hybrid_colorless.png", "sprite_attraction_lights.png",
    "sprite_cursor.png", "sprite_avatars.png", "sprite_cracks.png",
    "sprite_sleeves.png", "sprite_sleeves2.png", "sprite_favicons.png",
    "sprite_planar_conquest.png", "sprite_setlogo.png",
    "sprite_watermark.png", "sprite_zone.png", "sprite_draftranks.png",
  ];
  for (const file of spriteFiles) {
    writePngIfMissing(path.join(defaultSkinDir, file), 2048, 3072, [96, 112, 128, 255]);
  }

  copySystemFontIfMissing(path.join(defaultSkinDir, "font1.ttf"));
  return assetsRoot;
}

function sanitizeForFilename(s: string): string {
  return s.replace(/[^a-zA-Z0-9_\- ]/g, "").replace(/\s+/g, "_").slice(0, 60);
}

// ── DB queries ───────────────────────────────────────────────────────────────

async function preflight(db: any): Promise<{ arenaCards: number; eligibleDecks: number }> {
  const arenaRows = await db.execute(sql`
    SELECT COUNT(DISTINCT name)::int AS value
    FROM cards
    WHERE is_arena = 1
  `);
  const arenaCards = Number((arenaRows as any)[0]?.value ?? 0);

  const [{ value: eligibleDecks }] = await db
    .select({ value: count() })
    .from(competitiveDecks)
    .where(and(
      eq(competitiveDecks.isSynthetic, false),
      inArray(competitiveDecks.format, HISTORIC_COMPATIBLE_SOURCE_FORMATS),
    ));

  return { arenaCards, eligibleDecks: Number(eligibleDecks) };
}

type PickedDeck = {
  id: number;
  name: string;
  format: string;
  archetype: string | null;
  colors: string | null;
  cards: { name: string; quantity: number; section: string }[];
};

// ── Archetype rotation + brain-driven synthesis ─────────────────────────────
//
// Why this exists: the previous logic picked decks from `competitive_decks`
// (tournament imports) and enforced strict Arena legality — but most imported
// Modern/Legacy/Pioneer decks contain at least one paper-only card, so the
// only archetype that survived validation in this user's DB was Selesnya
// (WG). The visual matches always showed WG vs WG, completely ignoring the
// brain's learned card weights stored in `card_learning`.
//
// Fix (2026-05): synthesize decks DIRECTLY from card_learning weights,
// rotating across 12 archetype recipes (5 mono-color + 7 two-color). This:
//   1. Guarantees colour variety (rotation file persists last-used index).
//   2. Uses the brain's accumulated knowledge — top-weight Arena cards in
//      the requested colour identity drive deck composition.
//   3. Eliminates tournament-import dependency for visual demos.

type ArenaArchetype = { name: string; colors: string; basics: string[] };

const ARENA_ARCHETYPE_ROTATION: readonly ArenaArchetype[] = [
  // Mono-color
  { name: "Mono Red Aggro",      colors: "R",  basics: ["Mountain"] },
  { name: "Mono White Soldiers", colors: "W",  basics: ["Plains"] },
  { name: "Mono Blue Tempo",     colors: "U",  basics: ["Island"] },
  { name: "Mono Black Midrange", colors: "B",  basics: ["Swamp"] },
  { name: "Mono Green Stompy",   colors: "G",  basics: ["Forest"] },
  // Two-color
  { name: "Azorius Control",     colors: "WU", basics: ["Plains", "Island"] },
  { name: "Dimir Midrange",      colors: "UB", basics: ["Island", "Swamp"] },
  { name: "Rakdos Aggro",        colors: "BR", basics: ["Swamp", "Mountain"] },
  { name: "Gruul Stompy",        colors: "RG", basics: ["Mountain", "Forest"] },
  { name: "Selesnya Tokens",    colors: "WG", basics: ["Plains", "Forest"] },
  { name: "Boros Aggro",        colors: "WR", basics: ["Plains", "Mountain"] },
  { name: "Golgari Midrange",   colors: "BG", basics: ["Swamp", "Forest"] },
];

function archetypeStateFile(): string {
  // Persist last archetype index across runs so consecutive runs rotate.
  // Without this, Math.random per-process re-rolls the same pair every time.
  const root = process.env.LOCALAPPDATA || process.env.APPDATA || os.tmpdir();
  return path.join(root, "mtg-deck-mvp", "playArena.archetype.json");
}

function readLastArchetypeIdx(): number {
  try {
    const f = archetypeStateFile();
    if (!fs.existsSync(f)) return -1;
    const parsed = JSON.parse(fs.readFileSync(f, "utf8"));
    if (typeof parsed?.lastAgentIdx === "number") return parsed.lastAgentIdx;
  } catch { /* noop */ }
  return -1;
}

function writeLastArchetypeIdx(agentIdx: number, opponentIdx: number) {
  try {
    const f = archetypeStateFile();
    ensureDir(path.dirname(f));
    fs.writeFileSync(
      f,
      JSON.stringify({
        lastAgentIdx: agentIdx,
        lastOpponentIdx: opponentIdx,
        updatedAt: new Date().toISOString(),
      }),
      "utf8"
    );
  } catch { /* noop — non-fatal */ }
}

/**
 * Build a 60-card deck using card_learning weights as the bias signal.
 *
 * Query: top-N Arena-legal cards whose `colors` contains every letter of
 * `recipe.colors`, ordered by learned `weight` DESC. We LEFT JOIN
 * card_learning so cards without learning data still appear (treated as
 * neutral weight 1.0) — important on fresh DBs where most cards haven't
 * been touched yet by `teach:arena` or Ray training.
 *
 * Deck composition:
 *   - 9 distinct non-basic-land cards × 4 copies = 36 spells (weighted sample
 *     without replacement, so high-weight cards dominate but with variance)
 *   - 24 basic lands distributed across `recipe.basics`
 *
 * Returns null when fewer than 9 distinct Arena-legal cards match the colour
 * identity (caller falls back to import-based selection).
 */
async function synthesizeArenaDeckFromBrain(
  db: any,
  recipe: ArenaArchetype,
): Promise<PickedDeck | null> {
  const colorLetters = recipe.colors.split("");

  // Compose AND clauses for each requested colour. Mono-color: `colors LIKE '%R%'`.
  // Two-color: `colors LIKE '%W%' AND colors LIKE '%U%'`. This requires the
  // card to be EITHER mono- in the requested colour OR a multi-color card that
  // contains all requested letters in its identity string.
  const colorConditions = colorLetters.map(
    (c) => sql`c.colors LIKE ${'%' + c + '%'}`
  );
  const colorClause = colorConditions.length > 0
    ? sql.join(colorConditions, sql` AND `)
    : sql`TRUE`;

  // Query top-N candidates by learned weight. RANDOM() tiebreak avoids
  // identical orderings when many cards share the default 1.0 weight.
  const rows = await db.execute(sql`
    SELECT
      c.name        AS name,
      c.type        AS type,
      COALESCE(cl.weight, 1.0) AS weight
    FROM cards c
    LEFT JOIN card_learning cl ON cl.card_name = c.name
    WHERE c.is_arena = 1
      AND (c.cmc IS NULL OR c.cmc <= 8)
      AND (${colorClause})
      AND (c.type IS NULL OR c.type NOT ILIKE '%basic land%')
    ORDER BY COALESCE(cl.weight, 1.0) DESC, RANDOM()
    LIMIT 120
  `);

  const candidates = (rows as any[])
    .map((r) => ({
      name: String(r.name ?? ""),
      type: r.type ? String(r.type) : null,
      weight: Math.max(0.01, Number(r.weight ?? 1)),
    }))
    .filter((r) => r.name.length > 0);

  if (candidates.length < 9) return null;

  // Weighted random sampling WITHOUT replacement — high-weight cards heavily
  // preferred but every run gets some variance so the same recipe doesn't
  // produce an identical decklist twice.
  const picked: { name: string; quantity: number }[] = [];
  const pool = [...candidates];
  while (picked.length < 9 && pool.length > 0) {
    const total = pool.reduce((s, c) => s + c.weight, 0);
    let r = Math.random() * total;
    let idx = pool.length - 1;
    for (let i = 0; i < pool.length; i++) {
      r -= pool[i].weight;
      if (r <= 0) { idx = i; break; }
    }
    const chosen = pool[idx];
    pool.splice(idx, 1);
    if (!picked.some((p) => p.name === chosen.name)) {
      picked.push({ name: chosen.name, quantity: 4 });
    }
  }

  if (picked.length < 9) return null;

  // Lands: 60 - 36 spells = 24 lands, round-robin across recipe.basics
  const spellsQty = picked.reduce((s, c) => s + c.quantity, 0);
  const landCount = DECK_TARGET_SIZE - spellsQty;
  const basics = recipe.basics.length > 0 ? recipe.basics : ["Plains"];
  const perBasic = Math.floor(landCount / basics.length);
  const remainder = landCount - perBasic * basics.length;
  const lands: { name: string; quantity: number }[] = basics.map((b, i) => ({
    name: b,
    quantity: perBasic + (i < remainder ? 1 : 0),
  }));

  return {
    id: -1, // synthetic — no DB row
    name: recipe.name,
    format: "historic",
    archetype: recipe.name.toLowerCase().replace(/\s+/g, "_"),
    colors: recipe.colors,
    cards: [
      ...picked.map((p) => ({ ...p, section: "mainboard" as const })),
      ...lands.map((l) => ({ ...l, section: "mainboard" as const })),
    ],
  };
}

async function pickTwoArenaDecks(db: any): Promise<PickedDeck[]> {
  // 1. Advance archetype rotation. Agent picks the next index; opponent
  //    picks a different index (offset by a prime so consecutive runs
  //    explore varied matchups, not just `idx, idx+1`).
  const lastIdx = readLastArchetypeIdx();
  const N = ARENA_ARCHETYPE_ROTATION.length;
  const agentIdx = (lastIdx + 1 + Math.floor(Math.random() * 3)) % N;
  let opponentIdx = (agentIdx + 5 + Math.floor(Math.random() * 7)) % N;
  if (opponentIdx === agentIdx) opponentIdx = (agentIdx + 1) % N;
  writeLastArchetypeIdx(agentIdx, opponentIdx);

  const agentRecipe = ARENA_ARCHETYPE_ROTATION[agentIdx];
  const opponentRecipe = ARENA_ARCHETYPE_ROTATION[opponentIdx];

  console.log(`  Rotação agent    : [${agentIdx}] ${agentRecipe.name} (${agentRecipe.colors})`);
  console.log(`  Rotação opponent : [${opponentIdx}] ${opponentRecipe.name} (${opponentRecipe.colors})`);

  // 2. Try brain-driven synthesis first. This uses card_learning weights as
  //    the bias for which cards make the cut, so the model's accumulated
  //    knowledge directly shapes the deck.
  const [agentSynth, opponentSynth] = await Promise.all([
    synthesizeArenaDeckFromBrain(db, agentRecipe),
    synthesizeArenaDeckFromBrain(db, opponentRecipe),
  ]);

  if (agentSynth && opponentSynth) {
    console.log("  Síntese cerebro  : OK (card_learning weights aplicados)");
    return [agentSynth, opponentSynth];
  }

  // 3. Fallback: if brain synthesis failed (DB has <9 Arena cards in the
  //    requested colour identity), use the original tournament-import path
  //    so the script doesn't hard-fail on fresh databases.
  console.log("  Síntese cerebro  : falhou — usando fallback de imports");
  return pickTwoArenaDecksFromImports(db);
}

async function pickTwoArenaDecksFromImports(db: any): Promise<PickedDeck[]> {
  // Fetch all likely candidates, then enforce strict Arena legality in JS.
  // The DB can contain many paper-only Pioneer cards, so a small random sample
  // is not reliable enough for a one-command visual demo.
  const candidates = await db
    .select({
      id: competitiveDecks.id,
      name: competitiveDecks.name,
      format: competitiveDecks.format,
      archetype: competitiveDecks.archetype,
      colors: competitiveDecks.colors,
    })
    .from(competitiveDecks)
    .where(and(
      eq(competitiveDecks.isSynthetic, false),
      inArray(competitiveDecks.format, HISTORIC_COMPATIBLE_SOURCE_FORMATS),
    ))
    .orderBy(sql`RANDOM()`)
    .limit(250);

  const validated: PickedDeck[] = [];

  for (const c of candidates) {
    const allCards = await db
      .select({
        name: competitiveDeckCards.cardName,
        quantity: competitiveDeckCards.quantity,
        section: competitiveDeckCards.section,
      })
      .from(competitiveDeckCards)
      .where(eq(competitiveDeckCards.deckId, c.id));

    const mainboard = allCards.filter((r: any) => r.section === "mainboard");
    if (mainboard.length === 0) continue;

    const cardNames: string[] = Array.from(new Set(allCards.map((r: any) => String(r.name))));
    const arenaRows = await db
      .select({ name: cards.name })
      .from(cards)
      .where(and(eq(cards.isArena, 1), inArray(cards.name, cardNames)));
    const arenaSet = new Set(arenaRows.map((r: any) => r.name));

    const mainboardQty = mainboard.reduce((s: number, r: any) => s + (r.quantity ?? 1), 0);
    const invalidCards = allCards.filter((r: any) => !arenaSet.has(r.name));
    const padNeeded = Math.max(0, DECK_TARGET_SIZE - mainboardQty);

    if (invalidCards.length > 0) continue;
    if (padNeeded > MAX_BASIC_PAD) continue;

    const filtered = allCards.map((r: any) => ({ ...r }));
    if (padNeeded > 0) {
      const basics = colorsToBasics(c.colors);
      for (let i = 0; i < padNeeded; i++) {
        const basic = basics[i % basics.length];
        const existing = filtered.find((r: any) => r.name === basic && r.section === "mainboard");
        if (existing) existing.quantity = (existing.quantity ?? 1) + 1;
        else filtered.push({ name: basic, quantity: 1, section: "mainboard" });
      }
    }

    validated.push({
      id: c.id,
      name: c.name,
      format: c.format,
      archetype: c.archetype,
      colors: c.colors,
      cards: filtered,
    });

    if (validated.length >= 40) break;
  }

  const byName = new Map<string, PickedDeck>();
  for (const d of validated) {
    if (!byName.has(d.name)) byName.set(d.name, d);
  }
  const distinct = Array.from(byName.values());

  for (let i = distinct.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [distinct[i], distinct[j]] = [distinct[j], distinct[i]];
  }

  if (distinct.length < 2) return distinct.slice(0, 2);
  return [distinct[0], distinct[1]];
}

// ── Forge .dck writing ───────────────────────────────────────────────────────

function buildDckContent(deck: PickedDeck, displayName: string): string {
  const lines: string[] = [];
  lines.push("[metadata]");
  lines.push(`Name=${displayName}`);
  if (deck.archetype) lines.push(`Description=${deck.archetype}`);
  lines.push("Deck Type=constructed");

  const main = deck.cards.filter((c) => c.section === "mainboard");
  const side = deck.cards.filter((c) => c.section === "sideboard");

  if (main.length > 0) {
    lines.push("[Main]");
    for (const c of main) lines.push(`${c.quantity ?? 1} ${c.name}`);
  }
  if (side.length > 0) {
    lines.push("[Sideboard]");
    for (const c of side) lines.push(`${c.quantity ?? 1} ${c.name}`);
  }
  return lines.join("\n") + "\n";
}

function writeDeckFiles(decks: PickedDeck[]): { dir: string; files: string[]; displayNames: string[] } {
  const dir = deckOutputDir();
  ensureDir(dir);

  const displayNames: string[] = [];
  const files: string[] = [];
  for (let i = 0; i < decks.length; i++) {
    const d = decks[i];
    const role = i === 0 ? "Agent" : "Opponent";
    const displayName = `AutoArena ${role} - ${d.name}`.slice(0, 100);
    const filename = `${sanitizeForFilename(`${role}_${d.name}`)}.dck`;
    const filepath = path.join(dir, filename);
    fs.writeFileSync(filepath, buildDckContent(d, displayName), "utf8");
    displayNames.push(displayName);
    files.push(filepath);
  }
  return { dir, files, displayNames };
}

// ── Forge GUI launch ─────────────────────────────────────────────────────────

function forgeJarPath(): string | null {
  const p = path.resolve(FORGE_JAR_REL);
  return fs.existsSync(p) ? p : null;
}

function bridgeJarPath(): string {
  return path.resolve(FORGE_BRIDGE_JAR_REL);
}

function ensureRlBridgeJar(): string {
  const jar = bridgeJarPath();
  const sources = [
    "forge/rlbridge/src/main/java/forge/rlbridge/ForgeRLBridge.java",
    "forge/rlbridge/src/main/java/forge/rlbridge/VisualAutoMatch.java",
    "forge/rlbridge/build.cmd",
  ].map((p) => path.resolve(p));

  const jarExists = fs.existsSync(jar);
  const jarMtime = jarExists ? fs.statSync(jar).mtimeMs : 0;
  const needsBuild = !jarExists || sources.some((p) => fs.existsSync(p) && fs.statSync(p).mtimeMs > jarMtime);
  if (!needsBuild) return jar;

  console.log("  Build rlbridge.jar       : necessário para VisualAutoMatch");
  const build = process.platform === "win32"
    ? spawnSync("cmd", ["/c", "build.cmd"], { cwd: path.resolve(FORGE_BRIDGE_BUILD_DIR), stdio: "inherit" })
    : spawnSync("sh", ["build.cmd"], { cwd: path.resolve(FORGE_BRIDGE_BUILD_DIR), stdio: "inherit" });

  if (build.status !== 0 || !fs.existsSync(jar)) {
    throw new Error("Falha ao compilar forge/rlbridge/target/rlbridge.jar");
  }
  return jar;
}

type ForgeLaunchResult = {
  exitCode: number | null;
  elapsedMs: number;
  autoResult?: {
    winner: "agent" | "opponent" | "draw" | string;
    outcome: number;
    status: string;
    turns?: number;
    error?: string;
  };
};

async function launchForgeGui(jarPath: string, deckFiles?: string[]): Promise<ForgeLaunchResult> {
  return new Promise((resolve) => {
    const assetsRoot = ensureForgeGuiAssets();
    const startedAt = Date.now();

    let autoResult: ForgeLaunchResult["autoResult"];
    let stdoutRemainder = "";
    const captureAutoResult = (line: string) => {
      if (!line.startsWith(VISUAL_AUTO_RESULT_PREFIX)) return;
      try {
        autoResult = JSON.parse(line.slice(VISUAL_AUTO_RESULT_PREFIX.length));
      } catch {
        // Keep streaming; close handler will surface missing result.
      }
    };
    const args = AUTO_VISUAL_MATCH && deckFiles?.length === 2
      ? [
          "-Xmx2G",
          ...FORGE_JVM_OPENS,
          "-cp",
          `${jarPath}${path.delimiter}${ensureRlBridgeJar()}`,
          "forge.rlbridge.VisualAutoMatch",
          "--agent-deck",
          deckFiles[0],
          "--opponent-deck",
          deckFiles[1],
          "--timeout-sec",
          "900",
          "--close-delay-sec",
          "8",
        ]
      : ["-Xmx2G", ...FORGE_JVM_OPENS, "-jar", jarPath];

    const proc = spawn("java", args, {
      stdio: AUTO_VISUAL_MATCH ? ["ignore", "pipe", "pipe"] : "inherit",
      cwd: assetsRoot,
    });
    if (AUTO_VISUAL_MATCH) {
      proc.stdout?.on("data", (chunk) => {
        const text = chunk.toString();
        process.stdout.write(text);
        stdoutRemainder += text;
        const lines = stdoutRemainder.split(/\r?\n/);
        stdoutRemainder = lines.pop() ?? "";
        for (const line of lines) {
          captureAutoResult(line);
        }
      });
      proc.stderr?.on("data", (chunk) => process.stderr.write(chunk));
    }
    proc.on("close", (exitCode) => {
      if (AUTO_VISUAL_MATCH && stdoutRemainder.trim()) {
        captureAutoResult(stdoutRemainder.trim());
      }
      resolve({ exitCode, elapsedMs: Date.now() - startedAt, autoResult });
    });
    proc.on("error", (err) => {
      console.warn(`  [AVISO] Falha ao spawnar Forge: ${err.message}`);
      resolve({ exitCode: 1, elapsedMs: Date.now() - startedAt });
    });
  });
}

// ── Learning signal ──────────────────────────────────────────────────────────

async function applyMatchSignal(winnerDeck: PickedDeck | null, loserDeck: PickedDeck | null) {
  const queue = getCardLearningQueue();
  let plus = 0;
  let minus = 0;

  if (winnerDeck) {
    for (const c of winnerDeck.cards.filter((x) => x.section === "mainboard")) {
      const qtyBonus = Math.log2((c.quantity ?? 1) + 1);
      await queue.enqueue({ cardName: c.name, delta: DELTA_WIN * qtyBonus, source: "unified_learning" });
      plus++;
    }
  }
  if (loserDeck) {
    for (const c of loserDeck.cards.filter((x) => x.section === "mainboard")) {
      const qtyBonus = Math.log2((c.quantity ?? 1) + 1);
      await queue.enqueue({ cardName: c.name, delta: DELTA_LOSS * qtyBonus, source: "unified_learning" });
      minus++;
    }
  }
  await queue.flush();
  const stats = queue.getAndResetStats();
  console.log(`  Cartas reforçadas (+) : ${plus}`);
  console.log(`  Cartas penalizadas (-): ${minus}`);
  console.log(`  Atualizadas no DB     : ${stats.totalUpdated}`);
  console.log(`  Saturadas (decay)     : ${stats.totalSaturated}`);
}

// ── Learning level / ETA ─────────────────────────────────────────────────────

type LearningLevel = {
  tier: string;
  emoji: string;
  coveragePct: number;
  arenaTotal: number;
  arenaWithData: number;
  arenaStable: number;
  estimatedRunsToMaster: string;
  topCards: { name: string; weight: number; wr: string; games: number }[];
};

async function computeLearningLevel(db: any): Promise<LearningLevel> {
  // `cards` stores multiple printings per card name, while `card_learning`
  // is keyed by card_name. Always measure/report Arena learning by unique
  // card names, otherwise joins duplicate cards with many Arena printings.
  const arenaTotalRows = await db.execute(sql`
    SELECT COUNT(DISTINCT name)::int AS cnt
    FROM cards
    WHERE is_arena = 1
  `);
  const arenaTotal = Number((arenaTotalRows as any)[0]?.cnt ?? 0);

  // Arena cards that have any learning data (>=1 game).
  const withDataRows = await db.execute(sql`
    SELECT COUNT(*)::int AS cnt
    FROM card_learning cl
    WHERE (cl.win_count + cl.loss_count) >= 1
      AND EXISTS (
        SELECT 1
        FROM cards c
        WHERE c.name = cl.card_name
          AND c.is_arena = 1
      )
  `);
  const arenaWithData = Number((withDataRows as any)[0]?.cnt ?? 0);

  // Arena cards considered "stable" — >=10 games.
  const stableRows = await db.execute(sql`
    SELECT COUNT(*)::int AS cnt
    FROM card_learning cl
    WHERE (cl.win_count + cl.loss_count) >= 10
      AND EXISTS (
        SELECT 1
        FROM cards c
        WHERE c.name = cl.card_name
          AND c.is_arena = 1
      )
  `);
  const arenaStable = Number((stableRows as any)[0]?.cnt ?? 0);

  const at = arenaTotal;
  const coveragePct = at > 0 ? (arenaStable / at) * 100 : 0;

  // Tier mapping. The thresholds are deliberately conservative — "Mestre"
  // requires that the model has stable signal on most of the Arena pool,
  // which is the precondition for generating consistently-good Arena decks.
  let tier = "Aprendiz", emoji = "🥉";
  if (coveragePct >= 90) { tier = "Mestre"; emoji = "🏆"; }
  else if (coveragePct >= 75) { tier = "Avançado"; emoji = "🥇"; }
  else if (coveragePct >= 50) { tier = "Intermediário"; emoji = "🥈"; }
  else if (coveragePct >= 25) { tier = "Iniciante"; emoji = "🥉"; }

  // Crude ETA — use a coarse band based on the gap to 90%. Each `teach`
  // run touches ~150k card-game records, so the marginal gain on stable-
  // count tapers as you climb.
  const gap = Math.max(0, 90 - coveragePct);
  let etaRuns = "Pronto.";
  if (gap > 60)      etaRuns = "30–50 runs";
  else if (gap > 40) etaRuns = "20–35 runs";
  else if (gap > 25) etaRuns = "12–22 runs";
  else if (gap > 10) etaRuns = "5–12 runs";
  else if (gap > 0)  etaRuns = "1–5 runs";

  const topRows = await db.execute(sql`
    SELECT cl.card_name AS name, cl.weight, cl.win_count, cl.loss_count
    FROM card_learning cl
    WHERE (cl.win_count + cl.loss_count) >= 5
      AND EXISTS (
        SELECT 1
        FROM cards c
        WHERE c.name = cl.card_name
          AND c.is_arena = 1
      )
    ORDER BY cl.weight DESC, (cl.win_count + cl.loss_count) DESC, cl.card_name ASC
    LIMIT 5
  `);
  const topCards = (topRows as any[]).map((r: any) => {
    const games = Number(r.win_count) + Number(r.loss_count);
    const wr = games > 0 ? `${((Number(r.win_count) / games) * 100).toFixed(0)}%` : "—";
    return { name: r.name, weight: Number(r.weight), wr, games };
  });

  return { tier, emoji, coveragePct, arenaTotal: at, arenaWithData, arenaStable, estimatedRunsToMaster: etaRuns, topCards };
}

function bar(value: number, max: number, width = 30): string {
  if (max <= 0) return "[" + " ".repeat(width) + "]";
  const filled = Math.round((value / max) * width);
  return "[" + "█".repeat(filled) + "░".repeat(width - filled) + "]";
}

function printLearningLevel(l: LearningLevel) {
  div("CEREBRO — NÍVEL DE APRENDIZADO ATUAL");
  console.log(`  Tier atual            : ${l.emoji} ${l.tier}`);
  console.log(`  Cartas Arena no pool  : ${l.arenaTotal}`);
  console.log(`  Com algum dado (>=1)  : ${l.arenaWithData} (${((l.arenaWithData / Math.max(l.arenaTotal, 1)) * 100).toFixed(1)}%)`);
  console.log(`  Estáveis (>=10 partidas): ${l.arenaStable} (${l.coveragePct.toFixed(1)}%)`);
  console.log(`  Cobertura estável     : ${bar(l.arenaStable, l.arenaTotal)} ${l.coveragePct.toFixed(1)}%`);
  console.log(`  ETA até "Mestre" (90%): ${l.estimatedRunsToMaster}`);

  if (l.topCards.length > 0) {
    console.log("\n  TOP 5 CARTAS ARENA (>=5 partidas, ordenadas por peso):");
    for (let i = 0; i < l.topCards.length; i++) {
      const c = l.topCards[i];
      console.log(`    ${i + 1}. ${c.name.padEnd(34)} peso ${c.weight.toFixed(2).padStart(6)} | ${c.wr.padStart(4)} wr | ${c.games} jogos`);
    }
  }
  console.log("═".repeat(64));
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  div("PLAY ONE ARENA MATCH — pipeline end-to-end");
  console.log(`  Pool                  : ${describeTrainingPool()}`);
  console.log(`  Formato da partida    : ${HISTORIC_TABLE_FORMAT}`);
  console.log(`  Forge mode            : GUI desktop (não-headless, visual)`);
  console.log(`  Quantidade de partidas: 1`);

  const db = await getDb();
  if (!db) {
    console.error("\n[ERRO] Banco de dados indisponível. Verifique Postgres.");
    process.exit(1);
  }

  // 1. Pre-flight ────────────────────────────────────────────────────────────
  sub("1/6  Pré-flight — banco + decks + Forge");
  const pf = await preflight(db);
  console.log(`  Cartas Arena no banco          : ${pf.arenaCards}`);
  console.log(`  Decks competitivos elegíveis   : ${pf.eligibleDecks} (fontes: ${HISTORIC_COMPATIBLE_SOURCE_FORMATS.join(", ")})`);
  if (pf.arenaCards < 100) {
    console.error("\n[ERRO] Pool Arena vazio ou pequeno demais. Rode:");
    console.error("       npm run db:repair-arena -- --apply");
    process.exit(2);
  }
  if (pf.eligibleDecks < 2) {
    console.error("\n[ERRO] Sem decks competitivos suficientes. Rode:");
    console.error("       npm run import:competitive:arena");
    process.exit(2);
  }

  const jarPath = forgeJarPath();
  if (!jarPath) {
    console.error(`\n[ERRO] Forge JAR não encontrado em ${FORGE_JAR_REL}.`);
    console.error("       Rode o build do Forge antes (mvn package em forge/).");
    process.exit(2);
  }
  console.log(`  Forge JAR                      : ${path.basename(jarPath)} ✓`);

  // 2. Pick decks ────────────────────────────────────────────────────────────
  sub("2/6  Selecionar 2 decks Arena-legais");
  const decks = await pickTwoArenaDecks(db);
  if (decks.length < 2) {
    console.error("\n[ERRO] Não consegui validar 2 decks compatíveis com Historic com 100% das cartas Arena-legais.");
    console.error("       Re-importe decks com `npm run import:competitive:arena` e tente de novo.");
    process.exit(3);
  }
  console.log(`  Agent    : ${decks[0].name}  (${decks[0].format}, ${decks[0].colors ?? "—"}, ${decks[0].archetype ?? "—"})`);
  console.log(`  Opponent : ${decks[1].name}  (${decks[1].format}, ${decks[1].colors ?? "—"}, ${decks[1].archetype ?? "—"})`);

  // 3. Write .dck files ──────────────────────────────────────────────────────
  sub("3/6  Gravar arquivos .dck pro Forge");
  const { dir, files, displayNames } = writeDeckFiles(decks);
  console.log(`  Diretório : ${dir}`);
  for (let i = 0; i < files.length; i++) {
    console.log(`  ${i + 1}. ${displayNames[i]}`);
    console.log(`      ${path.basename(files[i])}`);
  }

  if (PREFLIGHT_ONLY) {
    const assetsRoot = ensureForgeGuiAssets();
    console.log(`  Assets Forge preparados em: ${assetsRoot}`);
    console.log("\n  Pré-flight concluído. Forge não foi aberto porque --preflight-only foi usado.");
    return;
  }

  // 4. Launch Forge ──────────────────────────────────────────────────────────
  sub("4/6  Abrir Forge GUI (visual, não-headless)");
  console.log("  Janela do Forge vai abrir em alguns segundos...");
  console.log("");
  if (AUTO_VISUAL_MATCH) {
    console.log("  ┌─ MODO AUTOMÁTICO ──────────────────────────────────────────┐");
    console.log("  │ O Forge abrirá, iniciará AI vs AI sozinho, mostrará a mesa │");
    console.log("  │ até o resultado, imprimirá o vencedor e fechará sozinho.   │");
    console.log(`  │ Agent    → ${displayNames[0].slice(0, 38).padEnd(38)} │`);
    console.log(`  │ Opponent → ${displayNames[1].slice(0, 38).padEnd(38)} │`);
    console.log("  └───────────────────────────────────────────────────────────┘");
  } else {
    console.log("  ┌─ COMO INICIAR A PARTIDA NO FORGE ─────────────────────────┐");
    console.log("  │ 1. Tela inicial → \"Sanctioned\" → \"Constructed\"            │");
    console.log("  │ 2. Em \"Player 1\", clique no botão de avatar e selecione   │");
    console.log("  │    AI (não Human).                                        │");
    console.log("  │ 3. Em \"Player 2\", também selecione AI.                    │");
    console.log("  │ 4. Em cada Player, clique \"Constructed Decks\" e procure   │");
    console.log("  │    pela pasta \"AutoArena\". Dentro:                        │");
    console.log(`  │      Player 1 → ${displayNames[0].slice(0, 38).padEnd(38)} │`);
    console.log(`  │      Player 2 → ${displayNames[1].slice(0, 38).padEnd(38)} │`);
    console.log("  │ 5. Clique \"Start Game\" e assista à partida.               │");
    console.log("  │ 6. Ao final, FECHE A JANELA do Forge para voltar aqui.    │");
    console.log("  └───────────────────────────────────────────────────────────┘");
  }
  console.log("");

  const forgeRun = await launchForgeGui(jarPath, files);
  if (forgeRun.exitCode !== 0 || forgeRun.elapsedMs < MIN_FORGE_GUI_LIFETIME_MS) {
    console.error("\n[ERRO] O Forge fechou antes da partida começar.");
    console.error(`       exitCode=${forgeRun.exitCode ?? "n/a"} | duração=${(forgeRun.elapsedMs / 1000).toFixed(1)}s`);
    console.error("       Verifique os logs acima; o launcher agora prepara skins locais em forge/forge-gui/res/skins/default.");
    process.exit(4);
  }
  console.log("  Forge fechado. Continuando...");

  // 5. Ask winner ────────────────────────────────────────────────────────────
  sub("5/6  Resultado da partida");
  let winnerIdx = -1;
  if (AUTO_VISUAL_MATCH) {
    if (!forgeRun.autoResult) {
      console.error("\n[ERRO] Forge automático fechou sem emitir resultado parseável.");
      process.exit(5);
    }
    console.log(`  Status visual auto : ${forgeRun.autoResult.status}`);
    console.log(`  Resultado bruto    : ${forgeRun.autoResult.winner} (outcome=${forgeRun.autoResult.outcome})`);
    if (forgeRun.autoResult.outcome === 1 || forgeRun.autoResult.winner === "agent") winnerIdx = 0;
    else if (forgeRun.autoResult.outcome === -1 || forgeRun.autoResult.winner === "opponent") winnerIdx = 1;
    else winnerIdx = -2;
  } else {
    while (winnerIdx === -1) {
      const ans = await ask("  Quem venceu? (1 = Agent, 2 = Opponent, 0 = Empate): ");
      if (ans === "0") winnerIdx = -2;
      else if (ans === "1") winnerIdx = 0;
      else if (ans === "2") winnerIdx = 1;
      else console.log("  Resposta inválida. Use 0, 1 ou 2.");
    }
  }

  if (winnerIdx === -2) {
    console.log("  Empate registrado — nenhum sinal aplicado.");
  } else {
    const winnerDeck = decks[winnerIdx];
    const loserDeck = decks[1 - winnerIdx];
    console.log(`  Vencedor : ${winnerDeck.name}`);
    console.log(`  Perdedor : ${loserDeck.name}`);
    console.log("");
    console.log("  Aplicando sinal de aprendizado em card_learning...");
    await applyMatchSignal(winnerDeck, loserDeck);
  }

  // 6. Report learning level ─────────────────────────────────────────────────
  sub("6/6  Status do aprendizado");
  const level = await computeLearningLevel(db);
  printLearningLevel(level);

  console.log("\n  PRÓXIMOS PASSOS RECOMENDADOS:");
  if (level.coveragePct < 25) {
    console.log("    npm run teach:arena:20         # 20 ciclos pra base inicial");
    console.log("    npm run import:competitive:arena   # mais sinal de torneio");
  } else if (level.coveragePct < 75) {
    console.log("    npm run teach:arena:20         # mais decay + cobertura");
    console.log("    npm run calibrate:llm           # refinamento LLM");
  } else if (level.coveragePct < 90) {
    console.log("    npm run teach:arena             # 1-2 ciclos pra fechar");
    console.log("    npm run train:ray:smoke:arena   # validação Ray IMPALA");
  } else {
    console.log("    npm run train:ray:arena         # treino IMPALA cheio");
    console.log("    Modelo pronto pra gerar decks Arena consistentes.");
  }
  console.log("");
}

main()
  .catch((e) => {
    console.error("\n[playOneArenaMatch] erro fatal:", e?.message ?? e);
    if (e?.stack) console.error(e.stack);
    process.exitCode = 1;
  })
  .finally(() => {
    closeDb().then(() => process.exit(process.exitCode ?? 0)).catch(() => process.exit(1));
  });
