import "dotenv/config";
import { importMoxfieldDecks } from "./server/services/moxfieldScraper.ts";
import { clusterCompetitiveDecks, getClusterStatsByArchetype } from "./server/services/clustering.ts";
import { getDb } from "./server/db.ts";

async function main() {
  console.log("🚀 Iniciando Pipeline de Clustering Real...");

  // 1. Importar alguns decks para ter dados
  console.log("\n📦 Passo 1: Importando decks competitivos (Modern)...");
  const importResult = await importMoxfieldDecks("modern", 2);
  console.log(`✅ Importação concluída: ${importResult.decksImported} decks importados, ${importResult.decksSkipped} pulados.`);

  // 2. Executar Clustering
  console.log("\n🧪 Passo 2: Executando Clustering KMeans (Real ML-KMeans)...");
  const { clusters, stats } = await clusterCompetitiveDecks(2); // K=2 clusters

  if (clusters.length === 0) {
    console.warn("⚠️ Nenhum cluster gerado. Verifique se há decks e se as cartas possuem embeddings.");
    return;
  }

  // 3. Exibir Resultados
  console.log("\n📊 Estatísticas do Clustering:");
  console.log(`- Silhouette Score: ${stats.silhouetteScore.toFixed(4)}`);
  console.log(`- Davies-Bouldin Index: ${stats.daviesBouldinIndex.toFixed(4)}`);
  console.log(`- Inércia (SSW): ${stats.inertia.toFixed(2)}`);

  const archetypeStats = getClusterStatsByArchetype(clusters);
  console.log("\n🏷️  Arquétipos Identificados:");
  archetypeStats.forEach(as => {
    console.log(`   - ${as.archetype}: ${as.totalDecks} decks em ${as.clusterCount} clusters (Confiança: ${(as.avgConfidence * 100).toFixed(1)}%)`);
  });

  console.log("\n✨ Pipeline Finalizado!");
}

main().catch(console.error);
