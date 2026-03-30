import "dotenv/config";
import { clusterCompetitiveDecks, getClusterStatsByArchetype } from "./server/services/clustering.ts";
import { getDb, closeDb } from "./server/db.ts";
import { competitiveDecks } from "./drizzle/schema.ts";
import { count } from "drizzle-orm";

// Timeout global de 5 minutos
const GLOBAL_TIMEOUT = setTimeout(() => {
  console.log("\n[clustering] Timeout global atingido (5min). Encerrando...");
  closeDb().then(() => process.exit(0)).catch(() => process.exit(0));
}, 5 * 60 * 1000);
GLOBAL_TIMEOUT.unref();

function divider(label: string) {
  const line = "-".repeat(52);
  console.log(`\n${line}`);
  console.log(`  ${label}`);
  console.log(line);
}

function bar(current: number, total: number, width = 20): string {
  const filled = total > 0 ? Math.round((current / total) * width) : 0;
  return "[" + "#".repeat(filled) + "-".repeat(width - filled) + "]";
}

function timestamp(): string {
  return new Date().toLocaleTimeString("pt-BR");
}

async function main() {
  const startTotal = Date.now();
  console.log("=".repeat(52));
  console.log("  CLUSTERING DE ARQUETIPOS (KMeans)");
  console.log(`  Inicio: ${timestamp()}`);
  console.log("=".repeat(52));

  // ─── 1. Verificar dados no banco ─────────────────
  divider("1/3  Verificando dados no banco");
  const db = await getDb();
  if (!db) {
    console.error("  [ERRO] Nao foi possivel conectar ao banco. Abortando.");
    closeDb().then(() => process.exit(1)).catch(() => process.exit(1));
  }

  const [{ value: totalDecks }] = await db.select({ value: count() }).from(competitiveDecks);
  console.log(`  Decks competitivos no banco: ${totalDecks}`);

  if (totalDecks === 0) {
    console.warn("  [AVISO] Nenhum deck encontrado. Execute o passo de importacao primeiro.");
    console.warn("  Encerrando clustering.");
    clearTimeout(GLOBAL_TIMEOUT);
    closeDb().then(() => process.exit(0)).catch(() => process.exit(0));
  }

  // ─── 2. Clustering KMeans ─────────────────────────
  divider("2/3  Executando Clustering KMeans");
  const k = Math.min(8, Math.max(2, Math.floor(Number(totalDecks) / 5)));
  console.log(`  Decks para clusterizar : ${totalDecks}`);
  console.log(`  Numero de clusters (K) : ${k}`);
  console.log(`  Aguardando resultado...`);

  const t2 = Date.now();
  let clusters: any[] = [];
  let stats: any = {};

  try {
    const result = await clusterCompetitiveDecks(k);
    clusters = result.clusters;
    stats = result.stats;
    const dur2 = ((Date.now() - t2) / 1000).toFixed(1);

    if (clusters.length === 0) {
      console.warn("  [AVISO] Nenhum cluster gerado. Verifique se as cartas possuem embeddings.");
      clearTimeout(GLOBAL_TIMEOUT);
      closeDb().then(() => process.exit(0)).catch(() => process.exit(0));
    }

    console.log(`  Clusters gerados       : ${clusters.length}`);
    console.log(`  Duracao                : ${dur2}s`);
  } catch (e: any) {
    console.warn(`  [AVISO] Clustering falhou: ${e?.message}. Continuando...`);
    clearTimeout(GLOBAL_TIMEOUT);
    closeDb().then(() => process.exit(0)).catch(() => process.exit(0));
  }

  // ─── 3. Resultados ───────────────────────────────
  divider("3/3  Resultados do Clustering");
  console.log(`  Silhouette Score     : ${stats.silhouetteScore?.toFixed(4) ?? "N/A"}`);
  console.log(`  Davies-Bouldin Index : ${stats.daviesBouldinIndex?.toFixed(4) ?? "N/A"}`);
  console.log(`  Inertia (SSW)        : ${stats.inertia?.toFixed(2) ?? "N/A"}`);

  const archetypeStats = getClusterStatsByArchetype(clusters);
  if (archetypeStats.length > 0) {
    console.log(`\n  Arquetipos identificados (${archetypeStats.length}):`);
    archetypeStats.forEach((as: any, i: number) => {
      const conf = (as.avgConfidence * 100).toFixed(1);
      const prog = bar(Math.round(as.avgConfidence * 100), 100, 15);
      console.log(`  ${String(i + 1).padStart(2)}. ${prog} ${conf}%  ${as.archetype} (${as.totalDecks} decks, ${as.clusterCount} clusters)`);
    });
  } else {
    console.log("  Nenhum arquetipo identificado.");
  }

  // ─── Resumo Final ─────────────────────────────────
  const totalDur = ((Date.now() - startTotal) / 1000).toFixed(1);
  console.log("\n" + "=".repeat(52));
  console.log(`  CONCLUIDO em ${totalDur}s -- ${timestamp()}`);
  console.log("=".repeat(52) + "\n");

  clearTimeout(GLOBAL_TIMEOUT);
  closeDb().then(() => process.exit(0)).catch(() => process.exit(0));
}

main().catch((e) => {
  console.error("[clustering] Erro fatal:", e?.message);
  closeDb().then(() => process.exit(0)).catch(() => process.exit(0));
});
