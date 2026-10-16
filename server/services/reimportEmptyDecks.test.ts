import { describe, expect, it, vi } from "vitest";
import {
  deckFromStoredJson,
  EMPTY_DECK_SQL,
  refetchUrls,
  reimportEmptyDecks,
  type EmptyDeckRow,
} from "./reimportEmptyDecks";

function row(overrides: Partial<EmptyDeckRow> = {}): EmptyDeckRow {
  return {
    id: 7,
    sourceId: "goldfish-42",
    source: "mtggoldfish",
    name: "Burn",
    format: "modern",
    archetype: "burn",
    author: "MTGGoldfish",
    rawJson: null,
    ...overrides,
  };
}

describe("reimport empty competitive decks", () => {
  it("selects only decks that have no card rows", () => {
    expect(EMPTY_DECK_SQL).toContain("NOT EXISTS");
    expect(EMPTY_DECK_SQL).toContain("competitive_deck_cards");
  });

  it("rebuilds a deck from raw_json and does not refetch it", async () => {
    const fetchText = vi.fn(async () => "4 Lightning Bolt\n20 Mountain");
    const save = vi.fn(async () => ({ imported: true, cards: 2 }));
    const report = await reimportEmptyDecks({
      listEmpty: async () => [
        row({
          rawJson: JSON.stringify({
            mainboard: [
              { cardName: "Lightning Bolt", quantity: 4 },
              { cardName: "Mountain", quantity: 20 },
            ],
            sideboard: [],
          }),
        }),
      ],
      fetchText,
      save,
    });
    expect(fetchText).not.toHaveBeenCalled();
    expect(save).toHaveBeenCalledOnce();
    expect(report.reimported).toBe(1);
    expect(report.failed).toEqual([]);
  });

  it("refetches a goldfish deck that has no stored list", async () => {
    const fetchText = vi.fn(async (url: string) => {
      if (url.endsWith("/arena_download/42")) return "4 Lightning Bolt\n20 Mountain";
      return null;
    });
    const save = vi.fn(async () => ({ imported: true, cards: 2 }));
    const report = await reimportEmptyDecks({
      listEmpty: async () => [row()],
      fetchText,
      save,
    });
    expect(fetchText).toHaveBeenCalledWith("https://www.mtggoldfish.com/deck/arena_download/42");
    expect(report.reimported).toBe(1);
  });

  it("builds a top8 download url and reads deck text out of raw_json", () => {
    expect(refetchUrls(row({ sourceId: "top8-e=1&d=2" }))).toEqual([
      "https://mtgtop8.com/mtgo?e=1&d=2",
    ]);
    const parsed = deckFromStoredJson(row({ rawJson: "4 Lightning Bolt\n20 Mountain\n\n1 Pyroblast" }));
    expect(parsed?.sideboard.map((card) => card.cardName)).toEqual(["Pyroblast"]);
  });

  it("skips a deck whose source cannot be fetched", async () => {
    const report = await reimportEmptyDecks({
      listEmpty: async () => [row({ sourceId: "moxfield-abc", rawJson: null })],
      fetchText: async () => null,
      save: async () => ({ imported: true, cards: 1 }),
    });
    expect(report.reimported).toBe(0);
    expect(report.skipped).toHaveLength(1);
  });
});
