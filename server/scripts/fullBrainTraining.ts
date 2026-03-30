import { getDb } from "../db";
import { cardLearning } from "../../drizzle/schema";
import { count } from "drizzle-orm";
import { spawn } from "child_process";

/**
 * MASTER BRAIN TRAINING SCRIPT
 * Executa Commander Intelligence + Archetype Continuous Training em sequencia.
 */

function divider(label: string) {
  const line = "-".repeat(52);
  console.log(`\n${line}`);
  console.log(`  ${label}`);
  console.log(line);
}

function timestamp(): string {
  return new Date().toLocaleTimeString("pt-BR");
}

async function launchMasterTraining() {
  const startTotal = Date.now();
  console.log("=".repeat(52));
  console.log("  TREINAMENTO GLOBAL DA IA (MTG Brain)");
  console.log(`  Inicio: ${timestamp()}`);
  console.log("=".repeat(52));

  const db = await getDb();
  if (!db) {
    console.error("  [ERRO] Nao foi possivel conectar ao banco. Abortando.");
    process.exit(1);
  }

  const [{ value: initialCount }] = await db.select({ value: count() }).from(cardLearning);
  console.log(`\n  Cartas no banco de inteligencia: ${initialCount}`);

  const runScript = (name: string, path: string): Promise<number> => {
    return new Promise((resolve) => {
      divider(`Modulo: ${name}`);
      console.log(`  Script : npx tsx ${path}`);
      console.log(`  Status : executando...\n`);

      const child = spawn("npx", ["tsx", path], {
        shell: true,
        stdio: "inherit",
      });

      const tStart = Date.now();
      child.on("close", (code) => {
        const dur = ((Date.now() - tStart) / 1000).toFixed(1);
        if (code === 0) {
          console.log(`\n  [OK] Modulo "${name}" concluido em ${dur}s`);
        } else {
          console.warn(`\n  [AVISO] Modulo "${name}" terminou com codigo ${code} (${dur}s)`);
        }
        resolve(code ?? 1);
      });
    });
  };

  // 1. Commander Intelligence
  await runScript("Commander Intelligence", "server/scripts/trainCommander.ts");

  // 2. Archetype Continuous Training
  await runScript("Archetype Continuous Training", "server/scripts/continuousTraining.ts");

  // Resultado Final
  const [{ value: finalCount }] = await db.select({ value: count() }).from(cardLearning);
  const totalDur = ((Date.now() - startTotal) / 1000).toFixed(1);

  console.log("\n" + "=".repeat(52));
  console.log("  TREINAMENTO CONCLUIDO");
  console.log(`  Duracao total           : ${totalDur}s`);
  console.log(`  Cartas antes do treino  : ${initialCount}`);
  console.log(`  Cartas apos o treino    : ${finalCount}`);
  console.log(`  Novas entradas criadas  : ${Number(finalCount) - Number(initialCount)}`);
  console.log(`  Fim: ${timestamp()}`);
  console.log("=".repeat(52) + "\n");

  process.exit(0);
}

launchMasterTraining().catch((e) => {
  console.error("[fullBrainTraining] Erro fatal:", e?.message);
  process.exit(1);
});
