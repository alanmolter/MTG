/**
 * Apply pending PostgreSQL files in drizzle/ and record each one.
 *
 * 0000–0002 are historical MySQL snapshots and are skipped.
 * A database that already has public.cards (created before schema_migrations
 * existed) gets 0003–0009 stamped, then 0010+ runs for real.
 * One transaction per file. An unexpected error fails the process.
 *
 * This is the supported path. `npm run db:push` still asks drizzle-kit to
 * generate from the old MySQL snapshots, which is the wrong tool here.
 */
import "dotenv/config";
import * as fs from "fs";
import * as path from "path";
import postgres from "postgres";
import {
  applyPendingMigrations,
  isPostgresMigration,
  type MigrationDb,
} from "./migrationRunner";

function adapt(sql: {
  unsafe: (
    query: string,
    params?: unknown[]
  ) => Promise<Array<Record<string, unknown>>>;
  begin?: <T>(fn: (tx: unknown) => Promise<T>) => Promise<T>;
}): MigrationDb {
  return {
    async query(sqlText, params) {
      const rows =
        params && params.length > 0
          ? await sql.unsafe(sqlText, params)
          : await sql.unsafe(sqlText);
      return Array.from(rows);
    },
    transaction(fn) {
      if (typeof sql.begin !== "function") return fn(adapt(sql));
      return sql.begin(tx => fn(adapt(tx as typeof sql)));
    },
  };
}

async function applyMigration() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.error("[Migration] DATABASE_URL nao configurado.");
    process.exitCode = 1;
    return;
  }

  const client = postgres(dbUrl, {
    max: 1,
    idle_timeout: 5,
    connect_timeout: 10,
    onnotice: () => {},
  });

  try {
    const drizzleDir = path.join(process.cwd(), "drizzle");
    const files = fs
      .readdirSync(drizzleDir)
      .filter(filename => isPostgresMigration(filename))
      .sort()
      .map(filename => ({
        filename,
        sql: fs.readFileSync(path.join(drizzleDir, filename), "utf-8"),
      }));

    if (files.length === 0) {
      console.error(
        "[Migration] Nenhum arquivo PostgreSQL 00NN_*.sql encontrado."
      );
      process.exitCode = 1;
      return;
    }

    const result = await applyPendingMigrations(
      adapt(client as unknown as Parameters<typeof adapt>[0]),
      files
    );
    console.log(
      `[Migration] applied=${result.applied.join(",") || "(none)"} ` +
        `stamped=${result.stamped.length} skipped=${result.skipped.length}`
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[Migration] Erro fatal:", message);
    process.exitCode = 1;
  } finally {
    try {
      await client.end({ timeout: 3 });
    } catch {
      /* pool already closed */
    }
  }
}

applyMigration()
  .catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[Migration] Erro fatal:", message);
    process.exitCode = 1;
  })
  .finally(() => process.exit(process.exitCode ?? 0));
