/**
 * npm run db:check
 *
 * Sem banco: `when` do journal estritamente crescente e todo .sql presente.
 * Com DATABASE_URL: compara drizzle.__drizzle_migrations com drizzle/
 * (sha256 de cada arquivo == hash gravado; nenhuma entrada pulada) e confere o
 * enum de training_jobs.status. O migrator do drizzle não faz nada disso.
 */
import "dotenv/config";
import * as path from "path";
import { pathToFileURL } from "url";
import postgres from "postgres";
import { adapt, readJournal } from "./applyMigration";
import { auditJournal, auditLedger, readLedger } from "./migrationBaseline";

export async function checkMigrations(migrationsFolder: string, dbUrl?: string): Promise<string[]> {
  const journal = readJournal(migrationsFolder); // lança se faltar arquivo
  if (!dbUrl) return auditJournal(journal);
  const client = postgres(dbUrl, { max: 1, connect_timeout: 10, onnotice: () => {} });
  try {
    const db = adapt(client);
    const problems = auditLedger(journal, await readLedger(db));
    const [enumRow] = await client.unsafe(
      `SELECT udt_name FROM information_schema.columns WHERE table_schema='public' AND table_name='training_jobs' AND column_name='status'`,
    );
    if (enumRow && enumRow.udt_name !== "job_status") {
      problems.push(
        `training_jobs.status usa o tipo "${enumRow.udt_name}", mas schema.ts declara "job_status" (ver docs/migrations.md)`,
      );
    }
    return problems;
  } finally {
    await client.end({ timeout: 3 }).catch(() => undefined);
  }
}

async function main() {
  try {
    const problems = await checkMigrations(path.join(process.cwd(), "drizzle"), process.env.DATABASE_URL);
    if (problems.length > 0) {
      console.error(`[db:check] ${problems.length} problema(s):\n  ${problems.join("\n  ")}`);
      process.exitCode = 1;
      return;
    }
    console.log(`[db:check] ok${process.env.DATABASE_URL ? " (journal + ledger)" : " (journal; sem DATABASE_URL o ledger não foi conferido)"}`);
  } catch (err) {
    console.error("[db:check] erro:", err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main();
}
