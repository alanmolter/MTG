import { getRawClient, closeDb } from "../db";

/**
 * Pre-flight DB health check para o pipeline de treino.
 *
 * Verifica se as tabelas críticas estão íntegras (sem páginas corrompidas).
 * Exit code:
 *   0 = OK
 *   1 = erro de conexão / configuração
 *   2 = corrupção detectada (pipeline deve abortar e chamar repairSynergies.ts)
 */

const CRITICAL_TABLES = [
  "card_synergies",
  "card_learning",
  "cards",
];

async function scanTable(sql: any, table: string): Promise<{ ok: boolean; error?: string; block?: number }> {
  try {
    // SELECT sem WHERE força leitura de todas as páginas.
    await sql.unsafe(`SELECT 1 FROM ${table}`);
    return { ok: true };
  } catch (error: any) {
    const msg = String(error?.message || error);
    const m = msg.match(/block (\d+) of relation/);
    return { ok: false, error: msg, block: m ? Number(m[1]) : undefined };
  }
}

async function run() {
  const sql = await getRawClient();
  if (!sql) {
    console.error("[checkDbHealth] DATABASE_URL não configurado.");
    process.exit(1);
  }

  console.log("┌──────────────────────────────────────────────────────┐");
  console.log("│  PRE-FLIGHT — Verificação de integridade do banco    │");
  console.log("└──────────────────────────────────────────────────────┘");

  let anyCorruption = false;
  for (const table of CRITICAL_TABLES) {
    process.stdout.write(`  ▸ ${table.padEnd(18)} ... `);
    const r = await scanTable(sql, table);
    if (r.ok) {
      console.log("OK");
    } else {
      anyCorruption = true;
      console.log(`CORROMPIDA${r.block !== undefined ? ` (block ${r.block})` : ""}`);
      console.log(`    ${r.error}`);
    }
  }

  await closeDb();

  if (anyCorruption) {
    console.error(`\n════════════════════════════════════════════════════════`);
    console.error(`  ❌ CORRUPÇÃO DE BANCO DETECTADA`);
    console.error(`  Execute o reparo antes de prosseguir:`);
    console.error(`    npx tsx server/scripts/repairSynergies.ts --reindex`);
    console.error(`  Se o REINDEX falhar:`);
    console.error(`    npx tsx server/scripts/repairSynergies.ts --rebuild`);
    console.error(`════════════════════════════════════════════════════════\n`);
    process.exit(2);
  }

  console.log("\n  ✅ Todas as tabelas críticas íntegras.\n");
  process.exit(0);
}

run().catch(async (e) => {
  console.error("[checkDbHealth] Erro fatal:", e?.message || e);
  try { await closeDb(); } catch {}
  process.exit(1);
});
