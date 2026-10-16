/**
 * Aplica as migrações PostgreSQL do journal (drizzle/meta/_journal.json) com o
 * migrator oficial do drizzle, que registra cada uma em
 * drizzle.__drizzle_migrations (o mesmo ledger usado por `drizzle-kit migrate`).
 *
 * Antes de migrar: pg_advisory_lock, auditoria do ledger (hash/ordem) e baseline
 * verificado de bancos que já tinham 0003–0010 aplicadas por outro caminho
 * (ver migrationBaseline.ts e docs/migrations.md).
 *
 * Uso:
 *   npm run db:migrate                                  # baseline automático + migrate
 *   npm run db:baseline -- --through 0009_competitive_deck_import
 *                                                       # só carimba, não migra
 */
import "dotenv/config";
import * as fs from "fs";
import * as path from "path";
import { pathToFileURL } from "url";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import {
  DRIZZLE_SCHEMA,
  DRIZZLE_TABLE,
  migrationHash,
  readLedger,
  runMigrations,
  type JournalMigration,
  type MigrationDb,
} from "./migrationBaseline";

type Sql = ReturnType<typeof postgres>;

export function adapt(sql: Sql | postgres.TransactionSql): MigrationDb {
  return {
    async query(sqlText, params) {
      const rows =
        params && params.length > 0
          ? await sql.unsafe(sqlText, params as postgres.ParameterOrJSON<never>[])
          : await sql.unsafe(sqlText);
      return Array.from(rows) as Array<Record<string, unknown>>;
    },
    transaction(fn) {
      if (!("begin" in sql)) return fn(adapt(sql));
      return sql.begin(tx => fn(adapt(tx))) as Promise<never>;
    },
  };
}

export function readJournal(migrationsFolder: string): JournalMigration[] {
  const journal = JSON.parse(
    fs.readFileSync(path.join(migrationsFolder, "meta", "_journal.json"), "utf-8"),
  ) as { dialect: string; entries: Array<{ tag: string; when: number }> };
  if (journal.dialect !== "postgresql") {
    throw new Error(`_journal.json dialect=${journal.dialect}; esperado postgresql`);
  }
  return journal.entries.map((entry) => ({
    tag: entry.tag,
    when: entry.when,
    hash: migrationHash(fs.readFileSync(path.join(migrationsFolder, `${entry.tag}.sql`)).toString()),
  }));
}

function parseArgs(argv: string[]) {
  const throughIdx = argv.indexOf("--through");
  return {
    through: throughIdx >= 0 ? argv[throughIdx + 1] : undefined,
    baselineOnly: argv.includes("--baseline-only"),
  };
}

async function main() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.error("[Migration] DATABASE_URL nao configurado.");
    process.exitCode = 1;
    return;
  }
  const args = parseArgs(process.argv.slice(2));
  if (process.argv.includes("--through") && !args.through) {
    console.error("[Migration] --through exige uma tag do journal.");
    process.exitCode = 1;
    return;
  }

  const migrationsFolder = path.join(process.cwd(), "drizzle");
  try {
    const result = await migrateDatabase(dbUrl, migrationsFolder, args);
    if (result.stamped.length > 0) {
      const source = result.plan.kind === "stamp" ? result.plan.source : "";
      console.log(
        `[Migration] baseline (${source}): ${result.stamped.join(", ")}`
      );
    }
    console.log(
      result.migrated
        ? `[Migration] ok. ${result.ledgerSize} migrações no ledger; última: ${result.lastTag}`
        : `[Migration] --baseline-only: migrator não executado (plano: ${result.plan.kind}).`,
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[Migration] Erro fatal:", message);
    process.exitCode = 1;
  }
}

/**
 * Uma conexão só (max: 1): o pg_advisory_lock é por sessão, então lock,
 * baseline e a transação do migrator precisam rodar na mesma conexão.
 */
export async function migrateDatabase(
  dbUrl: string,
  migrationsFolder: string,
  opts: { through?: string; baselineOnly?: boolean } = {},
) {
  const client = postgres(dbUrl, { max: 1, idle_timeout: 5, connect_timeout: 10, onnotice: () => {} });
  try {
    const journal = readJournal(migrationsFolder);
    const result = await runMigrations(
      adapt(client),
      journal,
      () =>
        migrate(drizzle(client), {
          migrationsFolder,
          migrationsSchema: DRIZZLE_SCHEMA,
          migrationsTable: DRIZZLE_TABLE,
        }),
      opts,
    );
    const ledger = await readLedger(adapt(client));
    const last = ledger.at(-1)?.created_at;
    const lastTag = journal.find((entry) => entry.when === last)?.tag ?? "(nenhuma)";
    return { ...result, ledgerSize: ledger.length, lastTag };
  } finally {
    await client.end({ timeout: 3 }).catch(() => undefined);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main();
}
