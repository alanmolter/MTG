import "dotenv/config";
import { importMTGGoldfishDecks } from "./server/services/mtggoldfishScraper.ts";
import { importMTGTop8Decks } from "./server/services/mtgtop8Scraper.ts";
import { trainEmbeddingsFromDecks, getTrainingJobHistory } from "./server/services/embeddingTrainer.ts";

// Timeout global de 5 minutos para o script inteiro
const GLOBAL_TIMEOUT = setTimeout(() => {
  console.warn("[import-and-train] Timeout global atingido (5min). Encerrando...");
  process.exit(0);
}, 5 * 60 * 1000);
GLOBAL_TIMEOUT.unref();

async function main() {
  console.log("[import-and-train] Iniciando importacao de dados reais...");

  // 1. MTGGoldfish
  console.log("\n[1/3] Importando do MTGGoldfish...");
  try {
    const goldfish = await importMTGGoldfishDecks("modern", 10);
    console.log(`   OK: ${goldfish.decksImported} importados, ${goldfish.decksSkipped} pulados.`);
    if (goldfish.errors.length > 0) {
      console.warn(`   Avisos: ${goldfish.errors.slice(0, 3).join("; ")}`);
    }
  } catch (e: any) {
    console.warn(`   [AVISO] MTGGoldfish falhou: ${e?.message}. Continuando...`);
  }

  // 2. MTGTop8
  console.log("\n[2/3] Importando do MTGTop8...");
  try {
    const top8 = await importMTGTop8Decks("modern", 10);
    console.log(`   OK: ${top8.decksImported} importados, ${top8.decksSkipped} pulados.`);
    if (top8.errors.length > 0) {
      console.warn(`   Avisos: ${top8.errors.slice(0, 3).join("; ")}`);
    }
  } catch (e: any) {
    console.warn(`   [AVISO] MTGTop8 falhou: ${e?.message}. Continuando...`);
  }

  // 3. Treinar Embeddings
  console.log("\n[3/3] Treinando Embeddings Word2Vec...");
  try {
    const result = await trainEmbeddingsFromDecks();
    if (result.status === "completed") {
      console.log(`   OK: ${result.embeddingsTrained} embeddings, ${result.synergiesUpdated} sinergias (${(result.durationMs / 1000).toFixed(1)}s)`);
    } else {
      console.warn(`   [AVISO] Embeddings: ${result.error}`);
    }
  } catch (e: any) {
    console.warn(`   [AVISO] Embeddings falhou: ${e?.message}. Continuando...`);
  }

  console.log("\n[import-and-train] Concluido.");
  clearTimeout(GLOBAL_TIMEOUT);
  process.exit(0);
}

main().catch((e) => {
  console.error("[import-and-train] Erro fatal:", e?.message);
  process.exit(0);
});
