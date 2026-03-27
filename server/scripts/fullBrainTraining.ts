import { getDb } from "../db";
import { cardLearning } from "../../drizzle/schema";
import { count } from "drizzle-orm";
// @ts-ignore
import { spawn } from "child_process";

/**
 * MASTER BRAIN TRAINING SCRIPT
 * 
 * Este é o comando central para treinar a inteligência do deck builder.
 * Ele executa as simulações de Decks, Comandantes e Self-Play.
 */
async function launchMasterTraining() {
  console.log("\n🚀 [MASTER BRAIN] Iniciando Treinamento Global da IA (MTG Deck Engine)\n");
  console.log("=".repeat(80));
  
  const db = await getDb();
  if (!db) {
    console.error("❌ Erro ao conectar com o banco de dados.");
    return;
  }
  
  const initialCount = await db.select({ value: count() }).from(cardLearning);
  console.log(`📊 Status Inicial: ${initialCount[0].value} cartas no banco de inteligência.`);

  const runScript = (name: string, path: string) => {
    return new Promise((resolve) => {
      console.log(`\n🧠 Iniciando Módulo: ${name}...`);
      const child = spawn("npx", ["tsx", path], { shell: true, stdio: "inherit" });
      child.on("close", (code) => {
        if (code === 0) console.log(`✅ Módulo ${name} concluído.`);
        else console.error(`❌ Módulo ${name} falhou (Código ${code}).`);
        resolve(code);
      });
    });
  };

  // 1. Treinamento de Comandantes (Sinergia de Líderes)
  await runScript("Commander Intelligence", "server/scripts/trainCommander.ts");

  // 2. Treinamento Contínuo de Arquétipos (Self-Play & Estrutura)
  await runScript("Archetype Continuous Training", "server/scripts/continuousTraining.ts");

  // 3. Resultado Final
  const finalCount = await db.select({ value: count() }).from(cardLearning);
  console.log("\n" + "=".repeat(80));
  console.log(`\n🏆 [TREINAMENTO CONCLUÍDO]`);
  console.log(`📈 Inteligência atualizada para ${finalCount[0].value} cartas.`);
  console.log(`💡 A IA agora está mais inteligente em:`);
  console.log(`   - Melhores Comandantes para cada arquétipo`);
  console.log(`   - Sinergias de Sideboard e Main Deck`);
  console.log(`   - Curva de mana mais assertiva baseada em self-play`);
  console.log("\n👉 Utilize o comando 'npm run check:learn' para ver os cards favoritos da IA.");
  
  process.exit(0);
}

launchMasterTraining().catch(console.error);
