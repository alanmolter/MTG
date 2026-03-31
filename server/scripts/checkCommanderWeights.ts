import { getDb, closeDb } from "../db";
import { cardLearning, cards } from "../../drizzle/schema";
import { desc, eq, sql } from "drizzle-orm";

async function check() {
  const db = await getDb();
  if (!db) return;

  // Buscar 100 resultados para compensar duplicatas de cartas double-faced
  // e múltiplas versões do mesmo personagem (ex: Aang tem 5+ versões)
  const rawCommanders = await db
    .select({
      name: cardLearning.cardName,
      weight: cardLearning.weight,
      winCount: cardLearning.winCount,
      lossCount: cardLearning.lossCount,
      type: cards.type,
      colors: cards.colors,
    })
    .from(cardLearning)
    .innerJoin(cards, eq(cardLearning.cardName, cards.name))
    .where(sql`${cards.type} ILIKE '%Legendary%' AND ${cards.type} ILIKE '%Creature%'`)
    .orderBy(desc(cardLearning.weight))
    .limit(100);

  // Deduplicação em dois níveis:
  //   1. Cartas double-faced (com " // "): usar parte antes do " // "
  //   2. Mesmo personagem (múltiplas versões): usar parte antes da primeira vírgula
  //      Mantém a versão com MAIS PARTIDAS REAIS para cada personagem (não apenas maior peso).
  //      Isso evita mostrar cartas com peso inflado por decay mas sem partidas reais.

  // Primeiro passo: agrupar por personagem e escolher a melhor versão
  const personagemMap = new Map<string, typeof rawCommanders[0]>();

  for (const c of rawCommanders) {
    const singleFaceName = c.name.includes(" // ")
      ? c.name.split(" // ")[0].trim()
      : c.name.trim();

    const personagem = singleFaceName.includes(",")
      ? singleFaceName.split(",")[0].trim().toLowerCase()
      : singleFaceName.toLowerCase();

    const existing = personagemMap.get(personagem);
    if (!existing) {
      personagemMap.set(personagem, c);
    } else {
      // Preferir a versão com mais partidas reais (winCount + lossCount)
      const existingTotal = (existing.winCount ?? 0) + (existing.lossCount ?? 0);
      const newTotal = (c.winCount ?? 0) + (c.lossCount ?? 0);
      if (newTotal > existingTotal) {
        personagemMap.set(personagem, c);
      }
    }
  }

  // Segundo passo: ordenar por (tem partidas reais DESC, peso DESC) e pegar top 10
  const topCommanders = Array.from(personagemMap.values())
    .sort((a, b) => {
      const aTotal = (a.winCount ?? 0) + (a.lossCount ?? 0);
      const bTotal = (b.winCount ?? 0) + (b.lossCount ?? 0);
      // Primeiro: cartas com partidas reais
      if (aTotal > 0 && bTotal === 0) return -1;
      if (bTotal > 0 && aTotal === 0) return 1;
      // Depois: por peso
      return b.weight - a.weight;
    })
    .slice(0, 10);

  const seenPersonagem = personagemMap;

  const total = rawCommanders.length;
  const uniquePersonagens = seenPersonagem.size;

  console.log("\n TOP 10 COMANDANTES APRENDIDOS PELO CEREBRO:");
  console.log("=".repeat(70));
  topCommanders.forEach((c, i) => {
    // Exibir nome limpo (sem face B)
    const cleanName = c.name.includes(" // ") ? c.name.split(" // ")[0].trim() : c.name;
    const displayName = cleanName.length > 35 ? cleanName.substring(0, 32) + "..." : cleanName;
    const colors = c.colors || "C";
    const total = (c.winCount ?? 0) + (c.lossCount ?? 0);
    const wr = total > 0 ? (((c.winCount ?? 0) / total) * 100).toFixed(0) + "% wr" : "sem partidas";
    console.log(
      `${String(i + 1).padStart(2)}. ${displayName.padEnd(36)} | ${colors.padEnd(5)} | Peso: ${c.weight.toFixed(2)} | ${wr}`
    );
  });
  console.log("=".repeat(70));
  console.log(`   (${total} lendarios no banco, ${uniquePersonagens} personagens unicos mostrados)`);

  closeDb()
    .then(() => process.exit(0))
    .catch(() => process.exit(0));
}

check().catch(console.error);
