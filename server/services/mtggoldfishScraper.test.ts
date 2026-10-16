import { describe, it, expect, vi, beforeEach } from "vitest";
import { importMTGGoldfishDecks } from "./mtggoldfishScraper";
import { parseDeckExport, saveCompetitiveDeck } from "./competitiveDeckStore";

// Mock fetch
global.fetch = vi.fn();

// Mock db — source uses `getRawClient()` (postgres.js tagged-template), not
// Drizzle. The mock must be callable as a tagged-template literal. For our
// tests we just need the INSERT to "return" a deck id row and subsequent
// inserts to resolve.
function makeFakePg() {
  // Tagged templates are called as pg`SELECT ...` → pg(strings, ...values).
  // Every call returns a Promise resolving to an array. Writes go through begin.
  const pg = vi.fn(async (_strings: TemplateStringsArray, ..._values: any[]) => {
    return [{ id: 1 }];
  });
  return Object.assign(pg, {
    begin: async (fn: (tx: typeof pg) => Promise<unknown>) => fn(pg),
  });
}

vi.mock("../db", () => ({
  getDb: vi.fn(),
  getRawClient: vi.fn(async () => makeFakePg()),
}));

describe("importMTGGoldfishDecks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should import decks successfully with new regex", async () => {
    // Page 1: metagame page with archetype slugs.
    const metagameHtml = `
      <a href="/archetype/modern-boros-energy">Boros Energy</a>
      <a href="/archetype/modern-izzet-murktide">Izzet Murktide</a>
    `;

    // Each archetype page: deck links.
    const archetypeHtml = `
      <a href="/deck/7693069#paper">Deck A</a>
    `;

    const deckTxt = `4 Lightning Bolt\n20 Mountain\n\n1 Red Elemental Blast`;

    (global.fetch as any)
      // 1. metagame page
      .mockResolvedValueOnce({ ok: true, text: () => Promise.resolve(metagameHtml) })
      // 2. archetype 1 page
      .mockResolvedValueOnce({ ok: true, text: () => Promise.resolve(archetypeHtml) })
      // 3. archetype 2 page
      .mockResolvedValueOnce({ ok: true, text: () => Promise.resolve(archetypeHtml) })
      // 4. deck download 1
      .mockResolvedValueOnce({ ok: true, text: () => Promise.resolve(deckTxt) })
      // 5. deck download 2
      .mockResolvedValueOnce({ ok: true, text: () => Promise.resolve(deckTxt) });

    const result = await importMTGGoldfishDecks("modern", 2);

    expect(result.decksImported).toBeGreaterThan(0);
  });

  it("should handle fetch errors gracefully", async () => {
    (global.fetch as any).mockRejectedValueOnce(new Error("Network error"));

    const result = await importMTGGoldfishDecks("modern", 5);

    expect(result.decksImported).toBe(0);
    expect(result.errors.length).toBeGreaterThan(0);
  });
});

describe("competitive deck import contract", () => {
  it("reads an Arena textarea and ignores a Cloudflare challenge", () => {
    const html = `<textarea class='copy-paste-box'>Deck\n4 Lightning Bolt\n20 Mountain\n\nSideboard\n1 Red Elemental Blast</textarea>`;
    const parsed = parseDeckExport(html);
    expect(parsed?.mainboard).toEqual([
      { quantity: 4, cardName: "Lightning Bolt" },
      { quantity: 20, cardName: "Mountain" },
    ]);
    expect(parsed?.sideboard).toEqual([{ quantity: 1, cardName: "Red Elemental Blast" }]);
    expect(parseDeckExport("<html>Just a moment...</html>")).toBeNull();
    const plain = parseDeckExport("4 Lightning Bolt\n20 Mountain\n\n1 Red Elemental Blast");
    expect(plain?.sideboard.map((card) => card.cardName)).toEqual(["Red Elemental Blast"]);
  });

  it("does not insert a header when the mainboard is empty", async () => {
    const pg = vi.fn(async () => [{ id: 1 }]);
    const result = await saveCompetitiveDeck(pg as any, {
      sourceId: "goldfish-1",
      source: "mtggoldfish",
      name: "Empty",
      format: "standard",
      mainboard: [],
      sideboard: [],
    });
    expect(result.imported).toBe(false);
    expect(pg).not.toHaveBeenCalled();
  });

  it("rolls the header and cards back together when a transaction is available", async () => {
    const statements: string[] = [];
    const sql = vi.fn(async (strings: TemplateStringsArray) => {
      statements.push(strings.join(" "));
      return [{ id: 9 }];
    });
    const pg = Object.assign(sql, {
      begin: async (fn: (tx: typeof sql) => Promise<unknown>) => fn(sql),
    });
    const result = await saveCompetitiveDeck(pg as any, {
      sourceId: "top8-e=1&d=2",
      source: "mtgtop8",
      name: "Burn",
      format: "pioneer",
      mainboard: [{ cardName: "Lightning Bolt", quantity: 4 }],
      sideboard: [],
    });
    expect(result).toEqual({ imported: true, cards: 1 });
    expect(statements.some((sqlText) => sqlText.includes("raw_json"))).toBe(true);
    expect(statements.some((sqlText) => sqlText.includes("DELETE FROM competitive_deck_cards"))).toBe(true);
  });

  it("sums duplicate lines in a section instead of aborting the deck", async () => {
    const inserted: unknown[][] = [];
    const sql = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      if (strings.join(" ").includes("INSERT INTO competitive_deck_cards")) inserted.push(values);
      return [{ id: 3 }];
    });
    const pg = Object.assign(sql, {
      begin: async (fn: (tx: typeof sql) => Promise<unknown>) => fn(sql),
    });
    const result = await saveCompetitiveDeck(pg as any, {
      sourceId: "goldfish-9",
      source: "mtggoldfish",
      name: "Burn",
      format: "modern",
      mainboard: [
        { cardName: "Lightning Bolt", quantity: 2 },
        { cardName: "Lightning Bolt", quantity: 2 },
        { cardName: "Mountain", quantity: 20 },
      ],
      sideboard: [{ cardName: "Lightning Bolt", quantity: 1 }],
    });
    expect(result).toEqual({ imported: true, cards: 3 });
    const bolts = inserted.filter((values) => values[1] === "Lightning Bolt");
    expect(bolts).toEqual([
      [3, "Lightning Bolt", 4, "mainboard"],
      [3, "Lightning Bolt", 1, "sideboard"],
    ]);
  });

  it("refuses to write when the client has no transaction", async () => {
    const pg = vi.fn(async () => [{ id: 1 }]);
    await expect(saveCompetitiveDeck(pg as any, {
      sourceId: "goldfish-2",
      source: "mtggoldfish",
      name: "Burn",
      format: "modern",
      mainboard: [{ cardName: "Mountain", quantity: 20 }],
      sideboard: [],
    })).rejects.toThrow(/non-transactional/);
    expect(pg).not.toHaveBeenCalled();
  });
});
