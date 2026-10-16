import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";
import {
  applyBaseline,
  migrationHash,
  planBaseline,
  type JournalMigration,
  type MigrationDb,
} from "./migrationBaseline";

class FakeDb implements MigrationDb {
  relations = new Set<string>();
  drizzleRows: Array<{ hash: string; created_at: number }> = [];
  legacy: string[] = [];

  async query(sqlText: string, params?: unknown[]) {
    if (sqlText.includes("to_regclass")) {
      return [{ rel: this.relations.has(String(params?.[0])) ? String(params?.[0]) : null }];
    }
    if (sqlText.includes("count(*)")) return [{ n: this.drizzleRows.length }];
    if (sqlText.includes("SELECT filename")) return this.legacy.map((filename) => ({ filename }));
    if (sqlText.startsWith("INSERT INTO")) {
      this.drizzleRows.push({ hash: String(params?.[0]), created_at: Number(params?.[1]) });
    }
    return [];
  }

  async transaction<T>(fn: (tx: MigrationDb) => Promise<T>) {
    return fn(this);
  }
}

const J: JournalMigration[] = [
  { tag: "0003_postgres_init", when: 1, hash: "h3" },
  { tag: "0009_competitive_deck_import", when: 2, hash: "h9" },
  { tag: "0010_forge_match_provenance", when: 3, hash: "h10" },
];

describe("planBaseline", () => {
  it("empty database: nothing to stamp", async () => {
    expect(await planBaseline(new FakeDb(), J)).toEqual({ kind: "fresh" });
  });

  it("drizzle ledger already populated: tracked", async () => {
    const db = new FakeDb();
    db.relations.add("drizzle.__drizzle_migrations");
    db.drizzleRows.push({ hash: "h3", created_at: 1 });
    db.relations.add("public.cards");
    expect(await planBaseline(db, J)).toEqual({ kind: "tracked" });
    await expect(planBaseline(db, J, { through: "0003_postgres_init" })).rejects.toThrow(/já tem registros/);
  });

  it("legacy schema_migrations ledger: stamps the contiguous prefix", async () => {
    const db = new FakeDb();
    db.relations.add("public.schema_migrations");
    db.relations.add("public.cards");
    db.legacy = ["0003_postgres_init.sql", "0009_competitive_deck_import.sql"];
    const plan = await planBaseline(db, J);
    expect(plan.kind === "stamp" && plan.entries.map((e) => e.tag)).toEqual([
      "0003_postgres_init",
      "0009_competitive_deck_import",
    ]);
    expect(await applyBaseline(db, plan)).toHaveLength(2);
    expect(db.drizzleRows).toEqual([
      { hash: "h3", created_at: 1 },
      { hash: "h9", created_at: 2 },
    ]);
  });

  it("legacy ledger with a gap: refuses", async () => {
    const db = new FakeDb();
    db.relations.add("public.schema_migrations");
    db.legacy = ["0003_postgres_init.sql", "0010_forge_match_provenance.sql"];
    await expect(planBaseline(db, J)).rejects.toThrow(/não 0009/);
  });

  it("tables without any ledger: requires --through", async () => {
    const db = new FakeDb();
    db.relations.add("public.cards");
    await expect(planBaseline(db, J)).rejects.toThrow(/--through/);
    const plan = await planBaseline(db, J, { through: "0009_competitive_deck_import" });
    expect(plan.kind === "stamp" && plan.entries.map((e) => e.tag)).toEqual([
      "0003_postgres_init",
      "0009_competitive_deck_import",
    ]);
    await expect(planBaseline(db, J, { through: "0002_rich_gabe_jones" })).rejects.toThrow(/não encontrada/);
  });
});

describe("drizzle folder", () => {
  const root = path.resolve(__dirname, "../../drizzle");
  const journal = JSON.parse(fs.readFileSync(path.join(root, "meta/_journal.json"), "utf-8"));

  it("journal and snapshots are postgresql", () => {
    expect(journal.dialect).toBe("postgresql");
    const snapshots = fs.readdirSync(path.join(root, "meta")).filter((f) => f.endsWith("_snapshot.json"));
    expect(snapshots.length).toBeGreaterThan(0);
    for (const file of snapshots) {
      const snap = JSON.parse(fs.readFileSync(path.join(root, "meta", file), "utf-8"));
      expect(snap.dialect, file).toBe("postgresql");
    }
  });

  it("every journal entry has a sql file and strictly increasing `when`", () => {
    let prev = 0;
    for (const entry of journal.entries) {
      expect(fs.existsSync(path.join(root, `${entry.tag}.sql`)), entry.tag).toBe(true);
      expect(entry.when).toBeGreaterThan(prev);
      prev = entry.when;
    }
  });

  it("hash matches drizzle-orm migrator", () => {
    expect(migrationHash("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});
