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
  //      Ex: "Aang, at the Crossroads // Aang, Fully Realized" → "Aang, at the Crossroads"
  //   2. Mesmo personagem (múltiplas versões): usar parte antes da primeira vírgula
  //      Ex: "Aang, at the Crossroads" e "Aang, Swift Savior" → personagem "Aang"
  //      Mantém apenas a versão de maior peso para cada personagem.
  const seenPersonagem = new Set<string>();
  const topCommanders: typeof rawCommanders = [];

  for (const c of rawCommanders) {
    // Nível 1: remover face B de cartas double-faced
    const singleFaceName = c.name.includes(" // ")
      ? c.name.split(" // ")[0].trim()
      : c.name.trim();

    // Nível 2: extrair personagem (parte antes da primeira vírgula)
    // Ex: "Sheoldred, the Apocalypse" → "Sheoldred"
    // Ex: "Aang, at the Crossroads" → "Aang"
    // Ex: "Purphoros, God of the Forge" → "Purphoros"
    const personagem = singleFaceName.includes(",")
      ? singleFaceName.split(",")[0].trim().toLowerCase()
      : singleFaceName.toLowerCase();

    if (seenPersonagem.has(personagem)) continue;
    seenPersonagem.add(personagem);

    topCommanders.push(c);
    if (topCommanders.length >= 10) break;
  }

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
