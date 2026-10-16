/**
 * Integração real (PostgreSQL + pgvector). Só roda com MIGRATION_IT_DATABASE_URL
 * apontando para um superusuário (cria/derruba bancos it_*). No CI usa a imagem
 * pgvector/pgvector (ver .github/workflows/migrations.yml). Local:
 *   MIGRATION_IT_DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres npx vitest run server/scripts/migrations.integration.test.ts
 */
import * as fs from "fs";
import * as path from "path";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrateDatabase, readJournal } from "./applyMigration";
import { checkMigrations } from "./checkMigrations";

const ADMIN_URL = process.env.MIGRATION_IT_DATABASE_URL;
const folder = path.resolve(__dirname, "../../drizzle");
const journal = readJournal(folder);
const tags = journal.map((entry) => entry.tag);
/**
 * Só as migrações que o runner de af0ece20 conhecia (00NN_). As novas (prefixo
 * timestamp) nunca aparecem em schema_migrations nem têm TAG_CHECKS: o migrator
 * as aplica depois do baseline. Os fixtures do estado legado usam só estas.
 */
const legacy = tags.filter((tag) => /^00\d\d_/.test(tag));

function dbUrl(name: string): string {
  const url = new URL(ADMIN_URL!);
  url.pathname = `/${name}`;
  return url.toString();
}

async function freshDb(name: string): Promise<string> {
  const admin = postgres(ADMIN_URL!, { max: 1, onnotice: () => {} });
  await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  await admin.unsafe(`CREATE DATABASE ${name}`);
  await admin.end();
  return dbUrl(name);
}

/** Reproduz o runner de af0ece20: aplica arquivos inteiros e grava schema_migrations. */
async function af0ece20State(url: string, applied: string[], recorded: string[]) {
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  for (const tag of applied) await sql.unsafe(fs.readFileSync(path.join(folder, `${tag}.sql`), "utf-8"));
  await sql.unsafe(`CREATE TABLE schema_migrations (filename text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
  for (const tag of recorded) await sql.unsafe(`INSERT INTO schema_migrations (filename) VALUES ($1)`, [`${tag}.sql`]);
  await sql.end();
}

async function scalar(url: string, query: string): Promise<unknown> {
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    const rows = await sql.unsafe(query);
    return rows[0] ? Object.values(rows[0])[0] : undefined;
  } finally {
    await sql.end();
  }
}

const ledgerCount = (url: string) =>
  scalar(url, `SELECT count(*)::int FROM drizzle.__drizzle_migrations`);
const ledgerExists = (url: string) =>
  scalar(url, `SELECT to_regclass('drizzle.__drizzle_migrations') IS NOT NULL`);

describe.skipIf(!ADMIN_URL)("migrations against real PostgreSQL + pgvector", () => {
  beforeAll(async () => {
    const version = await scalar(ADMIN_URL!, `SELECT default_version FROM pg_available_extensions WHERE name = 'vector'`);
    expect(version, "pgvector precisa estar instalado no servidor").toBeTruthy();
    const [major, minor] = String(version).split(".").map(Number);
    expect(major > 0 || minor >= 5, `pgvector ${version} < 0.5 (sem HNSW)`).toBe(true);
  });

  afterAll(async () => {
    const admin = postgres(ADMIN_URL!, { max: 1, onnotice: () => {} });
    const rows = await admin.unsafe(`SELECT datname FROM pg_database WHERE datname LIKE 'it_mig_%'`);
    for (const row of rows) await admin.unsafe(`DROP DATABASE IF EXISTS ${row.datname} WITH (FORCE)`);
    await admin.end();
  });

  it("empty database: applies everything, re-run is a no-op, db:check is clean", async () => {
    const url = await freshDb("it_mig_empty");
    const first = await migrateDatabase(url, folder);
    expect(first.plan.kind).toBe("fresh");
    expect(first.ledgerSize).toBe(tags.length);
    expect(await scalar(url, `SELECT extversion FROM pg_extension WHERE extname='vector'`)).toBeTruthy();
    expect(await scalar(url, `SELECT to_regclass('public.idx_card_oracle_embed_hnsw') IS NOT NULL`)).toBe(true);
    const second = await migrateDatabase(url, folder);
    expect(second.plan.kind).toBe("tracked");
    expect(await ledgerCount(url)).toBe(tags.length);
    expect(await checkMigrations(folder, url)).toEqual([]);
  });

  it("af0ece20 state (0003–0010 applied + schema_migrations): baseline then migrate", async () => {
    const url = await freshDb("it_mig_legacy");
    await af0ece20State(url, legacy, legacy);
    const result = await migrateDatabase(url, folder);
    expect(result.plan.kind).toBe("stamp");
    expect(result.stamped).toEqual(legacy);
    expect(await ledgerCount(url)).toBe(tags.length);
    expect(await checkMigrations(folder, url)).toEqual([]);
  });

  it("af0ece20 state with 0010 pending: stamps 0003–0009, migrator applies 0010", async () => {
    const url = await freshDb("it_mig_partial");
    const upTo9 = legacy.slice(0, legacy.indexOf("0009_competitive_deck_import") + 1);
    await af0ece20State(url, upTo9, upTo9);
    const result = await migrateDatabase(url, folder);
    expect(result.stamped).toEqual(upTo9);
    expect(result.ledgerSize).toBe(tags.length);
    expect(await scalar(url, `SELECT count(*)::int FROM information_schema.columns WHERE table_name='forge_matches' AND column_name='seed'`)).toBe(1);
  });

  it("fake legacy record (af0ece20 stamped what never ran): aborts and writes nothing", async () => {
    const url = await freshDb("it_mig_fake");
    await af0ece20State(url, legacy.slice(0, 2), legacy.slice(0, 7));
    await expect(migrateDatabase(url, folder)).rejects.toThrow(/0005_endgame_pgvector: falta/);
    expect(await ledgerExists(url)).toBe(false);
    // caminho de recuperação documentado: --through na última tag verdadeira
    const fixed = await migrateDatabase(url, folder, { through: legacy[1] });
    expect(fixed.stamped).toEqual(legacy.slice(0, 2));
    expect(fixed.ledgerSize).toBe(tags.length);
  });

  it("concurrent runs (training:prepare + import:competitive) do not double-stamp or fail", async () => {
    const url = await freshDb("it_mig_concurrent");
    await af0ece20State(url, legacy, legacy);
    const results = await Promise.all([1, 2, 3].map(() => migrateDatabase(url, folder)));
    expect(results.map((r) => r.plan.kind).sort()).toEqual(["stamp", "tracked", "tracked"]);
    expect(await ledgerCount(url)).toBe(tags.length);

    const empty = await freshDb("it_mig_concurrent_empty");
    await Promise.all([1, 2].map(() => migrateDatabase(empty, folder)));
    expect(await ledgerCount(empty)).toBe(tags.length);
  });

  it("db:check flags an edited migration and migrate refuses to run", async () => {
    const url = await freshDb("it_mig_edited");
    await migrateDatabase(url, folder);
    const sql = postgres(url, { max: 1, onnotice: () => {} });
    await sql.unsafe(`UPDATE drizzle.__drizzle_migrations SET hash = 'tampered' WHERE created_at = $1`, [journal[2].when]);
    await sql.end();
    expect((await checkMigrations(folder, url)).join()).toMatch(/0005_endgame_pgvector: hash do arquivo mudou/);
    await expect(migrateDatabase(url, folder)).rejects.toThrow(/Ledger inconsistente/);
  });
});
