import { describe, expect, it } from "vitest";
import { ARCHIVE_CANDIDATES_SQL, planArchive, type ArchiveCandidate } from "./archiveDeadDecks";

const c = (id: number, reason: ArchiveCandidate["reason"]): ArchiveCandidate => ({
  id,
  source: reason === "placeholder" ? "moxfield" : "mtggoldfish",
  sourceId: reason === "placeholder" ? `fallback-${id}` : `goldfish-${id}`,
  format: "modern",
  isSynthetic: false,
  reason,
});

describe("archive dead decks", () => {
  it("selects only empty goldfish and moxfield fallback rows", () => {
    expect(ARCHIVE_CANDIDATES_SQL).toContain("c.deck_id IS NULL");
    expect(ARCHIVE_CANDIDATES_SQL).toContain("fallback%");
  });

  it("never deletes", () => {
    const plan = planArchive([c(1, "placeholder"), c(2, "source_dropped")], ["download_status", "archived_at", "archive_reason"]);
    for (const s of plan.statements) expect(s.sql).not.toMatch(/\bdelete\b|\btruncate\b|\bdrop\b/i);
    expect(ARCHIVE_CANDIDATES_SQL).not.toMatch(/\bdelete\b/i);
  });

  it("without status columns only marks placeholders synthetic and reports the rest as pending", () => {
    const plan = planArchive([c(1, "placeholder"), c(2, "source_dropped"), c(3, "source_dropped")], []);
    expect(plan.statusColumnsPresent).toBe(false);
    expect(plan.statements).toHaveLength(1);
    expect(plan.statements[0].params[0]).toEqual([1]);
    expect(plan.pending).toHaveLength(2);
    expect(plan.byReason).toEqual({ placeholder: 1, source_dropped: 2 });
  });

  it("with status columns archives idempotently (archived_at IS NULL)", () => {
    const plan = planArchive([c(1, "placeholder"), c(2, "source_dropped")], ["download_status", "archived_at", "archive_reason"]);
    expect(plan.statements).toHaveLength(3);
    expect(plan.statements.slice(1).every((s) => s.sql.includes("archived_at IS NULL"))).toBe(true);
    expect(plan.statements[1].sql).toContain("download_status = $2::deck_download_status");
    expect(plan.statements.slice(1).map((s) => s.params[1])).toEqual(["source_dropped", "placeholder"]);
    expect(plan.pending).toHaveLength(0);
  });
});
