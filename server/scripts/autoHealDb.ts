import { getRawClient, closeDb } from "../db";

/**
 * AUTO-HEAL DO BANCO DE DADOS
 *
 * Executa: diagnóstico → (se corrompido) reparo em escada → re-verificação.
 * Escada de reparo:
 *   1. REINDEX TABLE   (rápido, não destrutivo)
 *   2. VACUUM FULL     (reescreve heap)
 *   3. DROP + REBUILD  (nuclear — zera sinergias, recriadas no próximo treino)
 *
 * Exit codes:
 *   0 — banco saudável (já era, ou foi reparado com sucesso)
 *   1 — falha de conexão / configuração
 *   2 — corrupção NÃO reparável automaticamente (ação manual necessária)
 *
 * Uso:
 *   npx tsx server/scripts/autoHealDb.ts              # auto-heal full
 *   npx tsx server/scripts/autoHealDb.ts --dry-run    # só diagnóstico
 *   npx tsx server/scripts/autoHealDb.ts --no-rebuild # não chega ao nuclear
 */

const args = new Set(process.argv.slice(2));
const DRY_RUN = args.has("--dry-run");
const NO_REBUILD = args.has("--no-rebuild");

const CRITICAL_TABLES = ["card_synergies", "card_learning", "cards"];

type ScanResult = { ok: boolean; error?: string; block?: number };
type HealStep = "reindex" | "vacuum" | "rebuild";

function banner(title: string, char = "═") {
  const line = char.repeat(60);
  console.log(`\n${line}\n  ${title}\n${line}`);
}

function isCorruptionError(msg: string): boolean {
  return /invalid page in block/i.test(msg) || /could not read block/i.test(msg);
}

async function scanTable(sql: any, table: string): Promise<ScanResult> {
  try {
    await sql.unsafe(`SELECT 1 FROM ${table}`);
    return { ok: true };
  } catch (error: any) {
    const msg = String(error?.message || error);
    const m = msg.match(/block (\d+) of relation/);
    return { ok: false, error: msg, block: m ? Number(m[1]) : undefined };
  }
}

async function scanAll(sql: any): Promise<Record<string, ScanResult>> {
  const out: Record<string, ScanResult> = {};
  for (const t of CRITICAL_TABLES) {
    out[t] = await scanTable(sql, t);
  }
  return out;
}

function reportScan(results: Record<string, ScanResult>): { healthy: boolean; corrupted: string[] } {
  const corrupted: string[] = [];
  for (const [table, r] of Object.entries(results)) {
    if (r.ok) {
      console.log(`  ▸ ${table.padEnd(18)} OK`);
    } else {
      const tag = isCorruptionError(r.error || "") ? "CORRUPTED" : "ERROR";
      const blk = r.block !== undefined ? ` (block ${r.block})` : "";
      console.log(`  ▸ ${table.padEnd(18)} ${tag}${blk}`);
      console.log(`     ${r.error}`);
      if (isCorruptionError(r.error || "")) corrupted.push(table);
    }
  }
  return { healthy: corrupted.length === 0, corrupted };
}

async function tryReindex(sql: any, table: string): Promise<boolean> {
  try {
    console.log(`  → REINDEX TABLE ${table} ...`);
    await sql.unsafe(`REINDEX TABLE ${table}`);
    console.log(`    OK`);
    return true;
  } catch (e: any) {
    console.log(`    FALHOU: ${e?.message}`);
    return false;
  }
}

async function tryVacuumFull(sql: any, table: string): Promise<boolean> {
  try {
    console.log(`  → VACUUM FULL ${table} ...`);
    await sql.unsafe(`VACUUM FULL ${table}`);
    console.log(`    OK`);
    return true;
  } catch (e: any) {
    console.log(`    FALHOU: ${e?.message}`);
    return false;
  }
}

async function tryRebuildCardSynergies(sql: any): Promise<boolean> {
  try {
    console.log(`  → DROP + RECREATE card_synergies (nuclear)...`);
    await sql.unsafe(`DROP TABLE IF EXISTS card_synergies CASCADE`);
    await sql.unsafe(`
      CREATE TABLE card_synergies (
        id serial PRIMARY KEY,
        card1_id integer NOT NULL REFERENCES cards(id),
        card2_id integer NOT NULL REFERENCES cards(id),
        weight integer NOT NULL DEFAULT 0,
        co_occurrence_rate integer NOT NULL DEFAULT 0,
        updated_at timestamp NOT NULL DEFAULT now(),
        CONSTRAINT card_synergies_pair_unique UNIQUE (card1_id, card2_id)
      )
    `);
    await sql.unsafe(`CREATE INDEX idx_card_synergies_c1 ON card_synergies(card1_id)`);
    await sql.unsafe(`CREATE INDEX idx_card_synergies_c2 ON card_synergies(card2_id)`);
    console.log(`    OK (dados perdidos — serão recriados nos próximos treinos)`);
    return true;
  } catch (e: any) {
    console.log(`    FALHOU: ${e?.message}`);
    return false;
  }
}

/** Heal pipeline para UMA tabela. Retorna a etapa bem-sucedida, ou null. */
export async function healTable(
  sql: any,
  table: string,
  opts: { allowRebuild: boolean } = { allowRebuild: true }
): Promise<HealStep | null> {
  // 1) REINDEX
  if (await tryReindex(sql, table)) {
    const verify = await scanTable(sql, table);
    if (verify.ok) return "reindex";
    console.log(`    ↳ REINDEX não resolveu, página ainda corrompida.`);
  }

  // 2) VACUUM FULL
  if (await tryVacuumFull(sql, table)) {
    const verify = await scanTable(sql, table);
    if (verify.ok) return "vacuum";
    console.log(`    ↳ VACUUM FULL não resolveu.`);
  }

  // 3) REBUILD (apenas card_synergies — outras tabelas têm dados insubstituíveis)
  if (opts.allowRebuild && table === "card_synergies") {
    if (await tryRebuildCardSynergies(sql)) {
      const verify = await scanTable(sql, table);
      if (verify.ok) return "rebuild";
      console.log(`    ↳ REBUILD não resolveu. Caso anômalo.`);
    }
  } else if (!opts.allowRebuild) {
    console.log(`    ↳ --no-rebuild setado, não tentando DROP+CREATE.`);
  } else {
    console.log(
      `    ↳ Rebuild automático não disponível para "${table}" (dados insubstituíveis).`
    );
    console.log(`      Ação manual necessária — verifique o disco e considere restore de backup.`);
  }

  return null;
}

async function run() {
  banner("AUTO-HEAL DB — diagnóstico inicial");

  const sql = await getRawClient();
  if (!sql) {
    console.error("[autoHealDb] DATABASE_URL não configurado.");
    process.exit(1);
  }

  const before = await scanAll(sql);
  const { healthy, corrupted } = reportScan(before);

  if (healthy) {
    console.log("\n  ✅ Banco saudável. Nada a fazer.");
    await closeDb();
    process.exit(0);
  }

  if (DRY_RUN) {
    console.log(`\n  [dry-run] ${corrupted.length} tabela(s) corrompida(s). Nenhum reparo executado.`);
    await closeDb();
    process.exit(2);
  }

  banner("REPARO AUTOMÁTICO");
  const healed: Record<string, HealStep | null> = {};
  for (const table of corrupted) {
    console.log(`\n  [${table}]`);
    healed[table] = await healTable(sql, table, { allowRebuild: !NO_REBUILD });
  }

  // Verificação final
  banner("VERIFICAÇÃO FINAL");
  const after = await scanAll(sql);
  const postReport = reportScan(after);

  console.log(`\n  Resumo do reparo:`);
  for (const [table, step] of Object.entries(healed)) {
    console.log(`    ▸ ${table.padEnd(18)} ${step ? `reparado via ${step.toUpperCase()}` : "NÃO REPARADO"}`);
  }

  await closeDb();

  if (postReport.healthy) {
    console.log(`\n  ✅ Banco totalmente reparado. Pipeline pode prosseguir.\n`);
    process.exit(0);
  } else {
    console.error(`\n  ❌ Corrupção persiste em: ${postReport.corrupted.join(", ")}`);
    console.error(`     Considere restore de backup ou intervenção manual no disco.\n`);
    process.exit(2);
  }
}

// Apenas executa se chamado como script (permite importar `healTable` em testes)
const isMain = import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}` ||
  process.argv[1]?.endsWith("autoHealDb.ts");

if (isMain) {
  run().catch(async (e) => {
    console.error("[autoHealDb] Erro fatal:", e?.message || e);
    try { await closeDb(); } catch {}
    process.exit(1);
  });
}
