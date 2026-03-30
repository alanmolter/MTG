import { getDb, closeDb } from "../db";
import { cardLearning, cards } from "../../drizzle/schema";
import { desc, eq, and, sql } from "drizzle-orm";

async function check() {
  const db = await getDb();
  if (!db) return;

  const topCommanders = await db
    .select({
        name: cardLearning.cardName,
        weight: cardLearning.weight,
        type: cards.type
    })
    .from(cardLearning)
    .innerJoin(cards, eq(cardLearning.cardName, cards.name))
    .where(sql`${cards.type} ILIKE '%Legendary%' AND ${cards.type} ILIKE '%Creature%'`)
    .orderBy(desc(cardLearning.weight))
    .limit(10);

  console.log("\n🔥 TOP 10 COMANDANTES APRENDIDOS PELO CÉREBRO:");
  console.log("=".repeat(60));
  topCommanders.forEach((c, i) => {
    console.log(`${i+1}. ${c.name.padEnd(25)} | Peso: ${c.weight.toFixed(2)}`);
  });
  
  closeDb().then(() => process.exit(0)).catch(() => process.exit(0));
}

check().catch(console.error);
