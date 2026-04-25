import { getDb, closeDb } from "../db";
import { cardLearning, cards as cardsTable } from "../../drizzle/schema";
import { count, gt, gte, lt, and, eq, sql } from "drizzle-orm";
import { spawn } from "child_process";
import {
  printForgeStartupBanner,
  printForgeConnectionStatus,
  printForgeRulesLearning,
} from "../services/forgeStatus";
import { describeTrainingPool, isArenaOnlyTraining } from "./utils/poolFilter";

/**
 * MASTER BRAIN TRAINING SCRIPT
 * Executa Commander Intelligence + Archetype Continuous Training em sequencia.
 * Inclui feedback visual completo sobre o Forge e dados do banco antes do treinamento.
 */

function divider(label: string) {
  const line = "─".repeat(52);
  console.log(`\n${line}`);
  console.log(`  ${label}`);
  console.log(line);
}

function timestamp(): string {
  return new Date().toLocaleTimeString("pt-BR");
}

function bar(value: number, max: number, width = 20): string {
  const filled = max > 0 ? Math.round((value / max) * width) : 0;
  return "[" + "█".repeat(filled) + "░".repeat(width - filled) + "]";
}

function pct(value: number, total: number): string {
  return total > 0 ? ((value / total) * 100).toFixed(1) + "%" : "0.0%";
}

async function reportBrainDataStatus(db: any): Promise<void> {
  console.log("\n" + "═".repeat(52));
  console.log("  CEREBRO — DADOS DE INTELIGENCIA NO BANCO");
  console.log("═".repeat(52));

  // Total de cartas no banco de aprendizado
  const [{ value: totalCards }] = await db
    .select({ value: count() })
    .from(cardLearning);

  const total = Number(totalCards);

  if (total === 0) {
    console.log("  [AVISO] Banco de inteligencia vazio.");
    console.log("  O modelo iniciara do zero sem dados previos.");
    console.log("  O Forge ira gerar os primeiros dados de treinamento.");
    console.log("═".repeat(52) + "\n");
    return;
  }

  // Breakdown por faixa de peso
  const [{ value: highWeight }] = await db
    .select({ value: count() })
    .from(cardLearning)
    .where(gte(cardLearning.weight, 10.0));

  const [{ value: midWeight }] = await db
    .select({ value: count() })
    .from(cardLearning)
    .where(and(gte(cardLearning.weight, 2.0), lt(cardLearning.weight, 10.0)));

  const [{ value: baseWeight }] = await db
    .select({ value: count() })
    .from(cardLearning)
    .where(and(gte(cardLearning.weight, 0.5), lt(cardLearning.weight, 2.0)));

  const [{ value: lowWeight }] = await db
    .select({ value: count() })
    .from(cardLearning)
    .where(lt(cardLearning.weight, 0.5));

  // Cartas com histórico de vitórias/derrotas
  const [{ value: withWins }] = await db
    .select({ value: count() })
    .from(cardLearning)
    .where(gt(cardLearning.winCount, 0));

  const [{ value: withLosses }] = await db
    .select({ value: count() })
    .from(cardLearning)
    .where(gt(cardLearning.lossCount, 0));

  const [{ value: withScore }] = await db
    .select({ value: count() })
    .from(cardLearning)
    .where(gt(cardLearning.avgScore, 0));

  // Peso médio geral
  const [{ avgW }] = await db
    .select({ avgW: sql<number>`AVG(${cardLearning.weight})` })
    .from(cardLearning);

  // Top 5 cartas por peso
  const topCards = await db
    .select({
      cardName: cardLearning.cardName,
      weight: cardLearning.weight,
      winCount: cardLearning.winCount,
      lossCount: cardLearning.lossCount,
    })
    .from(cardLearning)
    .orderBy(sql`${cardLearning.weight} DESC`)
    .limit(5);

  const avgWeight = Number(avgW || 0).toFixed(3);

  console.log(`\n  Conexao com banco de inteligencia : OK`);
  console.log(`  Total de cartas aprendidas        : ${total}`);
  console.log(`  Peso medio geral                  : ${avgWeight}`);
  console.log(`  Cartas com historico de vitorias  : ${withWins} (${pct(Number(withWins), total)})`);
  console.log(`  Cartas com historico de derrotas  : ${withLosses} (${pct(Number(withLosses), total)})`);
  console.log(`  Cartas com score calculado        : ${withScore} (${pct(Number(withScore), total)})`);

  console.log("\n  DISTRIBUICAO DE PESOS:");
  console.log(`  Alta relevancia  (>= 10.0) : ${bar(Number(highWeight), total)} ${highWeight} (${pct(Number(highWeight), total)})`);
  console.log(`  Media relevancia (2.0-9.9) : ${bar(Number(midWeight), total)} ${midWeight} (${pct(Number(midWeight), total)})`);
  console.log(`  Base             (0.5-1.9) : ${bar(Number(baseWeight), total)} ${baseWeight} (${pct(Number(baseWeight), total)})`);
  console.log(`  Baixa relevancia (< 0.5)   : ${bar(Number(lowWeight), total)} ${lowWeight} (${pct(Number(lowWeight), total)})`);

  if (topCards.length > 0) {
    console.log("\n  TOP 5 CARTAS POR PESO APRENDIDO:");
    console.log("  " + "─".repeat(50));
    topCards.forEach((c: any, i: number) => {
      const matches = c.winCount + c.lossCount;
      const winRate = matches > 0
        ? ((c.winCount / matches) * 100).toFixed(1) + "% wr"
        : "sem historico";
      console.log(
        `  ${i + 1}. ${c.cardName.padEnd(30)} peso: ${c.weight.toFixed(3).padStart(7)} | ${winRate}`
      );
    });
    console.log("  " + "─".repeat(50));
  }

  console.log("\n  FONTES DE APRENDIZADO ACUMULADAS NO BANCO:");
  console.log("    [F] forge_reality   — partidas reais simuladas via Forge engine");
  console.log("    [S] self_play       — simulacoes internas do loop genetico");
  console.log("    [C] commander_train — treinamento especializado Commander EDH");
  console.log("    [U] user_generation — interacoes do usuario no front-end");
  console.log("    [R] rl_policy       — retroalimentacao do algoritmo RL REINFORCE");
  console.log("\n  TODOS OS DADOS ACIMA SERAO UTILIZADOS NO TREINAMENTO.");
  console.log("═".repeat(52) + "\n");
}

async function launchMasterTraining() {
  const startTotal = Date.now();

  // ── Banner principal ──────────────────────────────────────────────────────
  console.log("═".repeat(52));
  console.log("  TREINAMENTO GLOBAL DA IA (MTG Brain)");
  console.log(`  Inicio: ${timestamp()}`);
  console.log("═".repeat(52));

  // ── 1. Banner de inicialização do Forge ───────────────────────────────────
  printForgeStartupBanner();

  const db = await getDb();
  if (!db) {
    console.error("  [ERRO] Nao foi possivel conectar ao banco. Abortando.");
    closeDb().then(() => process.exit(1)).catch(() => process.exit(1));
    return;
  }

  // ── 2. Status de conexão do Forge e dados forge_reality no banco ──────────
  await printForgeConnectionStatus();

  // ── 3. Regras MTG que o Forge está ensinando ao modelo ────────────────────
  printForgeRulesLearning();

  // ── 4. Status completo do banco de inteligência ───────────────────────────
  await reportBrainDataStatus(db);

  // ── 4b. Escopo do pool de treinamento (Arena vs full catalog) ─────────────
  // O env var TRAINING_POOL_ARENA_ONLY=1 restringe os trainers ao subset
  // do MTG Arena (~3k Standard, ~12k Pioneer/Historic) em vez do catálogo
  // completo (~35k paper). Como `fullBrainTraining` faz spawn dos trainers
  // como subprocessos, o env var é herdado automaticamente — não precisa
  // plumbing CLI. Aqui só reportamos o estado pra o usuário ver no banner.
  const arenaOnly = isArenaOnlyTraining();
  const [{ value: arenaCount }] = await db
    .select({ value: count() })
    .from(cardsTable)
    .where(eq(cardsTable.isArena, 1));
  const [{ value: totalCardCount }] = await db
    .select({ value: count() })
    .from(cardsTable);

  console.log("\n" + "═".repeat(52));
  console.log("  POOL DE TREINAMENTO");
  console.log("═".repeat(52));
  console.log(`  Modo                : ${describeTrainingPool()}`);
  console.log(`  Cartas Arena no DB  : ${arenaCount} (${pct(Number(arenaCount), Number(totalCardCount))})`);
  console.log(`  Cartas totais no DB : ${totalCardCount}`);
  if (arenaOnly && Number(arenaCount) === 0) {
    console.log("");
    console.log("  [AVISO] TRAINING_POOL_ARENA_ONLY=1 mas nenhuma carta tem is_arena=1.");
    console.log("           Rode `npm run db:repair-arena -- --apply` antes do treino,");
    console.log("           senão o pool ficará vazio e os decks não serão gerados.");
  }
  console.log("═".repeat(52) + "\n");

  const [{ value: initialCount }] = await db
    .select({ value: count() })
    .from(cardLearning);

  const runScript = (name: string, path: string): Promise<number> => {
    return new Promise((resolve) => {
      divider(`Modulo: ${name}`);
      console.log(`  Script : npx tsx ${path}`);
      console.log(`  Forge  : ativo — regras MTG aplicadas em cada partida`);
      console.log(`  Status : executando...\n`);

      const child = spawn("npx", ["tsx", path], {
        shell: true,
        stdio: "inherit",
      });

      const tStart = Date.now();

      let lastHeartbeat = Date.now();
      const heartbeat = setInterval(() => {
        const now = Date.now();
        if (now - lastHeartbeat < 15_000) return;
        lastHeartbeat = now;

        const elapsedSec = ((now - tStart) / 1000).toFixed(0);
        const pid = child.pid ?? 'n/a';
        console.log(`[Orchestrator] ${name} ainda executando... pid=${pid} | +${elapsedSec}s | ${timestamp()}`);
      }, 1000);
      child.on("close", (code) => {
        clearInterval(heartbeat);
        const dur = ((Date.now() - tStart) / 1000).toFixed(1);
        if (code === 0) {
          console.log(`\n  [OK] Modulo "${name}" concluido em ${dur}s`);
          console.log(`  [Forge] Dados de partidas gravados em forge_reality.`);
        } else {
          console.warn(`\n  [AVISO] Modulo "${name}" terminou com codigo ${code} (${dur}s)`);
        }
        resolve(code ?? 1);
      });
    });
  };

  // ── 5. Commander Intelligence ─────────────────────────────────────────────
  await runScript("Commander Intelligence (Forge)", "server/scripts/trainCommander.ts");

  // ── 6. Archetype Continuous Training ─────────────────────────────────────
  await runScript("Archetype Self-Play (Forge)", "server/scripts/continuousTraining.ts");

  // ── 7. Resultado Final ────────────────────────────────────────────────────
  const [{ value: finalCount }] = await db
    .select({ value: count() })
    .from(cardLearning);

  const totalDur = ((Date.now() - startTotal) / 1000).toFixed(1);

  console.log("\n" + "═".repeat(52));
  console.log("  TREINAMENTO CONCLUIDO");
  console.log("═".repeat(52));
  console.log(`  Duracao total           : ${totalDur}s`);
  console.log(`  Cartas antes do treino  : ${initialCount}`);
  console.log(`  Cartas apos o treino    : ${finalCount}`);
  console.log(`  Novas entradas criadas  : ${Number(finalCount) - Number(initialCount)}`);
  console.log(`  Motor de regras         : Forge (forge_reality)`);
  console.log(`  Fim: ${timestamp()}`);
  console.log("═".repeat(52) + "\n");

  closeDb().then(() => process.exit(0)).catch(() => process.exit(0));
}

launchMasterTraining().catch((e) => {
  console.error("[fullBrainTraining] Erro fatal:", e?.message);
  closeDb().then(() => process.exit(1)).catch(() => process.exit(1));
});
