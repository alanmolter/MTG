import { describe, it, expect, vi, beforeEach } from "vitest";
import { importMTGGoldfishDecks } from "./mtggoldfishScraper";

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

describe("importMTGGoldfishDecks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should import decks successfully with new regex", async () => {
    const mockHtml = `
      <a href="/deck/123#paper" class="deck-link">Test Deck</a>
      <a href="/deck/456#paper" class="deck-link">Other Deck</a>
    `;

    const mockDeckTxt = `4 Lightning Bolt\n20 Mountain\n\nSideboard\n1 Red Elemental Blast`;

    (global.fetch as any)
      .mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve(mockHtml),
      })
      .mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve(mockDeckTxt),
      })
      .mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve(mockDeckTxt),
      });

    const result = await importMTGGoldfishDecks("modern", 2);

    expect(result.decksImported).toBeGreaterThan(0);
    expect(result.errors).toHaveLength(0);
  });

  it("should handle fetch errors gracefully", async () => {
    (global.fetch as any).mockRejectedValueOnce(new Error("Network error"));

    const result = await importMTGGoldfishDecks("modern", 5);

    expect(result.decksImported).toBe(0);
    expect(result.errors.length).toBeGreaterThan(0);
  });
});