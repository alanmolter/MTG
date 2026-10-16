/**
 * Aplica as migrações PostgreSQL do journal (drizzle/meta/_journal.json) com o
 * migrator oficial do drizzle, que registra cada uma em
 * drizzle.__drizzle_migrations (o mesmo ledger usado por `drizzle-kit migrate`).
 *
 * Antes de migrar, faz o baseline de bancos que já tinham 0003–0010 aplicadas
 * por outro caminho (ver migrationBaseline.ts e docs/migrations.md).
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
  applyBaseline,
  DRIZZLE_SCHEMA,
  DRIZZLE_TABLE,
  migrationHash,
  planBaseline,
  type JournalMigration,
  type MigrationDb,
} from "./migrationBaseline";

type Sql = ReturnType<typeof postgres>;

function adapt(sql: Sql | postgres.TransactionSql): MigrationDb {
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
      return sql.begin((tx) => fn(adapt(tx))) as Promise<never>;
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
  const client = postgres(dbUrl, { max: 1, idle_timeout: 5, connect_timeout: 10, onnotice: () => {} });

  try {
    const journal = readJournal(migrationsFolder);
    const db = adapt(client);
    const plan = await planBaseline(db, journal, { through: args.through });
    const stamped = await applyBaseline(db, plan);
    if (stamped.length > 0) {
      console.log(`[Migration] baseline (${plan.kind === "stamp" ? plan.source : ""}): ${stamped.join(", ")}`);
    }
    if (args.baselineOnly) {
      console.log(`[Migration] --baseline-only: migrator não executado (plano: ${plan.kind}).`);
      return;
    }
    await migrate(drizzle(client), {
      migrationsFolder,
      migrationsSchema: DRIZZLE_SCHEMA,
      migrationsTable: DRIZZLE_TABLE,
    });
    const [last] = await client.unsafe(
      `SELECT count(*)::int AS n, max(created_at) AS last FROM "${DRIZZLE_SCHEMA}"."${DRIZZLE_TABLE}"`,
    );
    const lastTag = journal.find((entry) => String(entry.when) === String(last?.last))?.tag ?? "(nenhuma)";
    console.log(`[Migration] ok. ${last?.n ?? 0} migrações no ledger; última: ${lastTag}`);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[Migration] Erro fatal:", message);
    process.exitCode = 1;
  } finally {
    await client.end({ timeout: 3 }).catch(() => undefined);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main();
}
