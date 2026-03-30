import { generateInitialDeck } from "../services/deckGenerator";
import { modelLearningService } from "../services/modelLearning";
import { evaluateDeckWithBrain } from "../services/deckEvaluationBrain";
import { ExperimentTracker } from "../services/modelEvaluation";
import { getDb } from "../db";
import { cards } from "../../drizzle/schema";

/**
 * Script de Loop de Treinamento Contínuo (Self-Improving IA)
 * Loop: Gerar -> Avaliar -> Selecionar -> Evoluir -> Self-Play -> Aprender
 */

function bar(current: number, total: number, width = 20): string {
  const filled = total > 0 ? Math.round((current / total) * width) : 0;
  return "[" + "#".repeat(filled) + "-".repeat(width - filled) + "]";
}

function timestamp(): string {
  return new Date().toLocaleTimeString("pt-BR");
}

async function runContinuousTraining(iterations: number = 100) {
  const startTotal = Date.now();
  console.log("=".repeat(52));
  console.log(`  SELF-PLAY LOOP (${iterations} iteracoes)`);
  console.log(`  Inicio: ${timestamp()}`);
  console.log("=".repeat(52));

  const archetypes = ["aggro", "control", "midrange", "combo", "ramp"];
  const database = await getDb();
  if (!database) {
    console.error("  [ERRO] Banco nao disponivel. Abortando.");
    process.exit(1);
  }

  console.log("\n  Carregando pool de cartas (limite: 2000)...");
  const cardPool = await database.select().from(cards).limit(2000);
  console.log(`  Pool carregado: ${cardPool.length} cartas`);
  console.log(`  Arquetipos   : ${archetypes.join(", ")}`);
  console.log(`  Iteracoes    : ${iterations}`);

  let totalDecksGerados = 0;
  let totalSelfPlaySessoes = 0;
  let melhorScore = 0;

  for (let it = 1; it <= iterations; it++) {
    const progBar = bar(it, iterations);
    process.stdout.write(`\r  ${progBar} ${it}/${iterations} it | melhor: ${melhorScore.toFixed(3)} | ${timestamp()}`);

    const archPromises = archetypes.map(async (arch) => {
      // 1. Gerar Populacao
      const population: { deck: any[]; score: number }[] = [];
      const deckPromises = Array.from({ length: 20 }, async () => {
        const deck = await generateInitialDeck({ format: "standard", archetype: arch as any });
        const evalResult = await evaluateDeckWithBrain(deck, arch);
        return { deck, score: evalResult.normalizedScore };
      });

      const results = await Promise.all(deckPromises);
      population.push(...results);
      totalDecksGerados += results.length;

      // 2. Selecao (Top 25%)
      population.sort((a, b) => b.score - a.score);
      const elite = population.slice(0, 5);

      if (elite[0].score > melhorScore) {
        melhorScore = elite[0].score;
      }

      // 3. Evolucao (Mutacao e Crossover)
      const nextGen: any[][] = elite.map((e) => e.deck);
      for (let i = 0; i < 15; i++) {
        const parentA = elite[Math.floor(Math.random() * elite.length)].deck;
        const parentB = elite[Math.floor(Math.random() * elite.length)].deck;
        let child = modelLearningService.crossover(parentA, parentB);
        child = modelLearningService.mutate(child, cardPool);
        nextGen.push(child);
      }

      // 4. Self-Play
      await modelLearningService.runSelfPlaySession(nextGen);
      totalSelfPlaySessoes++;
    });

    await Promise.all(archPromises);

    ExperimentTracker.logExperiment(`Training Loop It ${it}`, {
      status: "completed",
      iteration: it,
    });
  }

  // Linha final limpa apos a barra de progresso
  process.stdout.write("\n");

  const totalDur = ((Date.now() - startTotal) / 1000).toFixed(1);
  console.log("\n" + "=".repeat(52));
  console.log("  SELF-PLAY CONCLUIDO");
  console.log(`  Iteracoes completas  : ${iterations}`);
  console.log(`  Decks gerados        : ${totalDecksGerados}`);
  console.log(`  Sessoes self-play    : ${totalSelfPlaySessoes}`);
  console.log(`  Melhor score visto   : ${melhorScore.toFixed(4)}`);
  console.log(`  Duracao total        : ${totalDur}s`);
  console.log(`  Fim: ${timestamp()}`);
  console.log("=".repeat(52) + "\n");

  process.exit(0);
}

runContinuousTraining().catch((e) => {
  console.error("[continuousTraining] Erro fatal:", e?.message);
  process.exit(0);
});
