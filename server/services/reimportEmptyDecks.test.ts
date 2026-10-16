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

describe("reimport F1: MTGTop8 bare ids, dry-run, batches", () => {
  const top8 = (id: number, sourceId = `e=1&d=${id}`): EmptyDeckRow =>
    row({ id, sourceId, source: "mtgtop8", author: null });

  it("accepts bare e=&d= ids only for source mtgtop8", () => {
    expect(refetchUrls(top8(1, "e=49033&d=561465"))).toEqual(["https://mtgtop8.com/mtgo?e=49033&d=561465"]);
    expect(refetchUrls(top8(1, "top8-e=2&d=3"))).toEqual(["https://mtgtop8.com/mtgo?e=2&d=3"]);
    expect(refetchUrls(row({ sourceId: "e=1&d=2", source: "moxfield" }))).toEqual([]);
  });

  it("dry-run neither fetches nor saves and lists every deck", async () => {
    const fetchText = vi.fn(async () => "4 Lightning Bolt");
    const save = vi.fn(async () => ({ imported: true, cards: 1 }));
    const report = await reimportEmptyDecks(
      { listEmpty: async () => [top8(1), top8(2)], fetchText, save },
      { dryRun: true },
    );
    expect(fetchText).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    expect(report.log.map((e) => e.outcome)).toEqual(["would_reimport", "would_reimport"]);
    expect(report.log[0].url).toBe("https://mtgtop8.com/mtgo?e=1&d=1");
  });

  it("processes in batches, honours maxBatches and the source filter", async () => {
    const rows = [1, 2, 3, 4, 5].map((i) => top8(i)).concat([row({ id: 99 })]);
    const batches: number[] = [];
    const report = await reimportEmptyDecks(
      {
        listEmpty: async () => rows,
        fetchText: async () => "4 Lightning Bolt\n56 Mountain",
        save: async () => ({ imported: true, cards: 2 }),
      },
      { batchSize: 2, maxBatches: 2, source: "mtgtop8", onBatch: (_b, e) => batches.push(e.length) },
    );
    expect(report.considered).toBe(5);
    expect(batches).toEqual([2, 2]);
    expect(report.reimported).toBe(4);
  });

  it("does not overwrite a deck that got cards meanwhile (idempotent)", async () => {
    const save = vi.fn(async () => ({ imported: true, cards: 2 }));
    const report = await reimportEmptyDecks({
      listEmpty: async () => [top8(1)],
      fetchText: async () => "4 Lightning Bolt\n56 Mountain",
      save,
      isStillEmpty: async () => false,
    });
    expect(save).not.toHaveBeenCalled();
    expect(report.log[0].outcome).toBe("not_empty_anymore");
  });
});

describe("reimport records fetch status", () => {
  const t8 = (id: number): EmptyDeckRow => row({ id, sourceId: `e=1&d=${id}`, source: "mtgtop8", author: null });

  it("marks ok on success and failed with the error on a failed fetch", async () => {
    const markStatus = vi.fn(async () => undefined);
    await reimportEmptyDecks({
      listEmpty: async () => [t8(1), t8(2)],
      fetchText: async (url) => (url.endsWith("d=1") ? "4 Lightning Bolt\n56 Mountain" : null),
      save: async () => ({ imported: true, cards: 2 }),
      markStatus,
    });
    expect(markStatus).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }), "ok", null);
    expect(markStatus).toHaveBeenCalledWith(expect.objectContaining({ id: 2 }), "failed", "download had no mainboard");
  });

  it("does not mark status in dry-run or for skipped rows, and survives a markStatus error", async () => {
    const markStatus = vi.fn(async () => { throw new Error("column missing"); });
    const dry = await reimportEmptyDecks(
      { listEmpty: async () => [t8(1)], fetchText: async () => null, save: async () => ({ imported: true, cards: 1 }), markStatus },
      { dryRun: true },
    );
    expect(dry.log[0].outcome).toBe("would_reimport");
    expect(markStatus).not.toHaveBeenCalled();

    const live = await reimportEmptyDecks({
      listEmpty: async () => [t8(1), row({ id: 5, sourceId: "weird", source: "other" })],
      fetchText: async () => "4 Lightning Bolt\n56 Mountain",
      save: async () => ({ imported: true, cards: 2 }),
      markStatus,
    });
    expect(markStatus).toHaveBeenCalledTimes(1);
    expect(live.reimported).toBe(1);
    expect(live.log[0].detail).toContain("status not recorded: column missing");
    expect(live.log[1].outcome).toBe("skipped");
  });
});
