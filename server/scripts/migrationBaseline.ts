/**
 * Baseline do ledger de migrações do drizzle (drizzle.__drizzle_migrations).
 *
 * O migrator do drizzle aplica toda entrada do journal cujo `when` seja maior
 * que o maior `created_at` já gravado no ledger. Num banco onde 0003–0010 já
 * foram aplicadas por outro caminho (psql manual ou o antigo runner que
 * gravava em public.schema_migrations), o ledger do drizzle está vazio e o
 * migrator tentaria reexecutar 0003 (CREATE TYPE ...) e falharia.
 *
 * Este módulo decide, sem adivinhar, quais entradas devem ser "carimbadas"
 * como já aplicadas antes de rodar o migrator:
 *
 *  1. Ledger do drizzle já tem linhas      -> nada a fazer.
 *  2. `--through <tag>` explícito          -> carimba até essa tag (inclusive).
 *  3. public.schema_migrations existe      -> carimba o prefixo contíguo do
 *                                             journal registrado ali.
 *  4. public.cards existe sem ledger algum -> erro: exige `--through`.
 *  5. Banco vazio                          -> nada; o migrator aplica tudo.
 *
 * 0000–0002 são snapshots MySQL históricos (drizzle/legacy-mysql/) e nunca
 * entram no journal PostgreSQL.
 */
import { createHash } from "crypto";

export type QueryResult = Array<Record<string, unknown>>;

export interface MigrationDb {
  query(sqlText: string, params?: unknown[]): Promise<QueryResult>;
  transaction<T>(fn: (tx: MigrationDb) => Promise<T>): Promise<T>;
}

export interface JournalMigration {
  tag: string;
  when: number;
  hash: string;
}

export const DRIZZLE_SCHEMA = "drizzle";
export const DRIZZLE_TABLE = "__drizzle_migrations";
export const LEGACY_LEDGER = "schema_migrations";

/** Mesmo hash que drizzle-orm/migrator grava (sha256 do arquivo inteiro). */
export function migrationHash(sqlText: string): string {
  return createHash("sha256").update(sqlText).digest("hex");
}

export type BaselinePlan =
  | { kind: "tracked" }
  | { kind: "fresh" }
  | { kind: "stamp"; source: "explicit" | "schema_migrations"; entries: JournalMigration[] };

async function exists(db: MigrationDb, regclass: string): Promise<boolean> {
  const rows = await db.query(`SELECT to_regclass($1) AS rel`, [regclass]);
  return rows[0]?.rel != null;
}

export async function planBaseline(
  db: MigrationDb,
  journal: JournalMigration[],
  opts: { through?: string } = {},
): Promise<BaselinePlan> {
  if (await exists(db, `${DRIZZLE_SCHEMA}.${DRIZZLE_TABLE}`)) {
    const rows = await db.query(`SELECT count(*)::int AS n FROM ${DRIZZLE_SCHEMA}."${DRIZZLE_TABLE}"`);
    if (Number(rows[0]?.n ?? 0) > 0) {
      if (opts.through) {
        throw new Error(
          `${DRIZZLE_SCHEMA}.${DRIZZLE_TABLE} já tem registros; --through não é aplicado sobre um ledger existente.`,
        );
      }
      return { kind: "tracked" };
    }
  }

  if (opts.through) {
    const idx = journal.findIndex((entry) => entry.tag === opts.through);
    if (idx < 0) {
      throw new Error(
        `--through ${opts.through}: tag não encontrada no journal. Tags válidas: ${journal.map((e) => e.tag).join(", ")}`,
      );
    }
    return { kind: "stamp", source: "explicit", entries: journal.slice(0, idx + 1) };
  }

  if (await exists(db, `public.${LEGACY_LEDGER}`)) {
    const rows = await db.query(`SELECT filename FROM public.${LEGACY_LEDGER}`);
    const recorded = new Set(rows.map((row) => String(row.filename).replace(/\.sql$/, "")));
    const prefix: JournalMigration[] = [];
    let gapAt: string | null = null;
    for (const entry of journal) {
      if (recorded.has(entry.tag)) {
        if (gapAt) {
          throw new Error(
            `${LEGACY_LEDGER} registra ${entry.tag} mas não ${gapAt}. ` +
              `Confira o banco e rode o baseline com --through <última tag realmente aplicada>.`,
          );
        }
        prefix.push(entry);
      } else if (!gapAt) {
        gapAt = entry.tag;
      }
    }
    if (prefix.length === 0) return { kind: "fresh" };
    return { kind: "stamp", source: "schema_migrations", entries: prefix };
  }

  if (await exists(db, "public.cards")) {
    throw new Error(
      "Banco já tem tabelas (public.cards) mas nenhum ledger de migrações. " +
        "Descubra até qual migração ele está e rode: " +
        "npm run db:baseline -- --through <tag> (ex.: 0009_competitive_deck_import). Ver docs/migrations.md.",
    );
  }

  return { kind: "fresh" };
}

export async function applyBaseline(db: MigrationDb, plan: BaselinePlan): Promise<string[]> {
  if (plan.kind !== "stamp") return [];
  await db.transaction(async (tx) => {
    // Mesmo DDL que drizzle-orm cria em pg-core/dialect.migrate().
    await tx.query(`CREATE SCHEMA IF NOT EXISTS "${DRIZZLE_SCHEMA}"`);
    await tx.query(
      `CREATE TABLE IF NOT EXISTS "${DRIZZLE_SCHEMA}"."${DRIZZLE_TABLE}" (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint)`,
    );
    for (const entry of plan.entries) {
      await tx.query(
        `INSERT INTO "${DRIZZLE_SCHEMA}"."${DRIZZLE_TABLE}" (hash, created_at) VALUES ($1, $2)`,
        [entry.hash, entry.when],
      );
    }
  });
  return plan.entries.map((entry) => entry.tag);
}
