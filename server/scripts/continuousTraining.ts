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
  
  const archetypes = ["aggro", "control", "midrange", "combo"];
  const database = await getDb();
  if (!database) return;
  
  const cardPool = await database.select().from(cards).limit(1000);

  for (let it = 1; it <= iterations; it++) {
    console.log(`\n🔄 Iteração [${it}/${iterations}] ───────────────────────`);
    
    for (const arch of archetypes) {
      console.log(`   [${arch.toUpperCase()}] Gerando população inicial...`);
      
      // 1. Gerar População
      const population: { deck: any[], score: number }[] = [];
      for (let i = 0; i < 20; i++) {
        const deck = await generateInitialDeck({ format: "standard", archetype: arch });
        const evalResult = await evaluateDeckWithBrain(deck, arch);
        population.push({ deck, score: evalResult.normalizedScore });
      }

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
      console.log(`   [${arch}] Aprendizado concluído e pesos atualizados.`);
    }

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
