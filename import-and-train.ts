import "dotenv/config";
import { importMTGGoldfishDecks } from "./server/services/mtggoldfishScraper.ts";
import { importMTGTop8Decks } from "./server/services/mtgtop8Scraper.ts";

import { trainEmbeddingsFromDecks, getTrainingJobHistory } from "./server/services/embeddingTrainer.ts";

async function main() {
  console.log("🚀 Iniciando Importação de Dados Reais...");

  // 1. Importar de várias fontes
  console.log("\n📊 [1/3] Importando do MTGGoldfish...");
  const goldfish = await importMTGGoldfishDecks("modern", 10);
  console.log(`   ✅ ${goldfish.decksImported} decks importados.`);

  console.log("\n📊 [2/3] Importando do MTGTop8...");
  const top8 = await importMTGTop8Decks("modern", 10);
  console.log(`   ✅ ${top8.decksImported} decks importados.`);



  // 2. Treinar Embeddings
  console.log("\n🧠 Treinando Embeddings Word2Vec com dados reais...");
  const result = await trainEmbeddingsFromDecks();

  if (result.status === "completed") {
    console.log("\n✨ Treinamento Concluído com Sucesso!");
    console.log(`   - Embeddings Treinados: ${result.embeddingsTrained}`);
    console.log(`   - Sinergias Atualizadas: ${result.synergiesUpdated}`);
    console.log(`   - Duração: ${(result.durationMs / 1000).toFixed(2)}s`);
  } else {
    console.error("\n❌ Falha no treinamento:", result.error);
  }

  const history = await getTrainingJobHistory(1);
  console.log("\n📝 Último Job:", history[0]?.status);
}

main().catch(console.error);
