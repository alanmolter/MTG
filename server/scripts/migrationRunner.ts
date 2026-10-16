/**
 * Apply drizzle/*.sql files that are PostgreSQL, one transaction per file,
 * and record each filename in schema_migrations.
 *
 * 0000–0002 are historical MySQL snapshots. They are not applied here.
 * Databases that already have `public.cards` (created before this ledger
 * existed) get 0003–0009 stamped as applied so CREATE TYPE is not replayed,
 * then 0010 and anything newer actually run.
 */

export type MigrationFile = { filename: string; sql: string };

export type QueryResult = Array<Record<string, unknown>>;

export interface MigrationDb {
  query(sqlText: string, params?: unknown[]): Promise<QueryResult>;
  transaction<T>(fn: (tx: MigrationDb) => Promise<T>): Promise<T>;
}

export const MIGRATIONS_TABLE = "schema_migrations";

/** Last filename that older installs already applied without a ledger. */
export const BASELINE_THROUGH = "0009_competitive_deck_import.sql";

const MYSQL_PREFIXES = ["0000_", "0001_", "0002_"];

export function isPostgresMigration(filename: string): boolean {
  if (!/^00\d{2}_.+\.sql$/.test(filename)) return false;
  return !MYSQL_PREFIXES.some(prefix => filename.startsWith(prefix));
}

/**
 * Split SQL on semicolons, keeping DO $$ ... END $$; blocks intact.
 */
export function splitStatements(sqlText: string): string[] {
  const result: string[] = [];
  let current = "";
  let inDollarBlock = false;

  for (const line of sqlText.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("--")) continue;

    if (/^DO\s*\$\$/.test(trimmed)) inDollarBlock = true;

    current += line + "\n";

    if (inDollarBlock && /^END\s*\$\$/.test(trimmed)) {
      inDollarBlock = false;
      const stmt = current.trim().replace(/;$/, "");
      if (stmt.length > 0) result.push(stmt);
      current = "";
      continue;
    }

    if (!inDollarBlock && trimmed.endsWith(";")) {
      const stmt = current.trim().replace(/;$/, "");
      if (stmt.length > 0) result.push(stmt);
      current = "";
    }
  }

  const leftover = current.trim().replace(/;$/, "");
  if (leftover.length > 0) result.push(leftover);

  return result.filter(stmt => stmt.replace(/--.*$/gm, "").trim().length > 0);
}

export interface ApplyResult {
  applied: string[];
  skipped: string[];
  stamped: string[];
}

export async function applyPendingMigrations(
  db: MigrationDb,
  files: MigrationFile[]
): Promise<ApplyResult> {
  const ordered = [...files]
    .filter(file => isPostgresMigration(file.filename))
    .sort((a, b) => a.filename.localeCompare(b.filename));

  await db.query(`
    CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
      filename text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  const existing = await db.query(`SELECT filename FROM ${MIGRATIONS_TABLE}`);
  const recorded = new Set(existing.map(row => String(row.filename)));
  const stamped: string[] = [];

  if (recorded.size === 0) {
    const tables = await db.query(
      `SELECT to_regclass('public.cards') AS cards`
    );
    const cards = tables[0]?.cards;
    if (cards) {
      for (const file of ordered) {
        if (file.filename <= BASELINE_THROUGH) {
          await db.query(
            `INSERT INTO ${MIGRATIONS_TABLE} (filename) VALUES ($1) ON CONFLICT (filename) DO NOTHING`,
            [file.filename]
          );
          recorded.add(file.filename);
          stamped.push(file.filename);
        }
      }
    }
  }

  const applied: string[] = [];
  const skipped: string[] = [];
  for (const file of ordered) {
    if (recorded.has(file.filename)) {
      skipped.push(file.filename);
      continue;
    }
    const statements = splitStatements(file.sql);
    try {
      await db.transaction(async tx => {
        for (const statement of statements) {
          await tx.query(statement);
        }
        await tx.query(
          `INSERT INTO ${MIGRATIONS_TABLE} (filename) VALUES ($1)`,
          [file.filename]
        );
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Migration ${file.filename} failed: ${message}`);
    }
    recorded.add(file.filename);
    applied.push(file.filename);
  }

  return { applied, skipped, stamped };
}
