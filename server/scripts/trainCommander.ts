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
async function trainCommander(iterations = 100) {
  console.log(`\n🎓 Iniciando Treinamento de Comandantes (${iterations} iterações)...\n`);
  
  const cardPool = await searchCards({ isArena: true });
  if (cardPool.length === 0) {
    console.error("❌ Erro: Banco de dados vazio. Sincronize o Scryfall primeiro.");
    return;
  }

  const archetypes: any[] = ["aggro", "control", "midrange", "combo"];
  
  for (let i = 0; i < iterations; i++) {
    const archetype = archetypes[i % archetypes.length];
    console.log(`\n🔄 Iteração [${i + 1}/${iterations}] - Foco: ${archetype.toUpperCase()}`);
    
    // 1. Carregar pesos atuais
    const learnedWeights = await modelLearningService.getCardWeights();
    
    // 2. Gerar Deck de Commander 
    const result = generateDeckByArchetype(cardPool, {
      archetype,
      format: "commander",
      learnedWeights
    });

    const commander = result.cards.find(c => c.role === "commander");
    if (!commander) {
      console.log("⚠️  Nenhum comandante elegível encontrado nesta rodada.");
      continue;
    }

    console.log(`👑 Comandante Escolhido: ${commander.name}`);

    // 3. Avaliação Inicial pelo Cérebro
    const metrics = await evaluateDeckWithBrain(result.cards as any, archetype);
    console.log(`📈 Score Inicial do Cérebro: ${metrics.normalizedScore?.toFixed(0)}/100`);

    // 4. Simulação de Combate (Self-Play)
    // Criamos um oponente fixo (standard aggro) para benchmark
    const opponent = await generateDeckByArchetype(cardPool, { archetype: "aggro", format: "standard" });
    
    let wins = 0;
    const matches = 5;
    for (let m = 0; m < matches; m++) {
      const simResult = ModelEvaluator.simulateMatch(result.cards as any, opponent.cards as any);
      if (simResult.winner === "A") wins++;
    }

    const winrate = wins / matches;
    console.log(`⚔️  Self-Play Winrate: ${(winrate * 100).toFixed(0)}%`);

    // 5. APRENDIZADO DE REFORÇO
    // Se o comandante performou bem, damos um boost pesado no peso dele
    const weightDelta = winrate > 0.5 ? 0.2 : -0.1;
    
    const updates: any = {};
    updates[commander.name] = { 
      weightDelta: weightDelta * 2, // Peso DOBRADO para comandantes
      win: winrate > 0.5,
      scoreDelta: metrics.normalizedScore
    };

    // Também atualizamos as outras cartas do deck levemente
    result.cards.forEach(c => {
      if (c.role !== "commander") {
        updates[c.name] = { weightDelta: weightDelta * 0.1, win: winrate > 0.5 };
      }
    });

    await modelLearningService.updateWeights(updates);
    console.log(`🧠 Conhecimento persistido: ${commander.name} -> delta ${weightDelta > 0 ? "+" : ""}${weightDelta}`);
  }

  console.log("\n✅ Treinamento de Comandantes concluído com sucesso!");
  process.exit(0);
}

trainCommander().catch(console.error);
