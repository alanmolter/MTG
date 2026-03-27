import { getDb } from "../db";
import { cards } from "../../drizzle/schema";
import { count } from "drizzle-orm";

async function check() {
  const db = await getDb();
  if (!db) {
    console.error("❌ Não foi possível conectar ao banco.");
    process.exit(1);
  }
  const result = await db.select({ value: count() }).from(cards);
  console.log(`📡 Total de cartas no banco: ${result[0].value}`);
  process.exit(0);
}

check().catch(console.error);
