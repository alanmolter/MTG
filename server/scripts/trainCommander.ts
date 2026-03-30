import { generateDeckByArchetype, CardData } from "../services/archetypeGenerator";
import { searchCards } from "../services/scryfall";
import { modelLearningService } from "../services/modelLearning";
import { ModelEvaluator } from "../services/modelEvaluation";
import { evaluateDeckWithBrain } from "../services/deckGenerator";

/**
 * Script de Treinamento Especializado em Comandantes
 * 
 * Este script foca exclusivamente em evoluir a escolha do Comandante
 * através de ciclos de geração, simulação e reforço.
 */
async function trainCommander(iterations = 300) {
  console.log(`\n🎓 Iniciando Treinamento de Comandantes (${iterations} iterações)...\n`);

  // Pegamos tudo (Arena e Físico) para garantir que cobrimos todos os modos
  const cardPool = await searchCards({ isArena: false });
  if (cardPool.length === 0) {
    console.error("❌ Erro: Banco de dados vazio. Sincronize o Scryfall primeiro.");
    return;
  }

  const archetypes: any[] = ["aggro", "control", "midrange", "combo", "ramp"];
  const batchSize = 5; // Rodar 5 simulações em paralelo

  for (let i = 0; i < iterations; i += batchSize) {
    const batch = Array.from({ length: Math.min(batchSize, iterations - i) }, (_, index) => {
      const itIndex = i + index;
      const archetype = archetypes[itIndex % archetypes.length];
      return runIteration(itIndex, archetype, cardPool);
    });

    await Promise.all(batch);
  }

  console.log("\n✅ Treinamento de Comandantes concluído com sucesso!");
  process.exit(0);
}

async function runIteration(i: number, archetype: string, cardPool: CardData[]) {
  console.log(`\n🔄 Iteração [${i + 1}] - Foco: ${archetype.toUpperCase()}`);

  // 1. Carregar pesos atuais
  const learnedWeights = await modelLearningService.getCardWeights();

  // 2. Gerar Deck de Commander 
  const result = generateDeckByArchetype(cardPool, {
    archetype: archetype as any,
    format: "commander",
    learnedWeights
  });

  const commander = result.cards.find(c => c.role === "commander");
  if (!commander) {
    console.log(`⚠️  [${archetype}] Nenhum comandante elegível encontrado.`);
    return;
  }

  // 3. Avaliação Inicial pelo Cérebro
  const metrics = await evaluateDeckWithBrain(result.cards as any, archetype as any);

  // 4. Simulação de Combate (Self-Play)
  const opponent = await generateDeckByArchetype(cardPool, { archetype: "aggro", format: "standard" });

  let wins = 0;
  const matches = 5;
  for (let m = 0; m < matches; m++) {
    const simResult = ModelEvaluator.simulateMatch(result.cards as any, opponent.cards as any);
    if (simResult.winner === "A") wins++;
  }

  const winrate = wins / matches;
  console.log(`👑 [${archetype}] ${commander.name} | Winrate: ${(winrate * 100).toFixed(0)}% | Score: ${metrics.normalizedScore?.toFixed(0)}`);

  // 5. APRENDIZADO DE REFORÇO
  const weightDelta = winrate > 0.5 ? 0.2 : -0.1;
  const updates: any = {};
  updates[commander.name] = {
    weightDelta: weightDelta * 2.5, // Peso pesado para comandantes
    win: winrate > 0.5,
    scoreDelta: metrics.normalizedScore
  };

  result.cards.forEach(c => {
    if (c.role !== "commander") {
      updates[c.name] = { weightDelta: weightDelta * 0.1, win: winrate > 0.5 };
    }
  });

  // CORREÇÃO: source="commander_train" para rastreabilidade e roteamento pela fila
  await modelLearningService.updateWeights(updates, "commander_train");
}

trainCommander().catch(console.error);
