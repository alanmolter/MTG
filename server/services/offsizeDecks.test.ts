import { describe, expect, it } from "vitest";
import { classifyOffsize, OFFSIZE_SQL, QUARANTINE_SQL } from "./offsizeDecks";

const r = (o: Partial<Parameters<typeof classifyOffsize>[0]>) =>
  classifyOffsize({ id: 1, format: "modern", mainQtd: 61, sideQtd: 15, yorionSide: false, ...o });

describe("off-size deck classification", () => {
  it("real lists matching the source stay real (the 46 seen on the real DB)", () => {
    expect(r({ mainQtd: 61, sourceMain: 61, sourceSide: 15 })).toBe("real_offsize");
    expect(r({ mainQtd: 80, yorionSide: true, sourceMain: 80, sourceSide: 15 })).toBe("real_offsize_yorion");
    expect(r({ mainQtd: 81, yorionSide: true, format: "legacy" })).toBe("real_offsize_yorion");
    expect(r({ mainQtd: 77, yorionSide: true })).toBe("real_offsize");
    expect(r({ mainQtd: 150, sourceMain: 150, sourceSide: 15 })).toBe("real_offsize_atypical");
  });

  it("a source that now parses to 60 is fixable by re-parse", () => {
    expect(r({ mainQtd: 75, sideQtd: 0, sourceMain: 60, sourceSide: 15 })).toBe("fixable_reparse");
  });

  it("detects a merged sideboard and a source mismatch", () => {
    expect(r({ mainQtd: 75, sideQtd: 0 })).toBe("sideboard_merged");
    expect(r({ mainQtd: 61, sourceMain: 64, sourceSide: 15 })).toBe("source_mismatch");
  });

  it("uses 100 for commander", () => {
    expect(r({ format: "commander", mainQtd: 99, sideQtd: 0, sourceMain: 100, sourceSide: 0 })).toBe("fixable_reparse");
  });

  it("SQL is read/update only, never archives or deletes, and is idempotent", () => {
    expect(OFFSIZE_SQL).toContain("archived_at IS NULL");
    expect(QUARANTINE_SQL).not.toMatch(/\bdelete\b|archived_at\s*=/i);
    expect(QUARANTINE_SQL).toContain("IS DISTINCT FROM $2");
    expect(QUARANTINE_SQL).toContain("archive_reason LIKE 'quarantine:%'");
  });
});
