import "dotenv/config";
import { closeDb } from "./server/db.ts";
import { importAllGoldfishFormats } from "./server/services/mtggoldfishScraper.ts";
import { importAllTop8Formats } from "./server/services/mtgtop8Scraper.ts";
import { trainEmbeddingsFromDecks } from "./server/services/embeddingTrainer.ts";
import { applyTournamentSignal } from "./server/scripts/applyTournamentSignal.ts";

/**
 * Pipeline de importação de decks competitivos + treinamento de embeddings.
 *
 * FORMATOS IMPORTADOS (10 decks cada):
 *   MTGGoldfish : standard, modern, legacy, pioneer, pauper, vintage
 *   MTGTop8     : standard, modern, legacy, pioneer, pauper, vintage
 *
 * Total máximo: 120 decks (60 por fonte × 2 fontes)
 *
 * ESTRATÉGIA:
 *   - 1 deck por arquétipo = máxima diversidade de estratégias
 *   - Downloads paralelos em batches de 3 (evita rate-limit)
 *   - Delay de 500-600ms entre batches
 *   - Delay de 1s entre formatos
 */

// Timeout global de 15 minutos (120 decks × ~3.5s cada + delays)
const GLOBAL_TIMEOUT = setTimeout(() => {
  console.log("\n[import-and-train] Timeout global atingido (15min). Encerrando...");
  closeDb().then(() => process.exit(0)).catch(() => process.exit(0));
}, 15 * 60 * 1000);
GLOBAL_TIMEOUT.unref();

function divider(label: string) {
  const line = "═".repeat(56);
  console.log(`\n${line}`);
  console.log(`  ${label}`);
  console.log(line);
}

function timestamp(): string {
  return new Date().toLocaleTimeString("pt-BR");
}

async function main() {
  const startTotal = Date.now();

  console.log("═".repeat(56));
  console.log("  IMPORTACAO DE DECKS COMPETITIVOS + EMBEDDINGS");
  console.log(`  Inicio: ${timestamp()}`);
  console.log("═".repeat(56));
  console.log("  Fontes  : MTGGoldfish + MTGTop8");
  console.log("  Formatos: standard, modern, legacy, pioneer, pauper, vintage");
  console.log("  Volume  : 10 decks por formato por fonte (máx. 120 decks)");
  console.log("  Método  : 1 deck/arquétipo → máxima diversidade de estratégias");
  console.log("─".repeat(56));

  // ─── 1. MTGGoldfish — todos os formatos ───────────────────────────────────
  divider("1/3  MTGGoldfish — 6 Formatos (10 decks cada)");
  const t1 = Date.now();
  let goldfishTotal = { decksImported: 0, cardsImported: 0, decksSkipped: 0, errors: [] as string[] };
  try {
    goldfishTotal = await importAllGoldfishFormats(10);
    const dur1 = ((Date.now() - t1) / 1000).toFixed(1);
    console.log("─".repeat(56));
    console.log(`  MTGGoldfish RESUMO:`);
    console.log(`    Decks importados : ${goldfishTotal.decksImported}`);
    console.log(`    Decks pulados    : ${goldfishTotal.decksSkipped}`);
    console.log(`    Cartas salvas    : ${goldfishTotal.cardsImported}`);
    console.log(`    Duracao total    : ${dur1}s`);
    if (goldfishTotal.errors.length > 0) {
      console.warn(`    Avisos (${goldfishTotal.errors.length}): ${goldfishTotal.errors.slice(0, 3).join(" | ")}`);
    }
  } catch (e: any) {
    console.warn(`  [AVISO] MTGGoldfish falhou: ${e?.message}. Continuando...`);
  }

  // ─── 2. MTGTop8 — todos os formatos ──────────────────────────────────────
  divider("2/3  MTGTop8 — 6 Formatos (10 decks cada)");
  const t2 = Date.now();
  let top8Total = { decksImported: 0, cardsImported: 0, decksSkipped: 0, errors: [] as string[] };
  try {
    top8Total = await importAllTop8Formats(10);
    const dur2 = ((Date.now() - t2) / 1000).toFixed(1);
    console.log("─".repeat(56));
    console.log(`  MTGTop8 RESUMO:`);
    console.log(`    Decks importados : ${top8Total.decksImported}`);
    console.log(`    Decks pulados    : ${top8Total.decksSkipped}`);
    console.log(`    Cartas salvas    : ${top8Total.cardsImported}`);
    console.log(`    Duracao total    : ${dur2}s`);
    if (top8Total.errors.length > 0) {
      console.warn(`    Avisos (${top8Total.errors.length}): ${top8Total.errors.slice(0, 3).join(" | ")}`);
    }
  } catch (e: any) {
    console.warn(`  [AVISO] MTGTop8 falhou: ${e?.message}. Continuando...`);
  }

  // ─── 3. Sinal de torneio → card_learning ─────────────────────────────────
  divider("3/4  Sinal de Torneio → card_learning (pesos reais)");
  const t3 = Date.now();
  try {
    const signalResult = await applyTournamentSignal();
    const dur3 = ((Date.now() - t3) / 1000).toFixed(1);
    console.log(`    Cartas reforçadas : ${signalResult.cardsReinforced}`);
    console.log(`    Delta total       : +${signalResult.totalDelta.toFixed(2)}`);
    console.log(`    Decks processados : ${signalResult.decksProcessed}`);
    console.log(`    Duracao           : ${dur3}s`);
  } catch (e: any) {
    console.warn(`  [AVISO] Sinal de torneio falhou: ${e?.message}. Continuando...`);
  }

  // ─── 4. Embeddings Word2Vec ───────────────────────────────────────────────
  divider("4/4  Treinamento de Embeddings Word2Vec");
  const t4 = Date.now();
  console.log("  Carregando decks competitivos do banco para treinamento...");
  try {
    const result = await trainEmbeddingsFromDecks();
    const dur3 = ((Date.now() - t4) / 1000).toFixed(1);
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

  // ─── Resumo Final ─────────────────────────────────────────────────────────
  const totalDur = ((Date.now() - startTotal) / 1000).toFixed(1);
  const totalDecks = goldfishTotal.decksImported + top8Total.decksImported;
  const totalCards = goldfishTotal.cardsImported + top8Total.cardsImported;

  console.log("\n" + "═".repeat(56));
  console.log("  IMPORTACAO CONCLUIDA");
  console.log("═".repeat(56));
  console.log(`  MTGGoldfish    : ${goldfishTotal.decksImported} decks | ${goldfishTotal.cardsImported} cartas`);
  console.log(`  MTGTop8        : ${top8Total.decksImported} decks | ${top8Total.cardsImported} cartas`);
  console.log(`  TOTAL          : ${totalDecks} decks | ${totalCards} cartas`);
  console.log(`  Duracao total  : ${totalDur}s`);
  console.log(`  Fim: ${timestamp()}`);
  console.log("═".repeat(56) + "\n");

  clearTimeout(GLOBAL_TIMEOUT);
  closeDb().then(() => process.exit(0)).catch(() => process.exit(0));
}

main().catch((e) => {
  console.error("[import-and-train] Erro fatal:", e?.message);
  closeDb().then(() => process.exit(0)).catch(() => process.exit(0));
});
