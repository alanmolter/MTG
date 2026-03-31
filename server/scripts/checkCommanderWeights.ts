import { getDb, closeDb } from "../db";
import { cardLearning, cards } from "../../drizzle/schema";
import { desc, eq, and, sql } from "drizzle-orm";

async function check() {
  const db = await getDb();
  if (!db) return;

  // Buscar mais resultados para compensar duplicatas de cartas double-faced
  const rawCommanders = await db
    .select({
      name: cardLearning.cardName,
      weight: cardLearning.weight,
      type: cards.type,
      colors: cards.colors,
    })
    .from(cardLearning)
    .innerJoin(cards, eq(cardLearning.cardName, cards.name))
    .where(sql`${cards.type} ILIKE '%Legendary%' AND ${cards.type} ILIKE '%Creature%'`)
    .orderBy(desc(cardLearning.weight))
    .limit(50);

  // Deduplicar cartas double-faced (com //) — manter apenas a de maior peso
  const seen = new Set<string>();
  const topCommanders: typeof rawCommanders = [];

  for (const c of rawCommanders) {
    // Normalizar nome: usar apenas a parte antes do " // " para deduplicacao
    const baseName = c.name.includes(" // ") ? c.name.split(" // ")[0].trim() : c.name.trim();

    if (seen.has(baseName.toLowerCase())) continue;
    seen.add(baseName.toLowerCase());

    topCommanders.push(c);
    if (topCommanders.length >= 10) break;
  }

  console.log("\n TOP 10 COMANDANTES APRENDIDOS PELO CEREBRO:");
  console.log("=".repeat(70));
  topCommanders.forEach((c, i) => {
    const displayName = c.name.length > 35 ? c.name.substring(0, 32) + "..." : c.name;
    const colors = c.colors || "C";
    console.log(
      `${String(i + 1).padStart(2)}. ${displayName.padEnd(36)} | ${colors.padEnd(5)} | Peso: ${c.weight.toFixed(2)}`
    );
  });
  console.log("=".repeat(70));

  closeDb()
    .then(() => process.exit(0))
    .catch(() => process.exit(0));
}

check().catch(console.error);
