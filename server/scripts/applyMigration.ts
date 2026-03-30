/**
 * applyMigration.ts
 *
 * Aplica a migração 0004 diretamente no banco PostgreSQL usando SQL puro.
 * Não depende do drizzle-kit generate (que falha com snapshots MySQL antigos).
 * Seguro para rodar múltiplas vezes (todas as instruções usam IF NOT EXISTS).
 */
import "dotenv/config";
import { getDb } from "../db";
import { sql } from "drizzle-orm";
import * as fs from "fs";
import * as path from "path";

async function applyMigration() {
  console.log("[Migration] Iniciando aplicação da migração 0004...");

  const db = await getDb();
  if (!db) {
    console.error("[Migration] Erro ao conectar ao banco.");
    process.exit(1);
  }

  const migrationPath = path.join(process.cwd(), "drizzle", "0004_mtg_ai_updates.sql");

  if (!fs.existsSync(migrationPath)) {
    console.error("[Migration] Arquivo 0004_mtg_ai_updates.sql não encontrado.");
    process.exit(1);
  }

  const migrationSQL = fs.readFileSync(migrationPath, "utf-8");

  // Dividir por ; e executar cada statement individualmente
  const statements = migrationSQL
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !s.startsWith("--"));

  let applied = 0;
  let skipped = 0;

  for (const statement of statements) {
    try {
      await db.execute(sql.raw(statement));
      applied++;
    } catch (err: any) {
      // Ignorar erros de "já existe" (42P07, 42701, 42P06)
      if (
        err?.code === "42P07" ||
        err?.code === "42701" ||
        err?.code === "42P06" ||
        err?.message?.includes("already exists")
      ) {
        skipped++;
      } else {
        console.warn(`[Migration] Aviso no statement: ${err?.message}`);
        skipped++;
      }
    }
  }

  console.log(`[Migration] Concluído: ${applied} aplicados, ${skipped} já existiam.`);
  process.exit(0);
}

applyMigration().catch((err) => {
  console.error("[Migration] Erro fatal:", err);
  process.exit(1);
});
