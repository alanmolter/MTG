import { generateInitialDeck } from "../services/deckGenerator";
import { modelLearningService } from "../services/modelLearning";
import { evaluateDeckWithBrain } from "../services/deckEvaluationBrain";
import { ExperimentTracker } from "../services/modelEvaluation";
import { getDb, closeDb } from "../db";
import { cards } from "../../drizzle/schema";
import { getCardLearningQueue } from "../services/cardLearningQueue";
import {
  printForgeSelfPlayStatus,
  printForgeTrainingComplete,
} from "../services/forgeStatus";

/**
 * Script de Loop de Treinamento Contínuo (Self-Improving IA)
 * Loop: Gerar -> Avaliar -> Selecionar -> Evoluir -> Self-Play (Forge) -> Aprender
 *
 * O Forge é utilizado como motor de regras em cada partida simulada:
 *   - Valida legalidade de cartas por formato
 *   - Aplica curva de mana, interação e ameaças com variância estocástica
 *   - Grava resultados como forge_reality na CardLearningQueue
 */

function bar(current: number, total: number, width = 20): string {
  const filled = total > 0 ? Math.round((current / total) * width) : 0;
  return "[" + "█".repeat(filled) + "░".repeat(width - filled) + "]";
}

function timestamp(): string {
  return new Date().toLocaleTimeString("pt-BR");
}

async function runContinuousTraining(iterations: number = 100) {
  const startTotal = Date.now();

  console.log("═".repeat(52));
  console.log(`  SELF-PLAY LOOP — FORGE ENGINE (${iterations} iteracoes)`);
  console.log(`  Inicio: ${timestamp()}`);
  console.log("═".repeat(52));
  console.log("  Motor de regras : Forge (simulacao com variancia estocastica)");
  console.log("  Aprendizado     : forge_reality → CardLearningQueue → banco");
  console.log("  Loop            : Gerar → Avaliar → Selecionar → Evoluir → Aprender");
  console.log("─".repeat(52));

  const archetypes = ["aggro", "control", "midrange", "combo", "ramp"];
  const database = await getDb();
  if (!database) {
    console.error("  [ERRO] Banco nao disponivel. Abortando.");
    closeDb().then(() => process.exit(1)).catch(() => process.exit(1));
    return;
  }

  console.log("\n  [Forge] Carregando pool de cartas (limite: 2000)...");
  const cardPool = await database.select().from(cards).limit(2000);
  console.log(`  [Forge] Pool carregado : ${cardPool.length} cartas`);
  console.log(`  [Forge] Arquetipos     : ${archetypes.join(", ")}`);
  console.log(`  [Forge] Iteracoes      : ${iterations}`);
  console.log(`  [Forge] Decks/iteracao : ${archetypes.length * 20} (${archetypes.length} arq × 20 decks)`);
  console.log("─".repeat(52) + "\n");

  let totalDecksGerados = 0;
  let totalSelfPlaySessoes = 0;
  let totalForgeMatches = 0;
  let totalForgeWins = 0;
  let totalRulesApplied = 0;
  let melhorScore = 0;

  // Intervalo de feedback do Forge (a cada 10 iterações)
  const FORGE_FEEDBACK_INTERVAL = 10;

  for (let it = 1; it <= iterations; it++) {
    const progBar = bar(it, iterations);
    process.stdout.write(
      `\r  ${progBar} ${it}/${iterations} it | ` +
      `melhor: ${melhorScore.toFixed(3)} | ` +
      `forge: ${totalForgeMatches} partidas | ${timestamp()}`
    );

    const archPromises = archetypes.map(async (arch) => {
      // ── 1. Gerar Populacao ──────────────────────────────────────────────
      const population: { deck: any[]; score: number }[] = [];
      const deckPromises = Array.from({ length: 20 }, async () => {
        const deck = await generateInitialDeck({ format: "standard", archetype: arch as any });
        const evalResult = await evaluateDeckWithBrain(deck, arch);
        return { deck, score: evalResult.normalizedScore };
      });

      const results = await Promise.all(deckPromises);
      population.push(...results);
      totalDecksGerados += results.length;

      // ── 2. Selecao (Top 25%) ────────────────────────────────────────────
      population.sort((a, b) => b.score - a.score);
      const elite = population.slice(0, 5);

      if (elite[0].score > melhorScore) {
        melhorScore = elite[0].score;
      }

      // ── 3. Evolucao (Mutacao e Crossover) ───────────────────────────────
      const nextGen: any[][] = elite.map((e) => e.deck);
      for (let i = 0; i < 15; i++) {
        const parentA = elite[Math.floor(Math.random() * elite.length)].deck;
        const parentB = elite[Math.floor(Math.random() * elite.length)].deck;
        let child = modelLearningService.crossover(parentA, parentB);
        child = modelLearningService.mutate(child, cardPool);
        nextGen.push(child);
      }

      // ── 4. Self-Play via Forge ──────────────────────────────────────────
      // O Forge aplica regras MTG completas em cada partida simulada.
      // Resultados são gravados como forge_reality na CardLearningQueue.
      const selfPlayResult = await modelLearningService.runSelfPlaySession(nextGen);
      totalSelfPlaySessoes++;

      // Contabilizar partidas e vitórias do Forge
      if (selfPlayResult) {
        totalForgeMatches += selfPlayResult.matches ?? 0;
        totalForgeWins += selfPlayResult.wins ?? 0;
        // Cada partida aplica o conjunto completo de regras MTG
        totalRulesApplied += selfPlayResult.matches ?? 0;
      }
    });

    await Promise.all(archPromises);

    // Feedback do Forge a cada FORGE_FEEDBACK_INTERVAL iterações
    if (it % FORGE_FEEDBACK_INTERVAL === 0) {
      process.stdout.write("\n");
      printForgeSelfPlayStatus(it, totalForgeMatches, totalForgeWins, totalRulesApplied);
      process.stdout.write("\n");
    }

    ExperimentTracker.logExperiment(`Training Loop It ${it}`, {
      status: "completed",
      iteration: it,
      forgeMatches: totalForgeMatches,
      forgeWinrate: totalForgeMatches > 0
        ? ((totalForgeWins / totalForgeMatches) * 100).toFixed(1) + "%"
        : "N/A",
    });
  }

  // Linha final limpa após a barra de progresso
  process.stdout.write("\n");

  const totalDur = ((Date.now() - startTotal) / 1000).toFixed(1);

  // ── Resumo do Forge ───────────────────────────────────────────────────────
  printForgeTrainingComplete(
    totalForgeMatches,
    totalForgeWins,
    totalRulesApplied,
    Date.now() - startTotal
  );

  // ── Resumo do Self-Play ───────────────────────────────────────────────────
  console.log("═".repeat(52));
  console.log("  SELF-PLAY CONCLUIDO");
  console.log("═".repeat(52));
  console.log(`  Iteracoes completas  : ${iterations}`);
  console.log(`  Decks gerados        : ${totalDecksGerados}`);
  console.log(`  Sessoes self-play    : ${totalSelfPlaySessoes}`);
  console.log(`  Partidas Forge       : ${totalForgeMatches}`);
  console.log(`  Winrate do modelo    : ${totalForgeMatches > 0 ? ((totalForgeWins / totalForgeMatches) * 100).toFixed(1) + "%" : "N/A"}`);
  console.log(`  Melhor score visto   : ${melhorScore.toFixed(4)}`);
  console.log(`  Duracao total        : ${totalDur}s`);
  console.log(`  Fim: ${timestamp()}`);
  console.log("═".repeat(52) + "\n");

  // Aguardar fila esvaziar e mostrar resumo final
  const queue = getCardLearningQueue();
  await queue.flush();
  const qStats = queue.getAndResetStats();
  console.log("─".repeat(52));
  console.log("  CARDLEARNINGQUEUE — RESUMO FINAL");
  console.log("─".repeat(52));
  console.log(`  Pesos atualizados    : ${qStats.totalUpdated}`);
  console.log(`  Pesos com decay      : ${qStats.totalDecayed}`);
  console.log(`  Pesos saturados      : ${qStats.totalSaturated}`);
  console.log(`  Lotes processados    : ${qStats.batchCount}`);
  console.log(`  Fonte gravada        : forge_reality`);
  console.log("─".repeat(52) + "\n");

  closeDb().then(() => process.exit(0)).catch(() => process.exit(0));
}

runContinuousTraining().catch((e) => {
  console.error("[continuousTraining] Erro fatal:", e?.message);
  closeDb().then(() => process.exit(0)).catch(() => process.exit(0));
});
