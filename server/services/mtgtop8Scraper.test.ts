import { describe, it, expect, vi, beforeEach } from "vitest";
import { importMTGTop8Decks } from "./mtgtop8Scraper";

// Mock fetch
global.fetch = vi.fn();

// Mock db — source uses `getRawClient()` (postgres.js tagged-template).
function makeFakePg() {
  return vi.fn(async (_strings: TemplateStringsArray, ..._values: any[]) => {
    return [{ id: 1 }];
  });
}

vi.mock("../db", () => ({
  getDb: vi.fn(),
  getRawClient: vi.fn(async () => makeFakePg()),
}));

describe("importMTGTop8Decks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should import decks from top8 with new regex", async () => {
    // Page 1: format metagame page with archetype links (no quotes, matches
    // real MTGTop8 HTML pattern `href=archetype?a=N&meta=N&f=XX>Name</a>`).
    const metagameHtml = `
      <a href=archetype?a=193&meta=54&f=MO>Boros Aggro</a>
    `;

    // Page 2: archetype detail page with deck event links.
    const archetypeHtml = `
      <a href=/event?e=82539&d=827346&f=MO>Deck A</a>
    `;

    // Page 3: deck download (MTGO text format). No blank line before
    // sideboard — the parser keys on the word "Sideboard" at line start.
    const deckTxt = `4 Lightning Bolt\n20 Mountain\nSideboard\n1 Pyroblast`;

    (global.fetch as any)
      .mockResolvedValueOnce({ ok: true, text: () => Promise.resolve(metagameHtml) })
      .mockResolvedValueOnce({ ok: true, text: () => Promise.resolve(archetypeHtml) })
      .mockResolvedValueOnce({ ok: true, text: () => Promise.resolve(deckTxt) });

    const result = await importMTGTop8Decks("modern", 1);

    expect(result.decksImported).toBe(1);
  });
});
