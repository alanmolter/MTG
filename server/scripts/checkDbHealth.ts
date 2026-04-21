import "dotenv/config";
import { getRawClient, closeDb } from "../db";

/**
 * Pre-flight DB health check para o pipeline de treino.
 *
 * Verifica se as tabelas críticas estão íntegras (sem páginas corrompidas).
 * Distingue 3 estados:
 *   0 = OK (todas íntegras)
 *   1 = erro de conexão / DATABASE_URL não configurado / postgres fora do ar
 *   2 = corrupção de página detectada (pipeline deve abortar e chamar repairSynergies.ts)
 *
 * O script antigo confundia (1) com (2) — um ECONNREFUSED aparecia como
 * "CORROMPIDA (AggregateError)". Agora testamos conectividade PRIMEIRO e só
 * então fazemos full scan das tabelas.
 */

const CRITICAL_TABLES = [
  "card_synergies",
  "card_learning",
  "cards",
];

function unwrapError(e: any): { msg: string; code?: string; isConnError: boolean; block?: number } {
  const collectCodes = (err: any, acc: Set<string>) => {
    if (!err) return;
    if (err.code) acc.add(String(err.code));
    if (Array.isArray(err.errors)) for (const s of err.errors) collectCodes(s, acc);
    if (err.cause) collectCodes(err.cause, acc);
  };
  const codes = new Set<string>();
  collectCodes(e, codes);

  const connCodes = ["ECONNREFUSED", "ENOTFOUND", "ETIMEDOUT", "ECONNRESET", "EAI_AGAIN"];
  const isConnError = connCodes.some(c => codes.has(c));

  const rawMsg = String(e?.message || "");
  const subMsgs = Array.isArray(e?.errors)
    ? e.errors.map((s: any) => s?.message).filter(Boolean).join(" | ")
    : "";
  const msg = rawMsg || subMsgs || String(e);

  const blockMatch = (rawMsg + " " + subMsgs).match(/block (\d+) of relation/);
  const block = blockMatch ? Number(blockMatch[1]) : undefined;

  return { msg: msg + (subMsgs ? ` [${subMsgs}]` : ""), code: Array.from(codes).join(","), isConnError, block };
}

async function pingDb(sql: any): Promise<{ ok: boolean; err?: ReturnType<typeof unwrapError> }> {
  try {
    await sql`SELECT 1`;
    return { ok: true };
  } catch (e) {
    return { ok: false, err: unwrapError(e) };
  }
}

async function scanTable(sql: any, table: string): Promise<{ ok: boolean; err?: ReturnType<typeof unwrapError> }> {
  try {
    await sql.unsafe(`SELECT 1 FROM ${table}`);
    return { ok: true };
  } catch (e) {
    return { ok: false, err: unwrapError(e) };
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

  // Step 0: connectivity probe — distingue "DB offline" de "corrupção real"
  process.stdout.write("  ▸ conectividade        ... ");
  const ping = await pingDb(sql);
  if (!ping.ok) {
    console.log("FALHA");
    console.log(`    ${ping.err?.msg}`);
    if (ping.err?.code) console.log(`    code=${ping.err.code}`);
    await closeDb();
    console.error(`\n════════════════════════════════════════════════════════`);
    if (ping.err?.isConnError) {
      console.error(`  ❌ BANCO OFFLINE (não é corrupção!)`);
      console.error(`  Verifique se o Postgres está rodando:`);
      console.error(`    docker compose up -d`);
      console.error(`    docker compose ps`);
    } else {
      console.error(`  ❌ ERRO DE CONEXÃO`);
      console.error(`  ${ping.err?.msg}`);
    }
    console.error(`════════════════════════════════════════════════════════\n`);
    process.exit(1);
  }
  console.log("OK");

  let anyCorruption = false;
  for (const table of CRITICAL_TABLES) {
    process.stdout.write(`  ▸ ${table.padEnd(18)} ... `);
    const r = await scanTable(sql, table);
    if (r.ok) {
      console.log("OK");
    } else if (r.err?.isConnError) {
      // Conexão caiu no meio — reporta como falha de conexão, não corrupção
      console.log("CONN PERDIDA");
      console.log(`    ${r.err.msg}`);
      await closeDb();
      process.exit(1);
    } else {
      anyCorruption = true;
      console.log(`CORROMPIDA${r.err?.block !== undefined ? ` (block ${r.err.block})` : ""}`);
      console.log(`    ${r.err?.msg}`);
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
  const u = unwrapError(e);
  console.error("[checkDbHealth] Erro fatal:", u.msg, u.code ? `(code=${u.code})` : "");
  try { await closeDb(); } catch {}
  process.exit(1);
});
