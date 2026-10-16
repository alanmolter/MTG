import { describe, expect, it, vi } from "vitest";
import { CardNameResolver } from "./cardNameResolver";
import {
  backfillDeckProvenance,
  DOWNLOAD_STATUS_BATCH_SQL,
  PENDING_SQL,
  RAW_NAME_BATCH_SQL,
  RESOLVE_BATCH_SQL,
  UNRESOLVED_NAMES_SQL,
} from "./deckProvenanceBackfill";

const resolver = new CardNameResolver([{ name: "Lórien Revealed", oracleId: "abc" }]);

function fakeQuery(names: string[]) {
  return vi.fn(async (sql: string, params?: unknown[]) => {
    if (sql === PENDING_SQL) return [{ download_status: 3, raw_name: 2, resolved: 2 }];
    if (sql === DOWNLOAD_STATUS_BATCH_SQL) return [{ id: 1 }, { id: 2 }, { id: 3 }].slice(0, 3);
    if (sql === RAW_NAME_BATCH_SQL) return [{ id: 1 }];
    if (sql === UNRESOLVED_NAMES_SQL) return (params![0] === "" ? names : []).map((n) => ({ card_name: n }));
    if (sql === RESOLVE_BATCH_SQL) return [{ id: 9 }, { id: 10 }];
    throw new Error("unexpected sql");
  });
}

describe("deck provenance backfill", () => {
  it("only touches NULL rows (idempotent SQL)", () => {
    expect(DOWNLOAD_STATUS_BATCH_SQL).toContain("download_status IS NULL");
    expect(RAW_NAME_BATCH_SQL).toContain("raw_name IS NULL");
    expect(RESOLVE_BATCH_SQL).toContain("resolved IS NULL");
    for (const s of [DOWNLOAD_STATUS_BATCH_SQL, RAW_NAME_BATCH_SQL, RESOLVE_BATCH_SQL]) {
      expect(s).not.toMatch(/\bdelete\b/i);
      expect(s).toContain("$1");
    }
  });

  it("dry-run never runs an UPDATE but reports resolution", async () => {
    const q = fakeQuery(["Lorien Revealed", "Nope"]);
    const r = await backfillDeckProvenance(q, { apply: false, resolver });
    const sqls = q.mock.calls.map((c) => c[0] as string);
    expect(sqls.some((s) => /update/i.test(s))).toBe(false);
    expect(r.pending).toEqual({ downloadStatus: 3, rawName: 2, resolved: 2 });
    expect(r.names).toMatchObject({ resolved: 1, unresolved: 1, unresolvedSample: ["Nope"] });
  });

  it("apply runs batches and writes oracle_id + resolved flags", async () => {
    const q = fakeQuery(["Lorien Revealed", "Nope"]);
    const r = await backfillDeckProvenance(q, { apply: true, batchSize: 10, resolver });
    expect(r.updated).toEqual({ downloadStatus: 3, rawName: 1, resolvedLines: 2 });
    const call = q.mock.calls.find((c) => c[0] === RESOLVE_BATCH_SQL)!;
    expect(JSON.parse(call[1]![0] as string)).toEqual([
      { card_name: "Lorien Revealed", oracle_id: "abc", resolved: true },
      { card_name: "Nope", oracle_id: null, resolved: false },
    ]);
  });
});
