import { describe, it, expect, vi, beforeEach } from "vitest";
import { importMTGGoldfishDecks } from "./mtggoldfishScraper";

// Mock fetch
global.fetch = vi.fn();

// Mock db — source uses `getRawClient()` (postgres.js tagged-template), not
// Drizzle. The mock must be callable as a tagged-template literal. For our
// tests we just need the INSERT to "return" a deck id row and subsequent
// inserts to resolve.
function makeFakePg() {
  // Tagged templates are called as pg`SELECT ...` → pg(strings, ...values).
  // Every call returns a Promise resolving to an array.
  const pg = vi.fn(async (_strings: TemplateStringsArray, ..._values: any[]) => {
    return [{ id: 1 }];
  });
  return pg;
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
