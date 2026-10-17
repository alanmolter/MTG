import { describe, expect, it } from "vitest";
import { classifyOffsize, OFFSIZE_SQL, passesSizeRule, QUARANTINE_SQL, UNQUARANTINE_SQL } from "./offsizeDecks";

const r = (o: Partial<Parameters<typeof classifyOffsize>[0]>) =>
  classifyOffsize({ id: 1, format: "modern", mainQtd: 61, sideQtd: 15, yorionSide: false, ...o });

describe("off-size deck classification", () => {
  it("F2 rule: 61-63 and Yorion 80/81 are within the rule, never quarantined", () => {
    expect(r({ mainQtd: 61 })).toBe("within_rule");
    expect(r({ mainQtd: 63 })).toBe("within_rule");
    expect(r({ mainQtd: 80, yorionSide: true })).toBe("within_rule");
    expect(r({ mainQtd: 81, yorionSide: true })).toBe("within_rule");
    expect(r({ mainQtd: 64 })).toBe("real_offsize");
    expect(r({ mainQtd: 80 })).toBe("real_offsize");
    expect(r({ mainQtd: 77, yorionSide: true })).toBe("real_offsize");
    expect(r({ mainQtd: 150 })).toBe("real_offsize_atypical");
  });

  it("unquarantine only passes the size rule with side <= 15", () => {
    const b = { format: "modern", sideQtd: 15, yorionSide: false };
    expect(passesSizeRule({ ...b, mainQtd: 61 })).toBe(true);
    expect(passesSizeRule({ ...b, mainQtd: 80, yorionSide: true })).toBe(true);
    expect(passesSizeRule({ ...b, mainQtd: 80 })).toBe(false);
    expect(passesSizeRule({ ...b, mainQtd: 77, yorionSide: true })).toBe(false);
    expect(passesSizeRule({ ...b, mainQtd: 150 })).toBe(false);
    expect(passesSizeRule({ ...b, mainQtd: 61, sideQtd: 16 })).toBe(false);
    expect(UNQUARANTINE_SQL).not.toMatch(/\bdelete\b|archived_at\s*=/i);
    expect(UNQUARANTINE_SQL).toContain("archive_reason LIKE 'quarantine:offsize_%'");
    expect(OFFSIZE_SQL).toContain("'companion'");
  });

  it("real lists matching the source stay real (fetched source)", () => {
    expect(r({ mainQtd: 64, sourceMain: 64, sourceSide: 15 })).toBe("real_offsize");
    expect(r({ mainQtd: 80, yorionSide: true, sourceMain: 80, sourceSide: 15 })).toBe("real_offsize_yorion");
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
