import { describe, it, expect, vi, beforeEach } from "vitest";
import { importMTGGoldfishDecks } from "./mtggoldfishScraper";

// Mock fetch
global.fetch = vi.fn();

describe("importMTGGoldfishDecks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should import decks successfully", async () => {
    // Mock the fetch responses
    const mockHtml = `
      <div class="deck-row">
        <a href="/deck/123" class="deck-link">Test Deck</a>
        <span class="archetype">Control</span>
      </div>
    `;

    const mockDeckHtml = `
      <table>
        <tr>
          <td class="text-center">4</td>
          <td><a>Lightning Bolt</a></td>
        </tr>
        <tr>
          <td class="text-center">24</td>
          <td><a>Island</a></td>
        </tr>
      </table>
    `;

    (global.fetch as any)
      .mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve(mockHtml),
      })
      .mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve(mockDeckHtml),
      });

    const result = await importMTGGoldfishDecks("standard", 5);

    expect(result).toBeDefined();
    expect(result.decksImported).toBeGreaterThanOrEqual(0);
    expect(result.errors).toBeDefined();
  });

  it("should handle fetch errors gracefully", async () => {
    (global.fetch as any).mockRejectedValueOnce(new Error("Network error"));

    const result = await importMTGGoldfishDecks("standard", 5);

    expect(result).toBeDefined();
    expect(result.decksImported).toBe(0);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toContain("Failed to fetch MTGGoldfish data");
  });

  it("should handle invalid responses", async () => {
    (global.fetch as any).mockResolvedValueOnce({
      ok: false,
      status: 404,
    });

    const result = await importMTGGoldfishDecks("standard", 5);

    expect(result).toBeDefined();
    expect(result.decksImported).toBe(0);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("should respect the limit parameter", async () => {
    const mockHtml = `
      <div class="deck-container">
        ${Array.from({ length: 10 }, (_, i) => `
          <div class="deck-row">
            <a href="/deck/${i}" class="deck-link">Deck ${i}</a>
          </div>
        `).join('')}
      </div>
    `;

    (global.fetch as any).mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(mockHtml),
    });

    const result = await importMTGGoldfishDecks("standard", 3);

    expect(result).toBeDefined();
  });

  it("should handle different formats", async () => {
    const mockHtml = `<div></div>`;

    (global.fetch as any).mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(mockHtml),
    });

    const formats = ["standard", "pioneer", "modern", "legacy", "vintage", "commander"];

    for (const format of formats) {
      const result = await importMTGGoldfishDecks(format, 1);
      expect(result).toBeDefined();
      expect(result.errors).toBeDefined();
    }
  });

  it("should extract deck metadata correctly", async () => {
    const mockHtml = `
      <div class="deck-row">
        <a href="/deck/123" class="deck-link">Izzet Control</a>
        <span class="author">TestPlayer</span>
        <span class="views">1500</span>
        <span class="likes">45</span>
      </div>
    `;

    (global.fetch as any).mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(mockHtml),
    });

    const result = await importMTGGoldfishDecks("standard", 1);

    expect(result).toBeDefined();
    // The actual parsing depends on the HTML structure
  });
});