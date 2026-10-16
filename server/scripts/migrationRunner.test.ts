import { describe, expect, it } from "vitest";
import {
  applyPendingMigrations,
  isPostgresMigration,
  type MigrationDb,
  type MigrationFile,
} from "./migrationRunner";

class FakeDb implements MigrationDb {
  executed: string[] = [];
  recorded: string[] = [];
  cards: string | null = null;
  failSql: string | null = null;

  async query(sqlText: string, params?: unknown[]) {
    if (this.failSql && sqlText.includes(this.failSql)) {
      throw new Error(`boom ${this.failSql}`);
    }
    if (sqlText.includes("SELECT filename")) {
      return this.recorded.map((filename) => ({ filename }));
    }
    if (sqlText.includes("to_regclass")) {
      return [{ cards: this.cards }];
    }
    if (params && params.length > 0 && sqlText.includes("INSERT INTO schema_migrations")) {
      this.recorded.push(String(params[0]));
      return [];
    }
    if (!sqlText.includes("CREATE TABLE IF NOT EXISTS schema_migrations")) {
      this.executed.push(sqlText);
    }
    return [];
  }

  async transaction<T>(fn: (tx: MigrationDb) => Promise<T>): Promise<T> {
    return fn(this);
  }
}

const FILES: MigrationFile[] = [
  { filename: "0000_cute_captain_flint.sql", sql: "CREATE TABLE mysql_only (id int);" },
  { filename: "0003_postgres_init.sql", sql: "CREATE TYPE role AS ENUM ('user');" },
  { filename: "0009_competitive_deck_import.sql", sql: "ALTER TABLE competitive_decks ADD COLUMN x int;" },
  { filename: "0010_forge_match_provenance.sql", sql: "ALTER TABLE forge_matches ADD COLUMN seed bigint;" },
];

describe("applyPendingMigrations", () => {
  it("ignores the historical mysql files", () => {
    expect(isPostgresMigration("0000_cute_captain_flint.sql")).toBe(false);
    expect(isPostgresMigration("0002_rich_gabe_jones.sql")).toBe(false);
    expect(isPostgresMigration("0003_postgres_init.sql")).toBe(true);
    expect(isPostgresMigration("0010_forge_match_provenance.sql")).toBe(true);
  });

  it("applies every postgres file on an empty database", async () => {
    const db = new FakeDb();
    const result = await applyPendingMigrations(db, FILES);
    expect(result.stamped).toEqual([]);
    expect(result.applied).toEqual([
      "0003_postgres_init.sql",
      "0009_competitive_deck_import.sql",
      "0010_forge_match_provenance.sql",
    ]);
    expect(db.executed.some((sql) => sql.includes("mysql_only"))).toBe(false);
    expect(db.recorded).toEqual(result.applied);
  });

  it("stamps 0003-0009 when cards already exist and applies 0010", async () => {
    const db = new FakeDb();
    db.cards = "cards";
    const result = await applyPendingMigrations(db, FILES);
    expect(result.stamped).toEqual([
      "0003_postgres_init.sql",
      "0009_competitive_deck_import.sql",
    ]);
    expect(result.applied).toEqual(["0010_forge_match_provenance.sql"]);
    expect(db.executed.some((sql) => sql.includes("CREATE TYPE"))).toBe(false);
    expect(db.executed.some((sql) => sql.includes("forge_matches"))).toBe(true);
  });

  it("fails the file and does not record it when a statement throws", async () => {
    const db = new FakeDb();
    db.failSql = "forge_matches";
    await expect(applyPendingMigrations(db, FILES)).rejects.toThrow(/0010_forge_match_provenance/);
    expect(db.recorded).not.toContain("0010_forge_match_provenance.sql");
    expect(db.recorded).toContain("0003_postgres_init.sql");
  });
});
