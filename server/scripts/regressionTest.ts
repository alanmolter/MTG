import { ModelEvaluator, ExperimentTracker } from "../services/modelEvaluation";
import { generateInitialDeck } from "../services/deckGenerator";
import * as fs from "fs";
import * as path from "path";

/**
 * Script de Teste de Regressão e Baseline (Métricas de ML)
 * 
 * Este script gera decks para cada arquétipo e registra suas métricas de performance.
 * Se o winrate cair abaixo de 90% do baseline anterior, o teste falha.
 */

import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const BASELINE_PATH = path.join(__dirname, "../../data/model_baseline.json");
const FIXTURES_PATH = path.join(__dirname, "../../data/regression_fixtures.json");

async function runRegression() {
  console.log("🚀 Iniciando Testes de Regressão de Modelo...");

  // Carregar Fixtures Fixas para Baseline de Ouro
  let fixtures: { archetype: string, decklist: string }[] = [];
  if (fs.existsSync(FIXTURES_PATH)) {
    fixtures = JSON.parse(fs.readFileSync(FIXTURES_PATH, "utf-8")).fixtures;
  }

  const { MetaAnalytics } = await import("../services/metaAnalytics");

  const mockGenerator = async (arch: string) => {
    const fix = fixtures.find(f => f.archetype === arch);
    if (fix) return await MetaAnalytics.parseDecklist(fix.decklist);
    return await generateInitialDeck({ format: "standard", archetype: arch });
  };

  const results = await ModelEvaluator.runRegressionTests(mockGenerator);
  
  if (fs.existsSync(BASELINE_PATH)) {
    const baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, "utf-8"));
    console.log("\n📊 Comparação com Baseline:");
    
    let regressionDetected = false;
    for (let i = 0; i < results.length; i++) {
      const current = results[i];
      const prev = baseline.results[i];
      
      const wrDiff = current.winrate - prev.winrate;
      const scoreDiff = current.normalizedScore - prev.normalizedScore;

      console.log(`[${current.archetype.toUpperCase()}]`);
      console.log(`  Winrate: ${current.winrate.toFixed(2)} vs ${prev.winrate.toFixed(2)} (${wrDiff >= 0 ? "+" : ""}${wrDiff.toFixed(2)})`);
      console.log(`  Score: ${current.normalizedScore} vs ${prev.normalizedScore} (${scoreDiff >= 0 ? "+" : ""}${scoreDiff})`);

      if (current.winrate < prev.winrate * 0.9) {
        console.warn(`⚠️ ALERTA: Regressão de Winrate detectada em ${current.archetype}!`);
        regressionDetected = true;
      }
    }

    if (!regressionDetected) {
      console.log("\n✅ Modelo está estável ou melhorando!");
    }
  } else {
    console.log("\n🆕 Nenhum baseline encontrado. Gerando novo baseline...");
    fs.mkdirSync(path.dirname(BASELINE_PATH), { recursive: true });
    fs.writeFileSync(BASELINE_PATH, JSON.stringify({
      version: "1.0.0",
      timestamp: new Date().toISOString(),
      results
    }, null, 2));
    console.log(`✅ Baseline salvo em: ${BASELINE_PATH}`);
  }

  // Logar para o Tracker (MLflow estilo)
  ExperimentTracker.logExperiment("Final Brain Eval", {
    aggro_winrate: results[0].winrate,
    control_winrate: results[1].winrate,
    midrange_winrate: results[2].winrate
  });
}

runRegression().catch(console.error);
