import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";
import {
  applyBaseline,
  auditJournal,
  auditLedger,
  migrationHash,
  MIGRATION_LOCK_KEY,
  planBaseline,
  runMigrations,
  TAG_CHECKS,
  type JournalMigration,
  type MigrationDb,
  type ObjectCheck,
} from "./migrationBaseline";

/** Catálogo em memória: responde às consultas que migrationBaseline faz. */
class FakeDb implements MigrationDb {
  relations = new Set<string>();
  columns = new Set<string>();
  types = new Set<string>();
  extensions = new Set<string>();
  defaults = new Map<string, string>();
  drizzleRows: Array<{ hash: string; created_at: number }> = [];
  legacy: string[] = [];
  log: string[] = [];

  /** Cria todos os objetos esperados pelas tags informadas. */
  materialize(tags: string[]) {
    for (const tag of tags) for (const check of TAG_CHECKS[tag]) this.add(check);
  }

  add(check: ObjectCheck) {
    if (check.kind === "table" || check.kind === "index") this.relations.add(`public.${check.name}`);
    if (check.kind === "column") this.columns.add(`${check.table}.${check.column}`);
    if (check.kind === "type") this.types.add(check.name);
    if (check.kind === "extension") this.extensions.add(check.name);
    if (check.kind === "default") this.defaults.set(`${check.table}.${check.column}`, `'${check.contains}'::character varying`);
  }

  async query(sqlText: string, params: unknown[] = []) {
    if (sqlText.includes("pg_advisory")) {
      this.log.push(sqlText.includes("unlock") ? "unlock" : "lock");
      return [];
    }
    if (sqlText.includes("to_regclass")) {
      const name = String(params[0]);
      const present = this.relations.has(name) || (name === "drizzle.__drizzle_migrations" && this.drizzleRows.length > 0);
      return [{ rel: present ? name : null }];
    }
    if (sqlText.includes("SELECT hash, created_at")) return [...this.drizzleRows];
    if (sqlText.includes("column_default")) {
      const value = this.defaults.get(`${params[0]}.${params[1]}`);
      return value ? [{ column_default: value }] : [];
    }
    if (sqlText.includes("information_schema.columns")) {
      return this.columns.has(`${params[0]}.${params[1]}`) ? [{ ok: 1 }] : [];
    }
    if (sqlText.includes("pg_type")) return this.types.has(String(params[0])) ? [{ ok: 1 }] : [];
    if (sqlText.includes("pg_extension")) return this.extensions.has(String(params[0])) ? [{ ok: 1 }] : [];
    if (sqlText.includes("SELECT filename")) return this.legacy.map((filename) => ({ filename }));
    if (sqlText.startsWith("INSERT INTO")) {
      this.drizzleRows.push({ hash: String(params[0]), created_at: Number(params[1]) });
    }
    return [];
  }

  async transaction<T>(fn: (tx: MigrationDb) => Promise<T>) {
    return fn(this);
  }
}

const TAGS = Object.keys(TAG_CHECKS);
const J: JournalMigration[] = TAGS.map((tag, idx) => ({ tag, when: 100 + idx, hash: `h${idx}` }));
const upTo = (tag: string) => TAGS.slice(0, TAGS.indexOf(tag) + 1);

describe("planBaseline", () => {
  it("empty database: nothing to stamp", async () => {
    expect(await planBaseline(new FakeDb(), J)).toEqual({ kind: "fresh" });
  });

  it("drizzle ledger already populated: tracked, and --through is refused", async () => {
    const db = new FakeDb();
    db.drizzleRows.push({ hash: "h0", created_at: 100 });
    expect(await planBaseline(db, J)).toEqual({ kind: "tracked" });
    await expect(planBaseline(db, J, { through: TAGS[0] })).rejects.toThrow(/já tem registros/);
  });

  it("legacy ledger matching the catalog: stamps the contiguous prefix", async () => {
    const db = new FakeDb();
    db.relations.add("public.schema_migrations");
    db.materialize(upTo("0010_forge_match_provenance"));
    db.legacy = TAGS.map((tag) => `${tag}.sql`);
    const plan = await planBaseline(db, J);
    expect(plan.kind === "stamp" && plan.entries.length).toBe(TAGS.length);
    await applyBaseline(db, plan);
    expect(db.drizzleRows.map((row) => row.created_at)).toEqual(J.map((entry) => entry.when));
  });

  it("fake legacy record (af0ece20 stamped 0003–0009 because cards existed): aborts without writing", async () => {
    const db = new FakeDb();
    db.relations.add("public.schema_migrations");
    db.materialize(upTo("0004_mtg_ai_updates")); // só 0003–0004 de verdade
    db.legacy = upTo("0009_competitive_deck_import").map((tag) => `${tag}.sql`);
    await expect(planBaseline(db, J)).rejects.toThrow(/0005_endgame_pgvector: falta .*card_oracle_embeddings/s);
    expect(db.drizzleRows).toEqual([]);
  });

  it("0005 without the vector extension is rejected even if the tables exist", async () => {
    const db = new FakeDb();
    db.materialize(upTo("0005_endgame_pgvector"));
    db.extensions.delete("vector");
    await expect(planBaseline(db, J, { through: "0005_endgame_pgvector" })).rejects.toThrow(/extensão vector/);
  });

  it("0010 without forge_matches.seed is rejected", async () => {
    const db = new FakeDb();
    db.materialize(TAGS);
    db.columns.delete("forge_matches.seed");
    await expect(planBaseline(db, J, { through: "0010_forge_match_provenance" })).rejects.toThrow(/forge_matches\.seed/);
    // um passo abaixo continua válido
    const plan = await planBaseline(db, J, { through: "0009_competitive_deck_import" });
    expect(plan.kind).toBe("stamp");
  });

  it("legacy ledger with a gap: refuses", async () => {
    const db = new FakeDb();
    db.relations.add("public.schema_migrations");
    db.legacy = [`${TAGS[0]}.sql`, `${TAGS[2]}.sql`];
    await expect(planBaseline(db, J)).rejects.toThrow(/não 0004/);
  });

  it("tables without any ledger: requires --through and suggests the verified tag", async () => {
    const db = new FakeDb();
    db.materialize(upTo("0007_competitive_deck_cards_repair"));
    await expect(planBaseline(db, J)).rejects.toThrow(/batem até 0007_competitive_deck_cards_repair/);
    await expect(planBaseline(db, J, { through: "0002_rich_gabe_jones" })).rejects.toThrow(/não encontrada/);
  });

  it("every check kind is exercised by TAG_CHECKS for 0003–0010", () => {
    expect(TAGS).toEqual([
      "0003_postgres_init", "0004_mtg_ai_updates", "0005_endgame_pgvector", "0006_archetype_weights",
      "0007_competitive_deck_cards_repair", "0008_training_quality_gates", "0009_competitive_deck_import",
      "0010_forge_match_provenance",
    ]);
    const kinds = new Set(Object.values(TAG_CHECKS).flat().map((check) => check.kind));
    expect([...kinds].sort()).toEqual(["column", "default", "extension", "index", "table", "type"]);
  });
});

describe("auditLedger / auditJournal", () => {
  it("clean ledger passes", () => {
    expect(auditLedger(J, J.slice(0, 3).map((e) => ({ hash: e.hash, created_at: e.when })))).toEqual([]);
  });

  it("detects a .sql edited after being applied", () => {
    const problems = auditLedger(J, [{ hash: "other", created_at: J[0].when }]);
    expect(problems.join()).toMatch(/0003_postgres_init: hash do arquivo mudou/);
  });

  it("detects an entry that the migrator would silently skip", () => {
    const problems = auditLedger(J, [J[0], J[2]].map((e) => ({ hash: e.hash, created_at: e.when })));
    expect(problems.join()).toMatch(/0004_mtg_ai_updates: .*o migrator a pularia/);
  });

  it("detects out-of-order `when` and unknown ledger rows", () => {
    const bad = [J[0], { ...J[1], when: 50 }];
    expect(auditJournal(bad).join()).toMatch(/fora de ordem/);
    expect(auditLedger(J, [{ hash: "x", created_at: 1 }]).join()).toMatch(/sem entrada/);
  });
});

describe("runMigrations", () => {
  it("holds the advisory lock around plan + migrate and releases on error", async () => {
    const db = new FakeDb();
    const order: string[] = [];
    await runMigrations(db, J, async () => { order.push(`migrate:${db.log.join(",")}`); });
    expect(order).toEqual(["migrate:lock"]);
    expect(db.log).toEqual(["lock", "unlock"]);

    const failing = new FakeDb();
    await expect(runMigrations(failing, J, async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(failing.log).toEqual(["lock", "unlock"]);
  });

  it("serializes concurrent runs: the second one sees the stamped ledger and does not double-stamp", async () => {
    // Lock simulado: a segunda chamada espera a primeira liberar, como o pg_advisory_lock.
    const db = new FakeDb();
    db.relations.add("public.schema_migrations");
    db.materialize(TAGS);
    db.legacy = TAGS.map((tag) => `${tag}.sql`);
    let chain: Promise<void> = Promise.resolve();
    const releases: Array<() => void> = [];
    const locked: MigrationDb = {
      transaction: (fn) => db.transaction(fn),
      async query(sqlText, params) {
        if (sqlText.includes("pg_advisory_lock")) {
          const previous = chain;
          chain = new Promise((resolve) => releases.push(resolve));
          await previous;
          return [];
        }
        if (sqlText.includes("pg_advisory_unlock")) {
          releases.shift()?.();
          return [];
        }
        return db.query(sqlText, params);
      },
    };
    const [a, b] = await Promise.all([
      runMigrations(locked, J, async () => {}),
      runMigrations(locked, J, async () => {}),
    ]);
    expect([a.plan.kind, b.plan.kind].sort()).toEqual(["stamp", "tracked"]);
    expect(db.drizzleRows).toHaveLength(TAGS.length);
  });

  it("refuses to migrate when the ledger is inconsistent", async () => {
    const db = new FakeDb();
    db.drizzleRows.push({ hash: "edited", created_at: J[0].when });
    let migrated = false;
    await expect(runMigrations(db, J, async () => { migrated = true; })).rejects.toThrow(/hash do arquivo mudou/);
    expect(migrated).toBe(false);
    expect(db.log).toEqual(["lock", "unlock"]);
  });

  it("uses an int4-safe lock key", () => {
    expect(Number.isSafeInteger(MIGRATION_LOCK_KEY)).toBe(true);
    expect(MIGRATION_LOCK_KEY).toBeLessThan(2 ** 31);
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
      expect(JSON.parse(fs.readFileSync(path.join(root, "meta", file), "utf-8")).dialect, file).toBe("postgresql");
    }
  });

  it("every journal entry has a sql file, increasing `when`, and a baseline check", () => {
    expect(auditJournal(journal.entries)).toEqual([]);
    for (const entry of journal.entries) {
      expect(fs.existsSync(path.join(root, `${entry.tag}.sql`)), entry.tag).toBe(true);
      if (/^00\d\d_/.test(entry.tag)) expect(TAG_CHECKS[entry.tag], entry.tag).toBeDefined();
    }
  });

  it("each breakpoint chunk holds exactly one top-level statement (DO $$ kept whole)", () => {
    for (const entry of journal.entries) {
      const chunks = fs.readFileSync(path.join(root, `${entry.tag}.sql`), "utf-8").split("--> statement-breakpoint");
      for (const chunk of chunks) {
        const code = chunk.replace(/\$\$[\s\S]*?\$\$/g, "$$$$").replace(/--.*$/gm, "");
        const statements = code.split(";").filter((part) => part.trim().length > 0);
        expect(statements.length, `${entry.tag}: ${chunk.slice(0, 80)}`).toBe(1);
      }
    }
  });

  it("hash matches drizzle-orm migrator", () => {
    expect(migrationHash("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});
