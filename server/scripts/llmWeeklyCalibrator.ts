/**
 * llmWeeklyCalibrator.ts
 *
 * Usa o LLM (claude-haiku — barato) como AVALIADOR EXTERNO para quebrar
 * o loop circular do Self-Play e recalibrar os pesos do card_learning.
 *
 * Custo estimado por run: ~$0.30–0.50 (Haiku a $0.80/MTok input)
 * Frequência recomendada: 1x por semana (run-all.bat não chama isso)
 *
 * Como executar manualmente:
 *   npx tsx server/scripts/llmWeeklyCalibrator.ts
 *   npx tsx server/scripts/llmWeeklyCalibrator.ts --top=100 --archetypes=aggro,control
 *
 * O que faz:
 *   1. Pega os top-N decks gerados pela sua stack atual (por peso aprendido)
 *   2. Envia ao LLM em batches de 10 decks por chamada (prompt pequeno = barato)
 *   3. LLM avalia sinergia e retorna score 0-100 por carta
 *   4. Diferença entre score LLM e peso atual → delta de correção no card_learning
 *   5. Cartas que o LLM considera sub-avaliadas sobem; super-avaliadas descem
 *
 * Requer: ANTHROPIC_API_KEY no .env
 */

import "dotenv/config";
import { desc, inArray } from "drizzle-orm";
import { cardLearning } from "../../drizzle/schema";
import { closeDb, getDb } from "../db";
import { getCardLearningQueue } from "../services/cardLearningQueue";

// ── Argumentos CLI ────────────────────────────────────────────────
const args = process.argv.slice(2);
const getArg = (name: string, def: string) =>
  args.find((a) => a.startsWith(`--${name}=`))?.split("=")[1] ?? def;

const TOP_N      = parseInt(getArg("top", "80"));
const ARCHETYPES = getArg("archetypes", "aggro,control,midrange,combo,ramp").split(",");
const BATCH_SIZE = 15; // cartas por chamada LLM (barato e suficiente)
const MODEL      = "claude-haiku-4-5-20251001"; // ~50x mais barato que Opus

// ── Tipos ─────────────────────────────────────────────────────────
interface CardWeight {
  cardName: string;
  weight: number;
}

interface LLMCardScore {
  name: string;
  score: number;   // 0-100: quão boa é a carta no contexto do arquétipo
  reason: string;  // justificativa em 1 frase
}

interface LLMBatchResult {
  cards: LLMCardScore[];
}

// ── Chamada à API da Anthropic (fetch nativo Node 22+) ────────────
async function callHaiku(prompt: string): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY não configurada");

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1024,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Haiku API error ${response.status}: ${err.slice(0, 200)}`);
  }

  const data = (await response.json()) as {
    content: Array<{ type: string; text: string }>;
  };

  return data.content[0]?.type === "text" ? data.content[0].text : "";
}

// ── Prompt compacto (barato) para avaliar batch de cartas ─────────
function buildBatchPrompt(
  cards: CardWeight[],
  archetype: string
): string {
  const cardList = cards
    .map((c) => `${c.cardName} (peso atual: ${c.weight.toFixed(1)})`)
    .join("\n");

  return `Você é especialista em Magic: The Gathering competitivo.

ARQUÉTIPO: ${archetype}

Avalie cada carta abaixo numa escala 0-100 considerando sua utilidade no arquétipo ${archetype}:
- 90-100: staple, carta essencial do arquétipo
- 70-89 : boa carta, frequentemente jogada
- 50-69 : situacional, mas relevante
- 30-49 : fraca neste arquétipo
- 0-29  : inútil ou prejudicial neste arquétipo

CARTAS:
${cardList}

RESPONDA APENAS em JSON válido:
{ "cards": [ { "name": "Nome Exato", "score": 85, "reason": "motivo em 1 frase" } ] }`;
}

// ── Parsear resposta do LLM ───────────────────────────────────────
function parseLLMResponse(raw: string): LLMCardScore[] {
  try {
    const clean = raw.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
    const result = JSON.parse(clean) as LLMBatchResult;
    return result.cards ?? [];
  } catch {
    return [];
  }
}

// ── Converter score LLM (0-100) para delta de peso ────────────────
// Score 50 = neutro (sem mudança)
// Score 90 = carta muito boa → delta +0.15
// Score 20 = carta ruim → delta -0.10
function scoreToDelta(llmScore: number, currentWeight: number): number {
  const normalized = (llmScore - 50) / 50; // -1.0 a +1.0
  const maxDelta = normalized > 0 ? 0.15 : 0.10;
  return normalized * maxDelta;
}

// ── Função principal ──────────────────────────────────────────────
export async function runLLMWeeklyCalibration(): Promise<{
  cardsEvaluated: number;
  cardsAdjusted: number;
  totalCalls: number;
  estimatedCostUsd: number;
}> {
  const db = await getDb();
  if (!db) throw new Error("[LLMCalibrator] Banco indisponível");

  console.log("\n════════════════════════════════════════════════════════");
  console.log("  CALIBRADOR SEMANAL LLM — claude-haiku (barato)");
  console.log("════════════════════════════════════════════════════════");
  console.log(`  Modelo  : ${MODEL}`);
  console.log(`  Top-N   : ${TOP_N} cartas por arquétipo`);
  console.log(`  Batch   : ${BATCH_SIZE} cartas por chamada`);
  console.log(`  Arqs    : ${ARCHETYPES.join(", ")}`);
  console.log("────────────────────────────────────────────────────────");

  // ── 1. Carregar top-N cartas por peso aprendido ───────────────
  const topCards = await db
    .select({ cardName: cardLearning.cardName, weight: cardLearning.weight })
    .from(cardLearning)
    .orderBy(desc(cardLearning.weight))
    .limit(TOP_N);

  if (topCards.length === 0) {
    console.log("  Nenhuma carta no card_learning — rode o Self-Play primeiro");
    return { cardsEvaluated: 0, cardsAdjusted: 0, totalCalls: 0, estimatedCostUsd: 0 };
  }

  console.log(`  Cartas carregadas: ${topCards.length}`);

  const queue = getCardLearningQueue();
  let totalCalls = 0;
  let totalInputTokens = 0;
  let totalAdjusted = 0;

  // ── 2. Para cada arquétipo, avaliar em batches ────────────────
  for (const archetype of ARCHETYPES) {
    console.log(`\n  [${archetype.toUpperCase()}] Avaliando ${topCards.length} cartas...`);

    for (let i = 0; i < topCards.length; i += BATCH_SIZE) {
      const batch = topCards.slice(i, i + BATCH_SIZE).map((c) => ({
        cardName: c.cardName,
        weight: c.weight as number,
      }));

      const prompt = buildBatchPrompt(batch, archetype);
      // Estimar tokens: ~4 chars por token
      totalInputTokens += Math.ceil(prompt.length / 4);

      try {
        const raw = await callHaiku(prompt);
        totalCalls++;

        const scores = parseLLMResponse(raw);

        // ── 3. Calcular deltas e enfileirar ──────────────────
        for (const scored of scores) {
          const current = batch.find(
            (c) => c.cardName.toLowerCase() === scored.name.toLowerCase()
          );
          if (!current) continue;

          const delta = scoreToDelta(scored.score, current.weight);

          // Só ajustar se o delta for significativo (>0.02)
          if (Math.abs(delta) > 0.02) {
            await queue.enqueue({
              cardName: current.cardName,
              delta,
              source: "unified_learning",
            });
            totalAdjusted++;

            const dir = delta > 0 ? "↑" : "↓";
            process.stdout.write(
              `\r  ${dir} ${current.cardName.slice(0, 28).padEnd(28)} LLM:${scored.score} Δ:${delta.toFixed(3)}`.padEnd(70)
            );
          }
        }

        // Delay entre chamadas para respeitar rate limit
        await new Promise((r) => setTimeout(r, 300));

      } catch (err: any) {
        console.warn(`\n  [AVISO] Batch ${i / BATCH_SIZE + 1} falhou: ${err?.message}`);
      }
    }
  }

  // ── 4. Flush de todos os ajustes ─────────────────────────────
  process.stdout.write("\n");
  console.log("  Aplicando ajustes ao banco...");
  await queue.flush();
  const stats = queue.getAndResetStats();

  // Custo estimado: $0.80/MTok input + $4.00/MTok output (Haiku)
  const estimatedCostUsd =
    (totalInputTokens / 1_000_000) * 0.80 +
    (totalCalls * 300 / 1_000_000) * 4.00; // ~300 tokens output por call

  console.log("\n════════════════════════════════════════════════════════");
  console.log("  CALIBRAÇÃO CONCLUÍDA");
  console.log("════════════════════════════════════════════════════════");
  console.log(`  Cartas avaliadas : ${topCards.length * ARCHETYPES.length}`);
  console.log(`  Ajustes aplicados: ${stats.totalUpdated}`);
  console.log(`  Chamadas LLM     : ${totalCalls}`);
  console.log(`  Custo estimado   : ~$${estimatedCostUsd.toFixed(3)} USD`);
  console.log(`  Saturadas        : ${stats.totalSaturated}`);
  console.log("════════════════════════════════════════════════════════\n");

  return {
    cardsEvaluated: topCards.length * ARCHETYPES.length,
    cardsAdjusted: stats.totalUpdated,
    totalCalls,
    estimatedCostUsd,
  };
}

// ── Execução standalone ───────────────────────────────────────────
if (import.meta.url === `file://${process.argv[1]}`) {
  runLLMWeeklyCalibration()
    .catch((e) => {
      console.error("[LLMCalibrator] Erro fatal:", e?.message);
      process.exit(1);
    })
    .finally(() => {
      closeDb().then(() => process.exit(0)).catch(() => process.exit(1));
    });
}
