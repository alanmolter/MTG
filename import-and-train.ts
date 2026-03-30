import "dotenv/config";
import { importMTGGoldfishDecks } from "./server/services/mtggoldfishScraper.ts";
import { importMTGTop8Decks } from "./server/services/mtgtop8Scraper.ts";
import { trainEmbeddingsFromDecks } from "./server/services/embeddingTrainer.ts";

// Timeout global de 8 minutos
const GLOBAL_TIMEOUT = setTimeout(() => {
  console.log("\n[import-and-train] Timeout global atingido (8min). Encerrando...");
  process.exit(0);
}, 8 * 60 * 1000);
GLOBAL_TIMEOUT.unref();

function divider(label: string) {
  const line = "-".repeat(52);
  console.log(`\n${line}`);
  console.log(`  ${label}`);
  console.log(line);
}

function timestamp(): string {
  return new Date().toLocaleTimeString("pt-BR");
}

async function main() {
  const startTotal = Date.now();
  console.log("=".repeat(52));
  console.log("  IMPORTACAO E TREINAMENTO DE DADOS");
  console.log(`  Inicio: ${timestamp()}`);
  console.log("=".repeat(52));

  // ─── 1. MTGGoldfish ───────────────────────────────
  divider("1/3  MTGGoldfish -- Metagame Moderno");
  const t1 = Date.now();
  try {
    const goldfish = await importMTGGoldfishDecks("modern", 10);
    const dur1 = ((Date.now() - t1) / 1000).toFixed(1);
    console.log(`  Decks importados : ${goldfish.decksImported}`);
    console.log(`  Decks pulados    : ${goldfish.decksSkipped}`);
    console.log(`  Cartas salvas    : ${goldfish.cardsImported}`);
    console.log(`  Duracao          : ${dur1}s`);
    if (goldfish.errors.length > 0) {
      console.warn(`  Avisos (${goldfish.errors.length}): ${goldfish.errors.slice(0, 3).join(" | ")}`);
    }
  } catch (e: any) {
    console.warn(`  [AVISO] MTGGoldfish falhou: ${e?.message}. Continuando...`);
  }

  // ─── 2. MTGTop8 ───────────────────────────────────
  divider("2/3  MTGTop8 -- Torneios Recentes");
  const t2 = Date.now();
  try {
    const top8 = await importMTGTop8Decks("modern", 10);
    const dur2 = ((Date.now() - t2) / 1000).toFixed(1);
    console.log(`  Decks importados : ${top8.decksImported}`);
    console.log(`  Decks pulados    : ${top8.decksSkipped}`);
    console.log(`  Cartas salvas    : ${top8.cardsImported}`);
    console.log(`  Duracao          : ${dur2}s`);
    if (top8.errors.length > 0) {
      console.warn(`  Avisos (${top8.errors.length}): ${top8.errors.slice(0, 3).join(" | ")}`);
    }
  } catch (e: any) {
    console.warn(`  [AVISO] MTGTop8 falhou: ${e?.message}. Continuando...`);
  }

  // ─── 3. Embeddings Word2Vec ───────────────────────
  divider("3/3  Treinamento de Embeddings Word2Vec");
  const t3 = Date.now();
  console.log("  Carregando decks competitivos do banco...");
  try {
    const result = await trainEmbeddingsFromDecks();
    const dur3 = ((Date.now() - t3) / 1000).toFixed(1);
    if (result.status === "completed") {
      console.log(`  Embeddings treinados : ${result.embeddingsTrained}`);
      console.log(`  Sinergias atualizadas: ${result.synergiesUpdated}`);
      console.log(`  Duracao              : ${dur3}s`);
    } else {
      console.warn(`  [AVISO] Embeddings: ${result.error}`);
    }
  } catch (e: any) {
    console.warn(`  [AVISO] Embeddings falhou: ${e?.message}. Continuando...`);
  }

  // ─── Resumo Final ─────────────────────────────────
  const totalDur = ((Date.now() - startTotal) / 1000).toFixed(1);
  console.log("\n" + "=".repeat(52));
  console.log(`  CONCLUIDO em ${totalDur}s -- ${timestamp()}`);
  console.log("=".repeat(52) + "\n");

  clearTimeout(GLOBAL_TIMEOUT);
  process.exit(0);
}

main().catch((e) => {
  console.error("[import-and-train] Erro fatal:", e?.message);
  process.exit(0);
});
