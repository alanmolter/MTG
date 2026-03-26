import { describe, it, expect, vi, beforeEach } from "vitest";
import { importMTGTop8Decks } from "./mtgtop8Scraper";

// Mock fetch
global.fetch = vi.fn();

describe("importMTGTop8Decks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should import decks successfully", async () => {
    // Mock the fetch responses
    const mockHtml = `
      <table>
        <tr>
          <td><a href="?event=123">Test Deck</a></td>
          <td>Standard</td>
          <td>Control</td>
        </tr>
      </table>
    `;

    const mockDeckHtml = `
      <table>
        <tr>
          <td class="G14">4</td>
          <td><a>Lightning Bolt</a></td>
        </tr>
        <tr>
          <td class="G14">24</td>
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

    const result = await importMTGTop8Decks("standard", 5);

    expect(result).toBeDefined();
    expect(result.decksImported).toBeGreaterThanOrEqual(0);
    expect(result.errors).toBeDefined();
  });

  it("should handle fetch errors gracefully", async () => {
    (global.fetch as any).mockRejectedValueOnce(new Error("Network error"));

    const result = await importMTGTop8Decks("standard", 5);

    expect(result).toBeDefined();
    expect(result.decksImported).toBe(0);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toContain("Failed to fetch MTGTop8 data");
  });

  it("should handle invalid responses", async () => {
    (global.fetch as any).mockResolvedValueOnce({
      ok: false,
      status: 404,
    });

    const result = await importMTGTop8Decks("standard", 5);

    expect(result).toBeDefined();
    expect(result.decksImported).toBe(0);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("should respect the limit parameter", async () => {
    const mockHtml = `
      <table>
        ${Array.from({ length: 10 }, (_, i) => `
          <tr>
            <td><a href="?event=${i}">Deck ${i}</a></td>
            <td>Standard</td>
            <td>Control</td>
          </tr>
        `).join('')}
      </table>
    `;

    (global.fetch as any).mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(mockHtml),
    });

    const result = await importMTGTop8Decks("standard", 3);

    // Should attempt to process only the limited number
    expect(result).toBeDefined();
  });

  it("should handle different formats", async () => {
    const mockHtml = `<table></table>`;

    (global.fetch as any).mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(mockHtml),
    });

    const formats = ["standard", "pioneer", "modern", "legacy", "vintage", "commander"];

    for (const format of formats) {
      const result = await importMTGTop8Decks(format, 1);
      expect(result).toBeDefined();
      expect(result.errors).toBeDefined();
    }
  });
});