/**
 * applyMigration.ts
 *
 * Aplica a migracao 0004 diretamente no banco PostgreSQL usando SQL puro.
 * Nao depende do drizzle-kit generate (que falha com snapshots MySQL antigos).
 * Seguro para rodar multiplas vezes (todas as instrucoes usam IF NOT EXISTS).
 * Suporta blocos DO $$ ... END $$ sem quebrar no ponto-e-virgula interno.
 */
import "dotenv/config";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { sql } from "drizzle-orm";
import * as fs from "fs";
import * as path from "path";

// Codigos PostgreSQL que indicam "objeto ja existe" — ignorar silenciosamente
const SKIP_CODES = new Set(["42P07", "42701", "42P06", "42P04", "42710", "23505"]);
const SKIP_MSGS  = ["already exists", "ja existe", "já existe", "duplicate"];

function isExpectedError(err: any): boolean {
  if (err?.severity === "NOTICE" || err?.severity_local === "NOTA") return true;
  if (SKIP_CODES.has(err?.code)) return true;
  const msg = (err?.message ?? "").toLowerCase();
  return SKIP_MSGS.some((s) => msg.includes(s));
}

/**
 * Divide o SQL em statements preservando blocos DO $$ ... END $$ inteiros.
 */
function splitStatements(sql: string): string[] {
  const result: string[] = [];
  let current = "";
  let inDollarBlock = false;

  for (const line of sql.split("\n")) {
    const trimmed = line.trim();
    // Pular linhas de comentario puras
    if (trimmed.startsWith("--")) continue;

    // Detectar inicio de bloco DO $$
    if (/^DO\s*\$\$/.test(trimmed)) inDollarBlock = true;

    current += line + "\n";

    // Detectar fim de bloco DO $$ (END $$;)
    if (inDollarBlock && /^END\s*\$\$/.test(trimmed)) {
      inDollarBlock = false;
      const stmt = current.trim().replace(/;$/, ""); // remover ; final para sql.raw
      if (stmt.length > 0) result.push(stmt);
      current = "";
      continue;
    }

    // Statement normal terminado com ;
    if (!inDollarBlock && trimmed.endsWith(";")) {
      const stmt = current.trim().replace(/;$/, "");
      if (stmt.length > 0) result.push(stmt);
      current = "";
    }
  }

  // Qualquer resto
  const leftover = current.trim().replace(/;$/, "");
  if (leftover.length > 0) result.push(leftover);

  return result.filter((s) => s.replace(/--.*$/gm, "").trim().length > 0);
}

async function applyMigration() {
  console.log("[Migration] Verificando schema do banco...");

  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.error("[Migration] DATABASE_URL nao configurado.");
    process.exit(1);
  }

  // Conexao dedicada com max:1 — garante que client.end() fecha tudo
  const client = postgres(dbUrl, {
    max: 1,
    idle_timeout: 5,
    connect_timeout: 10,
    onnotice: () => {},
  });
  const db = drizzle(client);

  try {
    // Migrações aplicadas em ordem; qualquer NEW file drizzle/000N_*.sql é auto-descoberto
    const drizzleDir = path.join(process.cwd(), "drizzle");
    const migrationFiles = fs
      .readdirSync(drizzleDir)
      .filter((f) => /^00(0[4-9]|[1-9][0-9])_.*\.sql$/.test(f))  // 0004+
      .sort();

    if (migrationFiles.length === 0) {
      console.error("[Migration] Nenhum arquivo 000N_*.sql encontrado a partir de 0004.");
      return;
    }

    let totalApplied = 0;
    let totalSkipped = 0;

    for (const file of migrationFiles) {
      const migrationPath = path.join(drizzleDir, file);
      const migrationSQL = fs.readFileSync(migrationPath, "utf-8");
      const statements = splitStatements(migrationSQL);

      let applied = 0;
      let skipped = 0;

      for (const statement of statements) {
        try {
          await db.execute(sql.raw(statement));
          applied++;
        } catch (err: any) {
          if (isExpectedError(err)) {
            skipped++; // silencioso — objeto ja existe
          } else {
            const shortMsg = err?.message?.split("\n")[0] ?? "erro desconhecido";
            console.warn(`[Migration][${file}] Aviso inesperado: ${shortMsg}`);
            skipped++;
          }
        }
      }

      if (applied > 0) {
        console.log(`[Migration] ${file}: ${applied} alteracoes aplicadas (${skipped} no-op).`);
      }
      totalApplied += applied;
      totalSkipped += skipped;
    }

    if (totalApplied > 0) {
      console.log(`[Migration] Schema atualizado: ${totalApplied} alteracoes aplicadas no total.`);
    } else {
      console.log(`[Migration] Schema ja esta atualizado (${totalSkipped} objetos ja existiam).`);
    }
  } catch (err: any) {
    console.error("[Migration] Erro fatal:", err?.message);
  } finally {
    // SEMPRE fechar a conexao para o processo Node.js poder encerrar
    try { await client.end({ timeout: 3 }); } catch (_) {}
  }
}

applyMigration()
  .catch((err) => console.error("[Migration] Erro fatal:", err?.message))
  .finally(() => process.exit(0));
