import { generateDeckByArchetype, CardData } from "../services/archetypeGenerator";
import { closeDb } from "../db";
import { searchCards } from "../services/scryfall";
import { modelLearningService } from "../services/modelLearning";
import { ModelEvaluator } from "../services/modelEvaluation";
import { evaluateDeckWithBrain } from "../services/deckGenerator";

/**
 * Script de Treinamento Especializado em Comandantes
 * Foca em evoluir a escolha do Comandante via ciclos de geracao, simulacao e reforco.
 */

function barCmd(current: number, total: number, width = 18): string {
  const filled = total > 0 ? Math.round((current / total) * width) : 0;
  return "[" + "#".repeat(filled) + "-".repeat(width - filled) + "]";
}

function timestampCmd(): string {
  return new Date().toLocaleTimeString("pt-BR");
}

async function trainCommander(iterations = 300) {
  const startTotal = Date.now();
  console.log("=".repeat(52));
  console.log(`  COMMANDER INTELLIGENCE (${iterations} iteracoes)`);
  console.log(`  Inicio: ${timestampCmd()}`);
  console.log("=".repeat(52));

  console.log("\n  Carregando pool de cartas (Arena + Fisico)...");
  const cardPool = await searchCards({ isArena: false });
  if (cardPool.length === 0) {
    console.error("  [ERRO] Banco de dados vazio. Sincronize o Scryfall primeiro.");
    closeDb().then(() => process.exit(1)).catch(() => process.exit(1));
  }
  console.log(`  Pool carregado: ${cardPool.length} cartas`);

  const archetypes: any[] = ["aggro", "control", "midrange", "combo", "ramp"];
  const batchSize = 5;
  let totalWins = 0;
  let totalMatches = 0;

  for (let i = 0; i < iterations; i += batchSize) {
    const progBar = barCmd(Math.min(i + batchSize, iterations), iterations);
    process.stdout.write(`\r  ${progBar} ${Math.min(i + batchSize, iterations)}/${iterations} | wins: ${totalWins}/${totalMatches} | ${timestampCmd()}`);

    const batch = Array.from({ length: Math.min(batchSize, iterations - i) }, (_, index) => {
      const itIndex = i + index;
      const archetype = archetypes[itIndex % archetypes.length];
      return runIteration(itIndex, archetype, cardPool).then((r: any) => {
        if (r) { totalWins += r.wins; totalMatches += r.matches; }
      });
    });
    await Promise.all(batch);
  }

  process.stdout.write("\n");

  const totalDur = ((Date.now() - startTotal) / 1000).toFixed(1);
  const winratePct = totalMatches > 0 ? ((totalWins / totalMatches) * 100).toFixed(1) : "N/A";
  console.log("\n" + "=".repeat(52));
  console.log("  COMMANDER INTELLIGENCE CONCLUIDO");
  console.log(`  Iteracoes     : ${iterations}`);
  console.log(`  Partidas      : ${totalMatches}`);
  console.log(`  Vitorias      : ${totalWins} (${winratePct}%)`);
  console.log(`  Duracao total : ${totalDur}s`);
  console.log(`  Fim: ${timestampCmd()}`);
  console.log("=".repeat(52) + "\n");
  closeDb().then(() => process.exit(0)).catch(() => process.exit(0));
}

async function runIteration(i: number, archetype: string, cardPool: CardData[]): Promise<{ wins: number; matches: number } | null> {

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
    return null;
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

  // source="commander_train" para rastreabilidade e roteamento pela fila
  await modelLearningService.updateWeights(updates, "commander_train");
  return { wins, matches };
}

trainCommander().catch((e) => {
  console.error("[trainCommander] Erro fatal:", e?.message);
  closeDb().then(() => process.exit(0)).catch(() => process.exit(0));
});
