import "dotenv/config";
import { getRawClient, closeDb } from "../db";

/**
 * REPARADOR DE card_synergies
 *
 * Uso:
 *   npx tsx server/scripts/repairSynergies.ts           # diagnóstico apenas
 *   npx tsx server/scripts/repairSynergies.ts --reindex # tenta REINDEX
 *   npx tsx server/scripts/repairSynergies.ts --vacuum  # tenta VACUUM FULL
 *   npx tsx server/scripts/repairSynergies.ts --rebuild # DROP + recriação (nuclear)
 *
 * Sintoma detectado: PostgresError XX001 "invalid page in block N of relation ...".
 * É corrupção de disco — não é bug de código. Este script cobre os 3 remédios.
 */

const args = new Set(process.argv.slice(2));
const DO_REINDEX = args.has("--reindex");
const DO_VACUUM = args.has("--vacuum");
const DO_REBUILD = args.has("--rebuild");

/**
 * Desempacota erros compostos do postgres.js (AggregateError com errors[]).
 * Sem isto, vemos só `.message=""` e ficamos cegos para a causa raiz.
 */
function unwrapMsg(e: any): string {
  if (!e) return "<null>";
  const parts: string[] = [];
  if (e.message) parts.push(String(e.message));
  if (e.code) parts.push(`code=${e.code}`);
  if (Array.isArray(e.errors)) {
    for (const s of e.errors) {
      parts.push(`[sub: ${unwrapMsg(s)}]`);
    }
  }
  if (e.cause) parts.push(`[cause: ${unwrapMsg(e.cause)}]`);
  return parts.join(" ");
}

function banner(title: string) {
  const line = "═".repeat(60);
  console.log(`\n${line}\n  ${title}\n${line}`);
}

async function probeHealth(sql: any): Promise<{ ok: boolean; error?: any; rows?: number }> {
  try {
    const rows = await sql`SELECT COUNT(*)::int AS c FROM card_synergies`;
    return { ok: true, rows: rows[0]?.c ?? 0 };
  } catch (error) {
    return { ok: false, error };
  }
}

async function fullScan(sql: any): Promise<{ ok: boolean; error?: any }> {
  try {
    // Força leitura física de todas as páginas — revela corrupção latente.
    await sql`SELECT id, card1_id, card2_id, weight, co_occurrence_rate FROM card_synergies`;
    return { ok: true };
  } catch (error) {
    return { ok: false, error };
  }
}

async function run() {
  banner("DIAGNÓSTICO DE card_synergies");

  const sql = await getRawClient();
  if (!sql) {
    console.error("[ERRO] DATABASE_URL não configurado ou cliente indisponível.");
    process.exit(1);
  }

  // 1) Probe rápido
  console.log("→ probe COUNT(*)...");
  const probe = await probeHealth(sql);
  if (probe.ok) {
    console.log(`  OK. ${probe.rows} linhas na tabela.`);
  } else {
    console.log(`  FALHOU: ${unwrapMsg(probe.error)}`);
  }

  // 2) Full scan
  console.log("→ full scan (força leitura física de todas as páginas)...");
  const scan = await fullScan(sql);
  if (scan.ok) {
    console.log("  OK. Nenhuma página corrompida detectada.");
  } else {
    const msg = String(scan.error?.message || "");
    console.log(`  FALHOU: ${msg}`);
    const m = msg.match(/block (\d+) of relation/);
    if (m) console.log(`  ⚠ Página corrompida: block ${m[1]}`);
  }

  const healthy = probe.ok && scan.ok;

  if (healthy && !DO_REINDEX && !DO_VACUUM && !DO_REBUILD) {
    console.log("\n✅ Tabela íntegra. Nenhuma ação necessária.");
    await closeDb();
    return;
  }

  if (!DO_REINDEX && !DO_VACUUM && !DO_REBUILD) {
    banner("COMO REPARAR");
    console.log(`  Tabela com corrupção detectada. Opções (ordem recomendada):`);
    console.log(`    1) npx tsx server/scripts/repairSynergies.ts --reindex`);
    console.log(`       (mais rápido, tenta reconstruir só os índices)`);
    console.log(`    2) npx tsx server/scripts/repairSynergies.ts --vacuum`);
    console.log(`       (reescreve o heap — pode falhar se o bloco corrompido não puder ser lido)`);
    console.log(`    3) npx tsx server/scripts/repairSynergies.ts --rebuild`);
    console.log(`       (nuclear: DROP + recriação. Dados de sinergia são perdidos;`);
    console.log(`        serão reconstruídos nos próximos treinos via pair learning.)`);
    await closeDb();
    process.exit(2);
  }

  // 3) REINDEX
  if (DO_REINDEX) {
    banner("REINDEX TABLE card_synergies");
    try {
      await sql.unsafe(`REINDEX TABLE card_synergies`);
      console.log("  ✅ REINDEX concluído.");
      const re = await fullScan(sql);
      if (re.ok) console.log("  ✅ Full scan agora passa. Tabela reparada.");
      else console.log(`  ⚠ Ainda corrompida após REINDEX: ${unwrapMsg(re.error)}`);
    } catch (e: any) {
      console.error(`  ❌ REINDEX falhou: ${unwrapMsg(e)}`);
    }
  }

  // 4) VACUUM FULL
  if (DO_VACUUM) {
    banner("VACUUM FULL card_synergies");
    try {
      await sql.unsafe(`VACUUM FULL card_synergies`);
      console.log("  ✅ VACUUM FULL concluído.");
      const re = await fullScan(sql);
      if (re.ok) console.log("  ✅ Full scan agora passa. Tabela reparada.");
      else console.log(`  ⚠ Ainda corrompida após VACUUM: ${unwrapMsg(re.error)}`);
    } catch (e: any) {
      console.error(`  ❌ VACUUM FULL falhou: ${unwrapMsg(e)}`);
      console.error(`     (esperado se o bloco corrompido for ilegível — use --rebuild)`);
    }
  }

  // 5) REBUILD (nuclear)
  if (DO_REBUILD) {
    banner("REBUILD card_synergies (DROP + CREATE)");
    console.log("  ⚠ Perderá todos os dados de sinergia. Treinos subsequentes recriam via pair learning.");
    try {
      await sql.unsafe(`DROP TABLE IF EXISTS card_synergies CASCADE`);
      console.log("  ✔ DROP OK.");
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
      console.log("  ✔ CREATE OK.");
      await sql.unsafe(`CREATE INDEX idx_card_synergies_c1 ON card_synergies(card1_id)`);
      await sql.unsafe(`CREATE INDEX idx_card_synergies_c2 ON card_synergies(card2_id)`);
      console.log("  ✔ Índices criados.");
      const re = await fullScan(sql);
      if (re.ok) console.log("  ✅ Tabela recriada e saudável.");
      else console.log(`  ❌ Inesperado: scan ainda falha: ${unwrapMsg(re.error)}`);
    } catch (e: any) {
      console.error(`  ❌ REBUILD falhou: ${unwrapMsg(e)}`);
    }
  }

  banner("FIM");
  await closeDb();
}

run().catch(async (e) => {
  console.error("[repairSynergies] Erro fatal:", unwrapMsg(e));
  try { await closeDb(); } catch {}
  process.exit(1);
});
