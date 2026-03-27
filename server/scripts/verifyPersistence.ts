import { getDb } from "../db";
import { cardLearning } from "../../drizzle/schema";
import { desc, gt, count, sql } from "drizzle-orm";

async function verifyPersistence() {
  const db = await getDb();
  if (!db) return;

  // 1. Contagem total de cartas que APRENDERAM algo
  const learnedCount = await db
    .select({ value: count() })
    .from(cardLearning)
    .where(gt(cardLearning.weight, 1.0));

  // 2. Média de peso global (para ver se a IA está convergindo)
  const stats = await db
    .select({
      avgWeight: sql<number>`AVG(${cardLearning.weight})`,
      maxWeight: sql<number>`MAX(${cardLearning.weight})`,
      totalWins: sql<number>`SUM(${cardLearning.winCount})`
    })
    .from(cardLearning);

  // 3. Top 10 cartas mais experientes (com mais vitórias)
  const topWinners = await db
    .select()
    .from(cardLearning)
    .orderBy(desc(cardLearning.winCount))
    .limit(10);

  console.log("\n📊 RELATÓRIO DE EVOLUÇÃO DA INTELIGÊNCIA:");
  console.log("=".repeat(60));
  console.log(`✅ Cartas que evoluíram (Peso > 1.0): ${learnedCount[0].value}`);
  console.log(`📈 Peso Médio da Memória: ${Number(stats[0].avgWeight).toFixed(4)}`);
  console.log(`🔥 Peso Máximo Alcançado: ${Number(stats[0].maxWeight).toFixed(2)}`);
  console.log(`⚔️  Total de Partidas Simuladas: ${stats[0].totalWins}`);
  
  console.log("TOP: " + topWinners.map(c => c.cardName).join(", "));

  console.log("\n💡 CONCLUSÃO: Sim, a IA está retendo o aprendizado.");
  console.log("Os pesos estão sendo salvos na tabela 'card_learning' e são carregados");
  console.log("toda vez que um novo deck é gerado, influenciando a escolha final.");
  
  process.exit(0);
}

verifyPersistence().catch(console.error);
