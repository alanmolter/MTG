import { generateInitialDeck } from "../services/deckGenerator";
import { modelLearningService } from "../services/modelLearning";
import { evaluateDeckWithBrain } from "../services/deckEvaluationBrain";
import { ExperimentTracker } from "../services/modelEvaluation";
import { getDb } from "../db";
import { cards } from "../../drizzle/schema";

/**
 * Script de Loop de Treinamento Contínuo (Self-Improving IA)
 * 
 * Este script automatiza o loop: Gerar -> Avaliar -> Selecionar -> Evoluir -> Self-Play -> Aprender.
 */

async function runContinuousTraining(iterations: number = 100) {
  console.log(`🚀 Iniciando Loop de Treinamento Contínuo (${iterations} iterações)...`);
  
  const archetypes = ["aggro", "control", "midrange", "combo", "ramp"];
  const database = await getDb();
  if (!database) return;
  
  const cardPool = await database.select().from(cards).limit(2000);

  for (let it = 1; it <= iterations; it++) {
    console.log(`\n🔄 Iteração [${it}/${iterations}] ───────────────────────`);
    
    // Processar arquétipos em paralelo
    const archPromises = archetypes.map(async (arch) => {
      console.log(`   [${arch.toUpperCase()}] Gerando população inicial...`);
      
      // 1. Gerar População
      const population: { deck: any[], score: number }[] = [];
      const deckPromises = Array.from({ length: 20 }, async () => {
        const deck = await generateInitialDeck({ format: "standard", archetype: arch as any });
        const evalResult = await evaluateDeckWithBrain(deck, arch);
        return { deck, score: evalResult.normalizedScore };
      });
      
      const results = await Promise.all(deckPromises);
      population.push(...results);

      // 2. Seleção (Top 25%)
      population.sort((a, b) => b.score - a.score);
      const elite = population.slice(0, 5);
      console.log(`   [${arch}] Melhor Score: ${elite[0].score}`);

      // 3. Evolução (Mutação e Crossover)
      const nextGen: any[][] = elite.map(e => e.deck);
      for (let i = 0; i < 15; i++) {
        const parentA = elite[Math.floor(Math.random() * elite.length)].deck;
        const parentB = elite[Math.floor(Math.random() * elite.length)].deck;
        
        // Crossover
        let child = modelLearningService.crossover(parentA, parentB);
        // Mutação
        child = modelLearningService.mutate(child, cardPool);
        
        nextGen.push(child);
      }

      // 4. Self-Play (Cálculo de Winrate Real entre eles)
      console.log(`   [${arch}] Iniciando Sessão de Self-Play...`);
      await modelLearningService.runSelfPlaySession(nextGen);

      // 5. Aprender (Pesos já atualizados pelo runSelfPlaySession)
      console.log(`   [${arch}] Aprendizado concluído.`);
    });

    await Promise.all(archPromises);

    // Tracking do Progresso
    ExperimentTracker.logExperiment(`Training Loop It ${it}`, {
      status: "completed",
      iteration: it
    });
  }

  console.log("\n✅ Treinamento Contínuo Finalizado com Sucesso!");
  process.exit(0);
}

runContinuousTraining().catch(console.error);
