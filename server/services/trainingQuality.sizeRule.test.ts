import { describe, expect, it } from "vitest";
import { deckSizeClass, validateTrainingDeck } from "./trainingQuality";

function deck(main: number, opts: { yorion?: "sideboard" | "companion"; side?: number } = {}) {
  const cards = [
    { cardName: "Plains", quantity: main - 36, section: "mainboard" },
    ...Array.from({ length: 9 }, (_, i) => ({ cardName: `Spell ${i + 1}`, quantity: 4, section: "mainboard" })),
  ];
  const side = opts.side ?? 15;
  if (opts.yorion) cards.push({ cardName: "Yorion, Sky Nomad", quantity: 1, section: opts.yorion });
  const rest = side - (opts.yorion === "sideboard" ? 1 : 0);
  if (rest > 0) cards.push({ cardName: "Side Card", quantity: rest, section: "sideboard" });
  return validateTrainingDeck({ format: "modern", cards });
}

describe("F2 mainboard size rule", () => {
  it.each([
    [60, {}, true, "standard60"],
    [61, {}, true, "offsize_61_63"],
    [63, {}, true, "offsize_61_63"],
    [64, {}, false, "atypical"],
    [80, { yorion: "sideboard" }, true, "yorion_80_81"],
    [80, { yorion: "companion" }, true, "yorion_80_81"],
    [80, {}, false, "atypical"],
    [81, { yorion: "sideboard" }, true, "yorion_80_81"],
    [81, {}, false, "atypical"],
    [77, { yorion: "sideboard" }, false, "atypical"],
    [77, {}, false, "atypical"],
    [150, {}, false, "atypical"],
    [150, { yorion: "sideboard" }, false, "atypical"],
  ] as const)("main %i %o -> eligible=%s class=%s", (main, opts, eligible, cls) => {
    const r = deck(main, opts as { yorion?: "sideboard" | "companion" });
    expect(r.eligible).toBe(eligible);
    expect(r.sizeClass).toBe(cls);
    if (!eligible) expect(r.reasons).toContain(`mainboard_size_${main}_expected_60`);
  });

  it("keeps the sideboard at most 15", () => {
    expect(deck(60, { side: 15 }).eligible).toBe(true);
    const r = deck(60, { side: 16 });
    expect(r.eligible).toBe(false);
    expect(r.reasons).toContain("sideboard_size_16_exceeds_15");
  });

  it("commander keeps the exact 100 rule", () => {
    expect(deckSizeClass("commander", 100, false)).toBe("standard60");
    expect(deckSizeClass("commander", 101, true)).toBe("atypical");
  });
});
