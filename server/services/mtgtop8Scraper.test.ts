import { describe, it, expect, vi, beforeEach } from "vitest";
import { importMTGTop8Decks } from "./mtgtop8Scraper";

// Mock fetch
global.fetch = vi.fn();

// Mock db
vi.mock("../db", () => ({
  getDb: vi.fn().mockResolvedValue({
    insert: vi.fn().mockReturnThis(),
    values: vi.fn().mockReturnThis(),
    onConflictDoUpdate: vi.fn().mockReturnThis(),
    returning: vi.fn().mockResolvedValue([{ id: 1 }]),
  }),
}));

describe("importMTGTop8Decks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should import decks from top8 with new regex", async () => {
    const mockHtml = `
      <a href="/event?e=123&d=456" class="deck-link">Test Deck</a>
    `;

    const mockDeckTxt = `4 Lightning Bolt\n20 Mountain\nSideboard\n1 Pyroblast`;

    (global.fetch as any)
      .mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve(mockHtml),
      })
      .mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve(mockDeckTxt),
      });

    const result = await importMTGTop8Decks("modern", 1);

    expect(result.decksImported).toBe(1);
    expect(result.errors).toHaveLength(0);
  });
});