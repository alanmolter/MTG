import { getDb } from "../db";
import { cardLearning } from "../../drizzle/schema";
import { desc } from "drizzle-orm";

async function check() {
  const db = await getDb();
  if (!db) return;

  const topCards = await db
    .select()
    .from(cardLearning)
    .orderBy(desc(cardLearning.weight))
    .limit(10);

  console.log("\n🔥 TOP 10 CARTAS APRENDIDAS (Mais Fortes):");
  console.log("=".repeat(50));
  topCards.forEach((c, i) => {
    console.log(`${i+1}. ${c.cardName.padEnd(25)} | Peso: ${c.weight.toFixed(2)} | Wins: ${c.winCount}`);
  });
  
  const total = await db.select().from(cardLearning);
  console.log(`\n🧠 Total de cartas no cérebro: ${total.length}`);
  process.exit(0);
}

check().catch(console.error);
